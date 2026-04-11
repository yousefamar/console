// ============================================================================
// Claude CLI Session Manager
//
// Spawns `claude` as a child process with --output-format stream-json and
// --input-format stream-json. Reads NDJSON from stdout line-by-line, writes
// NDJSON to stdin. Translates between the Claude CLI protocol and the hub's
// internal event emitter interface.
// ============================================================================

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import type {
  ClaudeStdoutMessage,
  ClaudeStdinMessage,
  ClaudeStdinContentBlock,
  ClaudeContentBlock,
  HubMessage,
  LoggableHubMessage,
  TokenUsage,
  SessionInfo,
} from './protocol.js'
import { parseModelString } from './utils.js'

let sessionCounter = 0

export interface ImageAttachment {
  media_type: string
  data: string  // base64
}

export interface SessionOptions {
  prompt: string
  images?: ImageAttachment[]
  cwd?: string
  resume?: string
  /** If true, resume the session but don't send any initial prompt (used for auto-restore on hub restart) */
  silent?: boolean
  /** If true, fork the resumed session (new session ID, same conversation history) */
  fork?: boolean
  /** Display name for the session (persists across restarts) */
  name?: string
}

export class Session extends EventEmitter {
  readonly id: string
  claudeSessionId?: string
  name?: string
  status: 'running' | 'idle' | 'ended' = 'running'
  readonly createdAt = Date.now()
  readonly initialPrompt: string
  readonly cwd: string
  totalCost = 0
  totalTokens: TokenUsage = { input: 0, output: 0 }
  contextWindow = 200_000

  /** Coalesced message log for replay to late-joining clients */
  readonly messageLog: LoggableHubMessage[] = []

  private process: ChildProcess | null = null
  private stdinReady = false
  /** Accumulator for text_delta coalescing */
  private pendingText = ''
  /** Accumulator for thinking_delta coalescing */
  private pendingThinking = ''

  constructor(options: SessionOptions) {
    super()
    this.id = `session_${++sessionCounter}_${Date.now()}`
    this.initialPrompt = options.prompt
    this.name = options.name
    this.cwd = options.cwd || process.cwd()
    // For resumes (not forks), set claudeSessionId immediately so list_sessions
    // can match before Claude emits the `system` message.
    // Forks get a NEW claudeSessionId from Claude — don't pre-set to avoid
    // manifest dedup collisions with the source session.
    if (options.resume && !options.fork) {
      this.claudeSessionId = options.resume
    }
    // Silent resumes (hub restart restore) start idle — no prompt will be sent
    if (options.silent) {
      this.status = 'idle'
    }
    this.spawn(options)
    // Send the initial prompt via stdin (since we use --input-format stream-json instead of -p)
    // For silent resumes (hub restart restore), skip — Claude resumes idle, waiting for user input
    if (!options.silent) {
      this.sendMessage(options.prompt, options.images)
    }
  }

  private spawn(options: SessionOptions) {
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--permission-prompt-tool', 'stdio',
      '--chrome',
    ]

    if (options.resume) {
      args.push('--resume', options.resume)
    }

    if (options.fork) {
      args.push('--fork-session')
    }

    if (options.name) {
      args.push('--name', options.name)
    }

    const cwd = this.cwd

    this.process = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    this.stdinReady = true

    // Read stdout as NDJSON (one JSON object per line)
    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout })
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        try {
          const msg = JSON.parse(trimmed) as ClaudeStdoutMessage
          this.handleClaudeMessage(msg)
        } catch {
          // Non-JSON output (e.g. debug logs) — emit as status
          if (trimmed.length > 0) {
            this.emitHub({ type: 'status', sessionId: this.id, text: trimmed })
          }
        }
      })
    }

    // Capture stderr for debugging
    if (this.process.stderr) {
      const rl = createInterface({ input: this.process.stderr })
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (trimmed) {
          this.emitHub({ type: 'status', sessionId: this.id, text: trimmed })
        }
      })
    }

    this.process.on('exit', (code) => {
      this.status = 'ended'
      this.stdinReady = false
      this.emitHub({ type: 'session_ended', sessionId: this.id })
      this.emit('exit', code)
    })

    this.process.on('error', (err) => {
      this.emitHub({
        type: 'error',
        sessionId: this.id,
        message: `Process error: ${err.message}`,
      })
    })
  }

  /** Write a JSON message to Claude's stdin */
  writeStdin(msg: ClaudeStdinMessage) {
    if (!this.process?.stdin || !this.stdinReady) {
      this.emitHub({
        type: 'error',
        sessionId: this.id,
        message: 'Session stdin not available',
      })
      return
    }
    const json = JSON.stringify(msg)
    this.process.stdin.write(json + '\n')
  }

  /** Send a follow-up user prompt, optionally with images */
  sendMessage(content: string, images?: ImageAttachment[]) {
    this.status = 'running'
    if (images && images.length > 0) {
      const blocks: ClaudeStdinContentBlock[] = images.map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.media_type, data: img.data },
      }))
      blocks.push({ type: 'text', text: content })
      this.writeStdin({
        type: 'user',
        message: { role: 'user', content: blocks },
      })
    } else {
      this.writeStdin({
        type: 'user',
        message: { role: 'user', content },
      })
    }
  }

  /** Approve a tool use request */
  approveTool(requestId: string, modifiedInput?: Record<string, unknown>) {
    const response: Record<string, unknown> = {
      type: 'control_response',
      response: {
        request_id: requestId,
        response: {
          behavior: 'allow',
          updatedInput: modifiedInput ?? {},
        },
      },
    }
    this.writeStdin(response as any)
  }

  /** Deny a tool use request */
  denyTool(requestId: string, reason?: string) {
    const response: Record<string, unknown> = {
      type: 'control_response',
      response: {
        request_id: requestId,
        response: {
          behavior: 'deny',
          ...(reason ? { message: reason } : {}),
        },
      },
    }
    this.writeStdin(response as any)
  }

  /** Interrupt the current operation (SIGINT) */
  interrupt() {
    if (this.process && this.status === 'running') {
      this.process.kill('SIGINT')
    }
  }

  /** Kill the session */
  kill() {
    if (this.process) {
      this.process.kill('SIGTERM')
      this.status = 'ended'
      this.stdinReady = false
    }
  }

  private gitBranch?: string
  private gitDirty?: boolean
  private gitStats?: { added: number; deleted: number }
  private gitCheckedAt = 0

  private checkGit(): void {
    // Cache for 10 seconds
    if (Date.now() - this.gitCheckedAt < 10_000) return
    this.gitCheckedAt = Date.now()
    try {
      this.gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000,
      }).toString().trim()
      const status = execSync('git status --porcelain', {
        cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000,
      }).toString().trim()
      this.gitDirty = status.length > 0
      // Get line-level diff stats: staged + unstaged + count untracked files
      if (this.gitDirty) {
        let added = 0, deleted = 0
        // Staged changes
        const staged = execSync('git diff --cached --numstat', {
          cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000,
        }).toString().trim()
        for (const line of staged.split('\n')) {
          const [a, d] = line.split('\t')
          if (a && d && a !== '-') { added += parseInt(a, 10); deleted += parseInt(d, 10) }
        }
        // Unstaged changes to tracked files
        const unstaged = execSync('git diff --numstat', {
          cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000,
        }).toString().trim()
        for (const line of unstaged.split('\n')) {
          const [a, d] = line.split('\t')
          if (a && d && a !== '-') { added += parseInt(a, 10); deleted += parseInt(d, 10) }
        }
        // Count untracked files as 1 added line each
        for (const line of status.split('\n')) {
          if (line.startsWith('?? ')) added += 1
        }
        this.gitStats = { added, deleted }
      } else {
        this.gitStats = undefined
      }
    } catch {
      this.gitBranch = undefined
      this.gitDirty = undefined
      this.gitStats = undefined
    }
  }

  /** Get session info for listing */
  getInfo(): SessionInfo {
    this.checkGit()
    return {
      id: this.id,
      claudeSessionId: this.claudeSessionId,
      name: this.name,
      status: this.status,
      createdAt: this.createdAt,
      prompt: this.initialPrompt,
      cwd: this.cwd,
      totalCost: this.totalCost,
      totalTokens: { ...this.totalTokens },
      messageLogLength: this.messageLog.length,
      gitBranch: this.gitBranch,
      gitDirty: this.gitDirty,
      gitStats: this.gitStats,
    }
  }

  // --------------------------------------------------------------------------
  // Claude message handling
  // --------------------------------------------------------------------------

  private handleClaudeMessage(msg: ClaudeStdoutMessage) {
    switch (msg.type) {
      case 'system': {
        this.claudeSessionId = msg.session_id
        const { displayName, contextWindow } = parseModelString(msg.model)
        this.contextWindow = contextWindow
        this.emitHub({
          type: 'session_init',
          sessionId: this.id,
          claudeSessionId: msg.session_id,
          model: displayName,
          slashCommands: msg.slash_commands ?? [],
          contextWindow,
          permissionMode: msg.permissionMode,
        })
        break
      }

      case 'assistant':
        this.handleAssistantMessage(msg.message.content, msg.parent_tool_use_id)
        break

      case 'user':
        this.handleUserMessage(msg.message.content)
        break

      case 'result':
        this.handleResultMessage(msg)
        break

      case 'control_request': {
        // Claude CLI nests fields under `request` with `request_id` at top level
        const req = (msg as any).request ?? msg
        const requestId = (msg as any).request_id ?? (msg as any).id
        const subtype = req.subtype ?? msg.subtype
        const toolName = req.tool_name ?? msg.tool_name
        const input = req.input ?? msg.input ?? {}

        if (subtype === 'can_use_tool') {
          if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') {
            // These tools need user input/approval — forward to frontend
            this.emitHub({
              type: 'approval_required',
              sessionId: this.id,
              requestId,
              toolName,
              input,
            })
          } else {
            // Auto-approve all other tools (replaces --dangerously-skip-permissions)
            this.approveTool(requestId)
          }
        }
        break
      }

      case 'stream_event':
        this.handleStreamEvent(msg)
        break
    }
  }

  private handleAssistantMessage(content: ClaudeContentBlock[], _parentToolUseId?: string) {
    for (const block of content) {
      switch (block.type) {
        case 'text':
          // Skip — already streamed via text_delta events (--include-partial-messages)
          break

        case 'thinking':
          // Skip — already streamed via thinking_delta events
          break

        case 'tool_use':
          this.emitHub({
            type: 'tool_use',
            sessionId: this.id,
            toolUseId: block.id,
            toolName: block.name,
            input: block.input,
          })
          // Auto-derive status from tool name
          this.emitHub({
            type: 'status',
            sessionId: this.id,
            text: describeToolUse(block.name, block.input),
          })
          break
      }
    }
  }

  private handleUserMessage(content: ClaudeContentBlock[]) {
    for (const block of content) {
      if (block.type === 'tool_result') {
        const resultContent = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => c.text).join('\n')
            : String(block.content)

        this.emitHub({
          type: 'tool_result',
          sessionId: this.id,
          toolUseId: block.tool_use_id,
          content: resultContent,
          isError: block.is_error ?? false,
        })
      }
    }
  }

  private handleResultMessage(msg: ClaudeStdoutMessage & { type: 'result' }) {
    this.status = 'idle'
    // total_cost_usd is cumulative (session total), not per-turn
    this.totalCost = msg.total_cost_usd
    this.totalTokens.input += msg.usage.input_tokens
    this.totalTokens.output += msg.usage.output_tokens
    if (msg.usage.cache_read_input_tokens) {
      this.totalTokens.cacheRead = (this.totalTokens.cacheRead ?? 0) + msg.usage.cache_read_input_tokens
    }
    if (msg.usage.cache_creation_input_tokens) {
      this.totalTokens.cacheCreation = (this.totalTokens.cacheCreation ?? 0) + msg.usage.cache_creation_input_tokens
    }

    this.emitHub({
      type: 'result',
      sessionId: this.id,
      cost: msg.total_cost_usd,
      tokens: {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
        cacheRead: msg.usage.cache_read_input_tokens,
        cacheCreation: msg.usage.cache_creation_input_tokens,
      },
      duration: msg.duration_ms,
      sessionIdClaude: msg.session_id,
    })

    // Emit context usage update — input_tokens is the current conversation size
    // (prompt tokens for this turn), NOT cumulative. Add output to approximate total context used.
    const used = msg.usage.input_tokens + msg.usage.output_tokens
    this.emitHub({
      type: 'context_update',
      sessionId: this.id,
      used,
      total: this.contextWindow,
    })
  }

  private handleStreamEvent(msg: ClaudeStdoutMessage & { type: 'stream_event' }) {
    const event = msg.event
    if (event.type === 'content_block_delta' && event.delta) {
      if (event.delta.type === 'text_delta' && event.delta.text) {
        this.emitHub({
          type: 'text_delta',
          sessionId: this.id,
          content: event.delta.text,
        })
      } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
        this.emitHub({
          type: 'thinking_delta',
          sessionId: this.id,
          content: event.delta.thinking,
        })
      }
    }
  }

  /** Log a message that should be replayed to late-joining clients */
  logMessage(msg: LoggableHubMessage) {
    this.messageLog.push(msg)
  }

  /** Flush accumulated deltas into coalesced log entries */
  private flushPendingDeltas() {
    if (this.pendingThinking) {
      this.logMessage({ type: 'thinking', sessionId: this.id, content: this.pendingThinking })
      this.pendingThinking = ''
    }
    if (this.pendingText) {
      this.logMessage({ type: 'text', sessionId: this.id, content: this.pendingText })
      this.pendingText = ''
    }
  }

  private emitHub(msg: HubMessage) {
    // Coalesce deltas in the log — don't store individual deltas
    if (msg.type === 'text_delta') {
      this.pendingText += msg.content
    } else if (msg.type === 'thinking_delta') {
      this.pendingThinking += msg.content
    } else {
      // Any non-delta message flushes accumulated deltas first
      if (msg.type === 'tool_use' || msg.type === 'tool_result' || msg.type === 'result'
        || msg.type === 'session_ended' || msg.type === 'approval_required') {
        this.flushPendingDeltas()
      }
      // Log non-ephemeral messages (skip status, deltas — they're coalesced above)
      if (msg.type !== 'status') {
        this.logMessage(msg as LoggableHubMessage)
      }
    }
    this.emit('hub_message', msg)
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Produce a human-readable status string from a tool invocation */
function describeToolUse(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return `Reading ${input.file_path ?? 'file'}...`
    case 'Write':
      return `Writing ${input.file_path ?? 'file'}...`
    case 'Edit':
      return `Editing ${input.file_path ?? 'file'}...`
    case 'Bash':
      return `Running: ${truncate(String(input.command ?? ''), 60)}`
    case 'Glob':
      return `Searching for ${input.pattern ?? 'files'}...`
    case 'Grep':
      return `Searching for "${truncate(String(input.pattern ?? ''), 40)}"...`
    case 'WebSearch':
      return `Searching: ${truncate(String(input.query ?? ''), 50)}`
    case 'WebFetch':
      return `Fetching ${truncate(String(input.url ?? ''), 50)}...`
    case 'Agent':
      return `Spawning sub-agent: ${truncate(String(input.description ?? ''), 40)}`
    default:
      return `Using ${toolName}...`
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str
}

