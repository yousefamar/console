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
  AttentionState,
} from './protocol.js'
import { parseModelString } from './utils.js'
import { getLastReadIndex } from './read-state.js'
import { getChildCountSync } from './process-tree.js'
import { mentionsAmar, extractAttentionSnippet } from './attention.js'
import { parseHandoff } from './handoff.js'
import { looksLikeModelError } from './model-config.js'
import { taggedModelId } from './bedrock-profiles.js'
import { isTransientApiError, RESUME_BACKOFF_MS, MAX_AUTO_RESUMES_PER_HOUR } from './transient-errors.js'
import { readTodos, watchTodos, type TodoItem } from './agents/todo-store.js'

let sessionCounter = 0

// Ultimate fallback model when no resolver is wired (e.g. unit tests). In the
// running hub the model comes from ModelConfig via setAgentModelResolver — see
// model-config.ts. Kept currently-available so a bare Session() never spawns a
// dead model.
const DEFAULT_AGENT_MODEL = 'claude-opus-4-8'

// Injected at boot (index.ts) so the model is a runtime-configurable setting
// with a fallback chain rather than a hardcoded const. Honours the CLAUDE_MODEL
// env override internally (see ModelConfig.getModel).
let agentModelResolver: (() => string) | null = null
export function setAgentModelResolver(fn: () => string) { agentModelResolver = fn }
function resolveAgentModel(): string {
  return agentModelResolver?.() ?? process.env.CLAUDE_MODEL?.trim() ?? DEFAULT_AGENT_MODEL
}

/** How many times a single session may auto-restart chasing a working model
 *  before giving up — guards against a restart loop if every model fails. */
const MAX_MODEL_RESTARTS = 6

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
  /** claudeSessionId of the session this was forked from — used to nest forks
   *  under their parent in the sidebar. Persisted across restarts. */
  parentClaudeSessionId?: string
  /** Display name for the session (persists across restarts) */
  name?: string
  /**
   * Verbatim text appended to Claude's system prompt at spawn time. Passed to
   * `claude --append-system-prompt`. Used to inject a persona (Al's AL.md +
   * mistakes.md + workflows summary) into a fresh long-lived session.
   * Ignored on `resume` — Claude's CLI uses the prompt from the original spawn.
   */
  systemPrompt?: string
  /** Apply `systemPrompt` even though this spawn is a --resume (charter
   *  reload: new prompt, full history). See the spawn-args comment. */
  reapplyPromptOnResume?: boolean
  /** Restore the `@amar` attention flag on hub-restart resume (from manifest). */
  needsAttention?: AttentionState | null
  /** Stable slug for board `@key` addressing + CONSOLE_AGENT_KEY env (actor
   *  attribution). Pure identifier — no file behind it. Persisted in the manifest. */
  agentKey?: string
  /** Vault project slug this session is bound to (Spaces agent panel, board
   *  default-owner resolution). Persisted in the manifest. */
  project?: string
  /** PARA area tags this session is bound to. Persisted in the manifest. */
  areas?: string[]
  /** Absolute message-log high-water at the last manifest save. Restored into
   *  `logOffset` on a hub-restart resume so `messageLogLength` reports the true
   *  total (the in-memory log starts empty) — otherwise the unread marker
   *  (`messageLogLength > lastReadIndex`) collapses to false for every session
   *  on restart. Persisted in the manifest. */
  restoreMessageLogLength?: number
  /** Restore the session directly into hibernation: NO subprocess is spawned
   *  until the first message arrives (sendMessage wakes it with --resume).
   *  Used by the hub-restart restore loop for idle sessions so a restart
   *  doesn't thunder-herd 40+ claude spawns (~250MB RSS each). Requires
   *  `resume`; ignored for forks/fresh spawns. */
  hibernateOnStart?: boolean
  /** Per-session model pin. When set, THIS session spawns with (and stays on)
   *  this model instead of the hub-wide ModelConfig one, and fleet-wide model
   *  changes skip it. Persisted in the manifest. */
  modelOverride?: string
  /** Restore a prompt that was queued for turn-end but never flushed (hub
   *  restarted mid-turn). Persisted in the manifest. */
  queuedMessage?: string | null
}

export class Session extends EventEmitter {
  readonly id: string
  claudeSessionId?: string
  name?: string
  /** claudeSessionId of the parent session if this is a fork (else undefined). */
  readonly parentClaudeSessionId?: string
  /** Durable org-chart role key (agents/registry.ts), if this session embodies one. */
  readonly agentKey?: string
  readonly project?: string
  readonly areas?: string[]
  status: 'running' | 'idle' | 'ended' = 'running'
  readonly createdAt = Date.now()
  readonly initialPrompt: string
  readonly cwd: string
  totalCost = 0
  totalTokens: TokenUsage = { input: 0, output: 0 }
  contextWindow = 200_000
  /** Per-session model pin (see SessionOptions.modelOverride). While set, this
   *  session ignores the hub-wide model: spawns/respawns use it, and
   *  restartAllSessionsForModel skips the session. undefined = follow the hub. */
  modelOverride?: string

  /** `@amar` attention flag — set when the session emits `@amar` in assistant
   *  output, cleared when Yousef opens / marks-read the session. */
  needsAttention: AttentionState | null = null
  /** Push dedup + anti-noise: last push time and a rolling 10-min window of
   *  push timestamps. The marker always refreshes; only the PUSH is gated. */
  private lastAttentionPushAt = 0
  private attentionPushTimes: number[] = []

  /** A prompt held back until the current turn FULLY ends (see queueMessage).
   *  Distinct from steering: any stdin write lands at the next tool boundary,
   *  so a real queue must not touch stdin until `result`. */
  queuedMessage: string | null = null

  /** The CLI's own task list for this session, read from
   *  ~/.claude/tasks/<claudeSessionId>/ (see agents/todo-store.ts). The stream
   *  never carries the assembled list, so the disk store is the only source. */
  todos: TodoItem[] = []
  private todoWatcher: (() => void) | null = null
  /** claudeSessionId the todo watcher is bound to — a fork gets a new csid, so
   *  the watcher must re-bind rather than keep watching the parent's dir. */
  private todoWatchedCsid: string | null = null

  /**
   * Coalesced message log for replay to late-joining clients.
   *
   * Bounded by MAX_LOG_SIZE — older entries roll off into the abyss as new
   * ones arrive. This is the rolling window; absolute indexing is tracked via
   * `logOffset`. Without the cap a 13-hour multi-session hub blew through V8's
   * default 4 GB heap (24+ sessions × hours of tool_use blocks).
   *
   * Source of truth for the full history is Claude CLI's own JSONL transcript
   * at ~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl, which it
   * writes regardless of this log. On hub restart the SDK replays into this
   * log via stream-json, so cold-boot naturally rebuilds the recent window.
   */
  readonly messageLog: LoggableHubMessage[] = []
  /** Absolute index of `messageLog[0]`. Increases when the rolling window
   *  rolls off the oldest entry; never decreases except on clearLog. */
  private logOffset = 0
  private readonly MAX_LOG_SIZE = 500

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
    this.parentClaudeSessionId = options.parentClaudeSessionId
    this.agentKey = options.agentKey
    this.project = options.project
    this.areas = options.areas
    this.cwd = options.cwd || process.cwd()
    this.modelOverride = options.modelOverride
    // Restore the absolute message-log high-water (see SessionOptions). The
    // in-memory log starts empty, so without this messageLogLength would report
    // 0 after a restart and every session's unread marker would be wiped. The
    // restored offset models "all prior messages rolled off to disk", exactly
    // the get_older_messages boundary, so pagination stays consistent.
    if (options.restoreMessageLogLength && options.restoreMessageLogLength > 0) {
      this.logOffset = options.restoreMessageLogLength
    }
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
    // Restore a pending @amar marker across hub restarts.
    if (options.needsAttention) this.needsAttention = options.needsAttention
    // A queued prompt survives a hub restart mid-turn (that's the whole point
    // of it living hub-side) — restore BEFORE the hibernate early-return.
    // A restored queue is NOT auto-flushed here: for a session that was
    // mid-turn the restart nudge re-runs the turn and the flush happens at its
    // end (the normal path); for an idle one the restore loop flushes
    // explicitly once its listeners are attached. Flushing from the ctor would
    // race the nudge and turn the queued prompt into steering.
    if (options.queuedMessage) this.queuedMessage = options.queuedMessage
    // Restore-into-hibernation: skip the spawn entirely — the first message
    // wakes the session with --resume (sendMessage → wakeFromHibernation).
    // Keeps hub restarts light: 40+ idle sessions = zero claude processes.
    if (options.hibernateOnStart && options.resume && !options.fork) {
      this.status = 'idle'
      this.hibernated = true
      return
    }
    this.spawn(options)
    // Send the initial prompt via stdin (since we use --input-format stream-json instead of -p)
    // For silent resumes (hub restart restore), skip — Claude resumes idle, waiting for user input
    if (!options.silent) {
      this.sendMessage(options.prompt, options.images)
    }
  }

  /** Deliver a queued prompt when there's no turn left to wait for. */
  flushIfIdle(): void {
    if (this.status === 'idle') this.flushQueuedMessage()
  }

  private spawn(options: SessionOptions) {
    // Extended thinking moved from prompt-keywords to an explicit CLI flag in
    // Claude Code 2.x — without --effort, no thinking blocks are ever emitted.
    // Default to 'high' so "think hard" / "ultrathink" in prompts actually shows.
    const effort = process.env.CLAUDE_EFFORT || 'high'
    // Per-session pin wins; else resolved from ModelConfig (runtime-configurable
    // + fallback chain). Record what we spawned with so a model-unavailable
    // failure reports the right id.
    const model = this.modelOverride ?? resolveAgentModel()
    this.spawnedModel = model
    this.spawnedAt = Date.now()
    this.gotSystemInit = false
    // A respawn orphans any outstanding control_request — the new process
    // knows nothing of it, so a stale marker would misroute normal messages
    // into denyTool (whose response would go unanswered anyway).
    this.approvalPending = false
    this.pendingApprovalRequest = null
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--permission-prompt-tool', 'stdio',
      '--chrome',
      '--effort', effort,
      // Translate to this owner's tagged inference-profile ARN on Bedrock, so
      // the spend is attributable to a person. `--model` OVERRIDES
      // `ANTHROPIC_MODEL`, so passing the bare id here bypassed every tagged
      // profile and made ~all fleet spend permanently untagged in Cost
      // Explorer. `spawnedModel` deliberately keeps the BARE id (above) — the
      // fallback chain, model labels, and context-window table are all keyed on
      // it. No-op off Bedrock. See bedrock-profiles.ts.
      '--model', taggedModelId(model),
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

    // Append the system prompt on fresh spawns, and on resumes ONLY when the
    // caller explicitly asks (role reload): --append-system-prompt applies per
    // INVOCATION — a resume without it keeps the original prompt, a resume
    // with it REPLACES the previous append (empirically verified 2026-08-18:
    // ALPHA appended at spawn, BETA appended at resume → model sees only BETA,
    // history intact). So charter reloads can keep full history. Ordinary
    // hub-restart resumes still pass no prompt (charter unchanged).
    if (options.systemPrompt && (!options.resume || options.reapplyPromptOnResume)) {
      args.push('--append-system-prompt', options.systemPrompt)
    }

    const cwd = this.cwd

    this.process = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The session's own agentKey rides the env so the `con` CLI (and any
      // script the agent runs) can self-identify to the hub — board mutations
      // carry an X-Console-Agent header, letting notifiers skip echoing an
      // agent's own edits back at it.
      env: { ...process.env, ...(this.agentKey ? { CONSOLE_AGENT_KEY: this.agentKey } : {}) },
    })
    this.processAlive = true

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
          // The --resume target's JSONL is gone from disk (CLI retention
          // prune). The process is about to exit(1) pre-init — flag it so the
          // exit handler respawns fresh instead of misreading it as a model
          // failure ("choking on figuring out which model to use").
          if (/no conversation found with session id/i.test(trimmed)) this.resumeTargetMissing = true
          else if (looksLikeModelError(trimmed)) this.signalModelFailure(`stderr: ${trimmed.slice(0, 200)}`)
          this.emitHub({ type: 'status', sessionId: this.id, text: trimmed })
        }
      })
    }

    this.process.on('exit', (code) => {
      this.stdinReady = false
      this.processAlive = false
      // A model-driven restart or a user `reload()` killed the subprocess on
      // purpose — re-spawn it instead of ending the session.
      if (this.restartingForModel || this.reloading) {
        this.restartingForModel = false
        this.reloading = false
        this.doModelRespawn()
        return
      }
      // The --resume target's JSONL was pruned from the CLI's ~/.claude
      // retention — resuming can never succeed, so retrying (or blaming the
      // model) just wedges the session forever. Respawn FRESH: the hub-side
      // log/name/role survive, the CLI mints a new claudeSessionId on init,
      // and the message that triggered the wake is re-delivered.
      if (this.resumeTargetMissing && !this.endedByUser) {
        this.resumeTargetMissing = false
        // The message that triggered the wake was written to the dying
        // process's stdin (lastStdinPrompt) or is still parked
        // (pendingWakeMessage) — either way, re-deliver it to the fresh spawn.
        const pending = this.pendingWakeMessage ?? this.lastStdinPrompt
        this.pendingWakeMessage = null
        this.lastStdinPrompt = null
        this.emitHub({ type: 'error', sessionId: this.id, message: 'This session\'s transcript was pruned from disk, so it can\'t be resumed — restarted as a fresh conversation (hub history kept; the model starts without its old context).' })
        this.spawn({ prompt: '', cwd: this.cwd, silent: true, name: this.name })
        if (pending) this.sendMessage(pending.content, pending.images)
        else this.status = 'idle'
        return
      }
      // Hibernation: we killed the subprocess of an idle session to reclaim
      // its ~250MB RSS. The session stays alive (idle, log + unread intact) —
      // it re-spawns with --resume the moment a message arrives (sendMessage).
      // (If the user killed the session while the hibernation SIGKILL was in
      // flight, endedByUser wins — fall through to the normal ended path.)
      if (this.hibernating && !this.endedByUser) {
        this.hibernating = false
        this.hibernated = true
        // A message raced in while the process was dying — wake immediately.
        const pending = this.pendingWakeMessage
        if (pending) {
          this.pendingWakeMessage = null
          this.wakeFromHibernation()
          this.sendMessage(pending.content, pending.images)
        }
        return
      }
      // If process exited after an interrupt and we have a claudeSessionId,
      // auto-resume instead of ending the session
      if (this.interrupted && this.claudeSessionId) {
        this.interrupted = false
        this.status = 'idle'
        this.emitHub({ type: 'result', sessionId: this.id, cost: this.totalCost, tokens: { input: 0, output: 0 }, duration: 0, sessionIdClaude: this.claudeSessionId })
        // Re-spawn with --resume to keep the session alive
        this.spawn({ prompt: '', cwd: this.cwd, resume: this.claudeSessionId, silent: true, name: this.name })
        // This synthetic `result` bypasses handleResultMessage, so the queue
        // flush has to be repeated here — otherwise an interrupt would strand
        // the queued prompt until the end of some later turn.
        this.flushQueuedMessage()
        return
      }
      // Exited before ever initializing, soon after spawn → the model is the
      // likely culprit (pulled / unavailable / not entitled). Signal the hub so
      // it can advance the fallback chain. reportFailure → restartAllSessions
      // (or the stale/else branch) synchronously re-spawns THIS session via
      // restartForModelChange (which handles the now-dead process). Do NOT end
      // the session here — returning lets that re-spawn stand.
      if (!this.gotSystemInit && !this.endedByUser
          && Date.now() - this.spawnedAt < 20_000) {
        this.signalModelFailure(`exited before init (code=${code})`)
        // If the signal led to a re-spawn (new process alive), we're done.
        if (this.processAlive || this.restartingForModel) return
        // Otherwise (chain exhausted / no advance) fall through to end cleanly.
      }
      this.status = 'ended'
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

  // ------------------------------------------------------------------ //
  // Transient-error auto-resume (429/503/overloaded). One pending timer per
  // session; consecutive failures walk RESUME_BACKOFF_MS; an hourly cap stops
  // a persistent outage from burning tokens; any real user prompt cancels
  // (their message continues the turn anyway) and resets the backoff.

  private transientResumeTimer: ReturnType<typeof setTimeout> | null = null
  private transientResumeAttempt = 0
  private transientResumeTimestamps: number[] = []

  private scheduleTransientResume(errorText: string): void {
    if (this.status === 'ended') return
    if (this.transientResumeTimer) return // one in flight is enough
    const hourAgo = Date.now() - 3_600_000
    this.transientResumeTimestamps = this.transientResumeTimestamps.filter((t) => t > hourAgo)
    if (this.transientResumeTimestamps.length >= MAX_AUTO_RESUMES_PER_HOUR) {
      console.log(`[auto-resume] ${this.id}: hourly cap reached, staying idle (${errorText.slice(0, 80)})`)
      return
    }
    const wait = RESUME_BACKOFF_MS[Math.min(this.transientResumeAttempt, RESUME_BACKOFF_MS.length - 1)]
    this.transientResumeAttempt++
    console.log(`[auto-resume] ${this.id}: transient API error, resuming in ${Math.round(wait / 1000)}s (attempt ${this.transientResumeAttempt})`)
    this.transientResumeTimer = setTimeout(() => {
      this.transientResumeTimer = null
      if (this.status === 'ended' || this.status === 'running') return
      this.transientResumeTimestamps.push(Date.now())
      const content = 'The previous request hit a transient API error (rate limit / overloaded). Continue from where you left off.'
      const userMsg = { type: 'user_prompt' as const, sessionId: this.id, content }
      this.emitHub(userMsg)
      this.logMessage(userMsg)
      this.sendMessage(content)
    }, wait)
    this.transientResumeTimer.unref?.()
  }

  /** A real user message supersedes any pending auto-resume. Called from the
   *  send_message route (NOT from the nudge itself — it nulls the timer
   *  before sending). */
  cancelTransientResume(): void {
    if (this.transientResumeTimer) {
      clearTimeout(this.transientResumeTimer)
      this.transientResumeTimer = null
    }
    this.transientResumeAttempt = 0
  }

  /** Send a follow-up user prompt, optionally with images */
  sendMessage(content: string, images?: ImageAttachment[]) {
    this.lastActivityAt = Date.now()
    // Hibernated (or mid-hibernation) — bring the subprocess back first.
    if (this.hibernating) {
      // SIGKILL in flight; the exit handler wakes + sends this for us.
      this.pendingWakeMessage = { content, images }
      this.status = 'running'
      return
    }
    if (this.hibernated) {
      this.wakeFromHibernation()
    }
    this.status = 'running'
    // Keep a copy: if this process dies because its --resume target was
    // pruned from disk, the write below went nowhere — the fresh respawn
    // re-delivers it.
    this.lastStdinPrompt = { content, images }
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

  // ------------------------------------------------------------------ //
  // Queued messages — "send this when the WHOLE turn is done".
  //
  // NOT steering: a stdin write lands at the CLI's next tool boundary, so
  // anything queued client-side would interrupt the turn. Held here instead
  // and flushed on `result`, which also means it survives a page reload, the
  // phone backgrounding, and a hub restart mid-turn (manifest-persisted).
  // ONE buffer that grows — a second queue appends rather than making a FIFO.

  /** Append `content` to the queued prompt (blank-line separated). */
  queueMessage(content: string): void {
    const text = content.trim()
    if (!text) return
    this.queuedMessage = this.queuedMessage ? `${this.queuedMessage}\n\n${text}` : text
    this.emitQueued()
    // No turn to wait for — queueing on an idle session is just sending.
    this.flushIfIdle()
  }

  /** Replace the queued prompt outright; `null`/empty cancels it. */
  setQueuedMessage(content: string | null): void {
    const text = content?.trim() || null
    if (text === this.queuedMessage) return
    this.queuedMessage = text
    this.emitQueued()
  }

  /** Deliver the queued prompt as a real user message. Called at turn end.
   *  Clears the slot FIRST — sendMessage flips status back to 'running', and a
   *  re-entrant flush would double-send. */
  flushQueuedMessage(): void {
    const content = this.queuedMessage
    if (!content || this.status === 'ended') return
    this.queuedMessage = null
    this.emitQueued()
    // Same triple as the transient-resume nudge: broadcast + log so the
    // transcript shows it, then write it to stdin.
    const userMsg = { type: 'user_prompt' as const, sessionId: this.id, content }
    this.logMessage(userMsg)
    this.emit('hub_message', userMsg satisfies HubMessage)
    this.sendMessage(content)
  }

  /** Broadcast the queue state. Bypasses emitHub deliberately — emitHub logs
   *  everything but status/tool_input_delta, and this is ephemeral state, not
   *  transcript. */
  private emitQueued(): void {
    this.emit('hub_message', {
      type: 'session_queued',
      sessionId: this.id,
      queuedMessage: this.queuedMessage,
    } satisfies HubMessage)
  }

  // --------------------------------------------------------------------------
  // Task list (CLI todos)
  // --------------------------------------------------------------------------

  /** Bind the watcher for a session whose csid was known at construction (a
   *  resume, incl. restore-into-hibernation, which never emits system/init).
   *  Called by the hub AFTER listeners are attached — the ctor is too early for
   *  the initial emit to reach anyone. Idempotent. */
  startTodoWatch(): void {
    this.bindTodoWatcher()
  }

  /** Bind (or re-bind) the todo watcher to the current claudeSessionId. Called
   *  once the csid is known — on `system`/init and on a pre-set resume. */
  private bindTodoWatcher(): void {
    const csid = this.claudeSessionId
    if (!csid || csid === this.todoWatchedCsid) return
    this.todoWatcher?.()
    this.todoWatchedCsid = csid
    const initial = readTodos(csid)
    if (initial.length) {
      this.todos = initial
      this.emitTodos()
    }
    this.todoWatcher = watchTodos(csid, (todos) => {
      this.todos = todos
      this.emitTodos()
    })
  }

  /** Ephemeral like session_queued — the authoritative copy rides
   *  SessionInfo.todos, and the files on disk outlive everything. */
  private emitTodos(): void {
    this.emit('hub_message', {
      type: 'session_todos',
      sessionId: this.id,
      todos: this.todos,
    } satisfies HubMessage)
  }

  /** Approve a tool use request */
  approveTool(requestId: string, modifiedInput?: Record<string, unknown>) {
    const inner: Record<string, unknown> = { behavior: 'allow' }
    // Only include updatedInput when the caller is actually modifying the
    // tool input (e.g. AskUserQuestion answers). Plain approvals omit it —
    // cleaner on the wire and matches what the Claude CLI expects.
    if (modifiedInput !== undefined) inner.updatedInput = modifiedInput
    const response: Record<string, unknown> = {
      type: 'control_response',
      response: {
        request_id: requestId,
        response: inner,
      },
    }
    this.resolveUserApproval(requestId)
    this.lastActivityAt = Date.now()
    this.writeStdin(response as any)
  }

  /** Answering a user-facing approval (AskUserQuestion/ExitPlanMode) IS the
   *  acknowledgement — drop the red marker it raised. Auto-approvals of
   *  ordinary tools never set pendingApprovalRequest, so a genuine @amar
   *  marker survives them. */
  private resolveUserApproval(requestId: string) {
    const wasUserFacing = this.pendingApprovalRequest?.requestId === requestId
    this.approvalPending = false
    this.pendingApprovalRequest = null
    if (wasUserFacing) this.clearAttention()
  }

  /** Deny a tool use request */
  denyTool(requestId: string, reason?: string) {
    // Claude CLI requires `message` to be a string (Zod rejects undefined)
    const response: Record<string, unknown> = {
      type: 'control_response',
      response: {
        request_id: requestId,
        response: { behavior: 'deny', message: reason ?? 'Denied by user' },
      },
    }
    this.resolveUserApproval(requestId)
    this.lastActivityAt = Date.now()
    this.writeStdin(response as any)
  }

  /** Set when we send SIGINT so exit handler knows to auto-resume */
  private interrupted = false

  /** Interrupt the current operation (SIGINT) */
  interrupt() {
    if (this.process && this.status === 'running') {
      this.interrupted = true
      this.process.kill('SIGINT')
    }
  }

  /** True when the user explicitly ended this session (kill_session /
   *  delete_session), as opposed to the subprocess dying on its own (SDK
   *  timeout, crash). Persisted to the manifest so an explicit "End session"
   *  survives hub restarts — incidental deaths still get resumed. */
  endedByUser = false

  // --- Model-failure / fallback bookkeeping (see model-config.ts) ---
  /** Model id passed to `--model` on the most recent spawn. */
  private spawnedModel = ''
  /** Wall-clock of the most recent spawn — used to scope the "exited before
   *  init" model-failure heuristic to a short window. */
  private spawnedAt = 0
  /** True once the subprocess emitted its `system` init — i.e. it started fine. */
  private gotSystemInit = false
  /** De-dupe: emit at most one `model_failure` per spawn. */
  private modelFailureSignaled = false
  /** Set while a model-driven restart is in flight so the exit handler re-spawns
   *  instead of ending the session. */
  private restartingForModel = false
  /** Set while a user-driven `reload()` is in flight — same re-spawn path as a
   *  model restart, but triggered manually (con agent reload). */
  private reloading = false
  /** Whether the current subprocess is still running — guards restart against
   *  kill()ing an already-dead process (which would never fire `exit`). */
  private processAlive = false
  /** Count of consecutive model restarts (reset on successful init). */
  private modelRestarts = 0

  // --- Idle hibernation (see index.ts sweep) ---------------------------------
  // A live `claude` subprocess holds ~250MB RSS even when idle; dozens of
  // parked sessions = many GB. Hibernation kills the subprocess of a
  // long-idle session while keeping the Session entry (message log, unread
  // state, claudeSessionId) — the process transparently re-spawns with
  // --resume on the next message.
  /** Set while the hibernation SIGKILL is in flight (exit handler pending). */
  private hibernating = false
  /** True when the subprocess is dead by hibernation (not ended). */
  hibernated = false
  /** Message that arrived during the hibernating window — sent after exit→wake. */
  private pendingWakeMessage: { content: string; images?: ImageAttachment[] } | null = null
  /** stderr said "No conversation found with session ID" — the --resume
   *  target's JSONL was pruned; the exit handler must respawn fresh. */
  private resumeTargetMissing = false
  /** Last message written to stdin this process-lifetime — re-delivered when a
   *  failed resume forces a fresh respawn (the write went to a dying process). */
  private lastStdinPrompt: { content: string; images?: ImageAttachment[] } | null = null
  /** Wall-clock of the last user message or completed turn — the idle clock. */
  lastActivityAt = Date.now()
  /** An approval (AskUserQuestion / plan) is outstanding — hibernating now
   *  would orphan the pending control_request, making it unanswerable. */
  approvalPending = false
  /** Which approval is outstanding — lets the send_message path route a chat
   *  message typed during an ExitPlanMode review into plan feedback (deny with
   *  the message as reason) instead of stdin, where the CLI can't process it
   *  until the control_request resolves (the "frozen composer"). */
  pendingApprovalRequest: { requestId: string; toolName: string } | null = null

  /** True when this session is safe to hibernate: idle for real (no pending
   *  approval, not mid-anything), with a resumable claudeSessionId. */
  canHibernate(): boolean {
    return this.status === 'idle'
      && !this.endedByUser
      && !this.hibernated
      && !this.hibernating
      && !this.restartingForModel
      && !this.reloading
      && !this.approvalPending
      && this.processAlive
      && !!this.claudeSessionId
  }

  /** Kill the idle subprocess to reclaim its memory. The exit handler flips
   *  `hibernated`; the session stays 'idle' and wakes on the next message. */
  hibernate(): boolean {
    if (!this.canHibernate()) return false
    this.hibernating = true
    this.stdinReady = false
    // SIGKILL: instant, nothing to flush — mirrors restartForModelChange.
    this.process!.kill('SIGKILL')
    return true
  }

  /** Re-spawn a hibernated session with --resume (history preserved, no
   *  system-prompt re-append — spawn() only appends on fresh starts). */
  private wakeFromHibernation() {
    this.hibernated = false
    this.spawn({ prompt: '', cwd: this.cwd, resume: this.claudeSessionId!, silent: true, name: this.name })
  }

  /** Kill the session */
  kill() {
    if (this.transientResumeTimer) { clearTimeout(this.transientResumeTimer); this.transientResumeTimer = null }

    this.endedByUser = true
    // Mark ended unconditionally — not only when a live process exists. If the
    // subprocess had already exited, the old guard left status untouched (e.g.
    // 'running'), so a killed fork could linger as running in the list.
    this.status = 'ended'
    this.stdinReady = false
    // An explicit end supersedes hibernation state (whatever its phase).
    this.hibernating = false
    this.hibernated = false
    this.pendingWakeMessage = null
    if (this.queuedMessage) this.setQueuedMessage(null)
    this.todoWatcher?.()
    this.todoWatcher = null
    this.todoWatchedCsid = null
    if (this.process) {
      this.process.kill('SIGTERM')
    }
  }

  /** Emit a `model_failure` once per spawn so the hub can fall back to the next
   *  model in the chain. Skipped for user-ended sessions and during a model
   *  restart (the new spawn hasn't failed yet). */
  private signalModelFailure(reason: string) {
    if (this.modelFailureSignaled || this.endedByUser || this.restartingForModel) return
    this.modelFailureSignaled = true
    this.emit('model_failure', this.spawnedModel, reason)
  }

  /** Restart this session onto whatever model the resolver now returns. Driven
   *  by the hub after a fallback / manual model switch. Kills the current
   *  subprocess; the exit handler does the actual re-spawn (mirrors the
   *  interrupt-resume path). No-op once the per-session restart cap is hit. */
  restartForModelChange() {
    if (this.endedByUser) return
    // Hibernated sessions have no process to move — they resolve the (new)
    // model at wake time. Respawning here would wake the whole fleet.
    if (this.hibernated || this.hibernating) return
    if (this.restartingForModel) return // a restart is already in flight
    if (this.modelRestarts >= MAX_MODEL_RESTARTS) {
      this.emitHub({ type: 'error', sessionId: this.id, message: `Model fallback gave up after ${MAX_MODEL_RESTARTS} restarts — set a working model.` })
      return
    }
    this.modelRestarts++
    if (this.process && this.processAlive) {
      // Alive — kill it; the exit handler does the re-spawn on the new model.
      this.restartingForModel = true
      this.process.kill('SIGKILL')
    } else {
      // Already dead (e.g. failed before init) — re-spawn directly. Killing a
      // dead process would never fire `exit`, so the exit-driven path can't run.
      this.doModelRespawn()
    }
  }

  /** Re-spawn this session's subprocess, resuming the same Claude conversation
   *  (history + original system prompt preserved). Recovers a stuck/dead
   *  session — or revives a user-killed one — without bouncing the hub. For Al,
   *  the hub routes to `reloadAlSession()` instead, which re-derives the persona
   *  via a genuinely fresh spawn (a resume keeps the OLD `--append-system-prompt`). */
  reload() {
    this.endedByUser = false
    this.modelRestarts = 0
    if (this.process && this.processAlive) {
      this.reloading = true
      this.process.kill('SIGKILL') // exit handler does the re-spawn
    } else {
      this.doModelRespawn()
    }
  }

  /** Re-spawn after a model change. Resumes silently when we have a
   *  claudeSessionId (history preserved); otherwise re-runs the initial prompt
   *  fresh on the new model (the prior attempt never produced a session). */
  private doModelRespawn() {
    this.modelFailureSignaled = false
    this.gotSystemInit = false
    this.status = 'idle'
    if (this.claudeSessionId) {
      this.spawn({ prompt: '', cwd: this.cwd, resume: this.claudeSessionId, silent: true, name: this.name })
    } else {
      this.spawn({ prompt: this.initialPrompt, cwd: this.cwd, name: this.name })
      if (this.initialPrompt) this.sendMessage(this.initialPrompt)
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
      parentClaudeSessionId: this.parentClaudeSessionId,
      agentKey: this.agentKey,
      project: this.project,
      areas: this.areas,
      status: this.status,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      prompt: this.initialPrompt,
      cwd: this.cwd,
      totalCost: this.totalCost,
      totalTokens: { ...this.totalTokens },
      modelOverride: this.modelOverride,
      messageLogLength: this.messageLogLength,
      lastReadIndex: getLastReadIndex(this.claudeSessionId),
      hibernated: this.hibernated || undefined,
      backgroundProcessCount: getChildCountSync(this.process?.pid),
      needsAttention: this.needsAttention,
      lastTextSnippet: this.lastTextSnippet,
      queuedMessage: this.queuedMessage,
      todos: this.todos.length ? this.todos : undefined,
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
        // Non-init lifecycle subtypes (status, task_*, compact_boundary) — the
        // init-only bookkeeping below must NOT run for these.
        if (msg.subtype !== 'init') {
          this.handleSystemLifecycle(msg)
          break
        }
        // A pre-set csid (resume) that differs from what the CLI minted means
        // this live session was re-keyed (pruned-transcript fresh respawn) —
        // forks/fresh spawns never pre-set, so they can't trip this.
        const prevCsid = this.claudeSessionId
        const rekeyedFrom = prevCsid && prevCsid !== msg.session_id ? prevCsid : undefined
        this.claudeSessionId = msg.session_id
        // A fork's csid only arrives here, so this is where the todo watcher
        // gets its dir (idempotent for a resume that pre-set the same csid).
        this.bindTodoWatcher()
        // Subprocess started cleanly — clear model-failure bookkeeping so a
        // later (different) model death can still trip a fresh fallback.
        this.gotSystemInit = true
        this.modelFailureSignaled = false
        this.modelRestarts = 0
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
          ...(rekeyedFrom ? { rekeyedFrom } : {}),
        })
        break
      }

      case 'assistant': {
        // Synthetic assistant messages (`model: "<synthetic>"`) come from the
        // CLI itself, not from the model. Two flavours:
        //   1. `isApiErrorMessage: true` — Usage Policy blocks, rate-limit
        //      kicks, etc. Render as error.
        //   2. Slash commands like /context, /usage, /help — markdown content
        //      (tables, headings). Render as plain text.
        // Both flavours arrive with NO preceding stream_event partials, so
        // handleAssistantMessage's text-block skip would drop them silently.
        // We emit text/error explicitly here based on the flag.
        const anyMsg = msg as unknown as { isApiErrorMessage?: boolean; is_api_error_message?: boolean; error?: string; message: { model?: string } }
        const isSynthetic = anyMsg.message?.model === '<synthetic>'
        if (isSynthetic) {
          const text = msg.message.content
            .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
            .filter(Boolean)
            .join('\n')
            .trim()
          if (text) {
            // The CLI's stream-json flag is `is_api_error_message` (snake_case)
            // as of 2.1.220 — the camelCase form is the on-disk JSONL shape and
            // matched NOTHING on the wire, so the whole error branch (incl.
            // transient auto-resume) silently dead-ended and 503s/timeouts left
            // sessions halted. Accept both, plus a text-prefix fallback so the
            // next field rename can't kill auto-resume silently again.
            const isApiError = anyMsg.isApiErrorMessage || anyMsg.is_api_error_message
              || anyMsg.error != null || /^API Error/i.test(text)
            if (isApiError) {
              if (isTransientApiError(text)) {
                // 429/503/overloaded: the turn died but the session is fine.
                // Schedule a backoff "Continue." nudge instead of sitting
                // idle until someone notices (auto-resume, like hub restarts).
                this.scheduleTransientResume(text)
              } else if (looksLikeModelError(text)) {
                this.signalModelFailure(`api error: ${text.slice(0, 200)}`)
              }
              this.emitHub({ type: 'error', sessionId: this.id, message: text })
            } else {
              this.emitHub({ type: 'text', sessionId: this.id, content: text })
            }
          }
        }
        this.handleAssistantMessage(msg.message.content, msg.parent_tool_use_id)
        break
      }

      case 'user':
        this.handleUserMessage(msg.message.content)
        this.handleToolUseResult(msg)
        break

      case 'result':
        this.handleResultMessage(msg)
        break

      case 'control_response':
        this.handleControlResponse(msg)
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
            // These tools need user input/approval — forward to frontend.
            // Blocks hibernation: killing the process now would orphan the
            // pending control_request and the answer could never be delivered.
            this.approvalPending = true
            this.pendingApprovalRequest = { requestId, toolName }
            this.emitHub({
              type: 'approval_required',
              sessionId: this.id,
              requestId,
              toolName,
              input,
            })
            // A pending question IS "this session wants Yousef" — raise the
            // same red marker @amar sets so it can't be missed in the sidebar.
            // push:false — approval_required already fires its own phone push.
            // Cleared on approve/deny (answering is the acknowledgement).
            const q = (input as any)?.questions?.[0]?.question ?? (input as any)?.question
            this.flagAttention(
              typeof q === 'string' && q ? q :
                toolName === 'ExitPlanMode' ? 'Plan ready for review' : 'Question for you',
              false,
            )
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
    // A completed turn = the API is healthy; reset auto-resume backoff.
    this.transientResumeAttempt = 0
    this.status = 'idle'
    this.lastActivityAt = Date.now()
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

    // Per-model breakdown (modelUsage keys are model ids incl. Bedrock ARNs).
    const modelUsage = msg.modelUsage
      ? Object.entries(msg.modelUsage).map(([model, u]) => ({
          model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadInputTokens: u.cacheReadInputTokens,
          cacheCreationInputTokens: u.cacheCreationInputTokens,
          costUSD: u.costUSD,
        }))
      : undefined

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
      ttftMs: msg.ttft_ms,
      stopReason: msg.stop_reason,
      numTurns: msg.num_turns,
      modelUsage,
    })

    // Rough context estimate for immediate UI feedback. input_tokens EXCLUDES
    // cache reads, so after turn 1 this badly under-reports — the accurate
    // number comes from the async get_context_usage control request below,
    // which supersedes this within ~a second.
    // A turn's cumulative usage can exceed the window (it sums every API call
    // in the turn) — clamp so the meter never shows "391k / 200k".
    const used = Math.min(
      msg.usage.input_tokens
        + (msg.usage.cache_read_input_tokens ?? 0)
        + (msg.usage.cache_creation_input_tokens ?? 0)
        + msg.usage.output_tokens,
      this.contextWindow,
    )
    this.emitHub({
      type: 'context_update',
      sessionId: this.id,
      used,
      total: this.contextWindow,
    })

    // Ask the CLI for the authoritative, categorized context usage (system
    // prompt / tools / messages / free space). Response handled in
    // handleControlResponse → a second, accurate context_update.
    this.requestContextUsage()

    // The turn is FULLY done — now (and only now) deliver anything queued.
    this.flushQueuedMessage()
  }

  private handleStreamEvent(msg: ClaudeStdoutMessage & { type: 'stream_event' }) {
    const event = msg.event
    if (event.type === 'content_block_start' && event.content_block) {
      // Remember which tool call each block index belongs to so the
      // input_json_delta stream below can be attributed.
      if (event.content_block.type === 'tool_use' && event.content_block.id && event.index !== undefined) {
        this.streamingToolBlocks.set(event.index, {
          toolUseId: event.content_block.id,
          toolName: event.content_block.name ?? 'tool',
        })
      }
      return
    }
    if (event.type === 'content_block_stop' && event.index !== undefined) {
      this.streamingToolBlocks.delete(event.index)
      return
    }
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
      } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
        // Tool arguments streaming in — forward so the UI can render an
        // Edit/Write being typed live. Ephemeral (not logged/replayed).
        const blk = event.index !== undefined ? this.streamingToolBlocks.get(event.index) : undefined
        if (blk) {
          this.emitHub({
            type: 'tool_input_delta',
            sessionId: this.id,
            toolUseId: blk.toolUseId,
            toolName: blk.toolName,
            content: event.delta.partial_json,
          })
        }
      }
    }
  }

  // ---- rich-protocol handlers (task lifecycle, diffs, control responses) ----

  /** Block index → tool identity for attributing input_json_delta streams. */
  private streamingToolBlocks = new Map<number, { toolUseId: string; toolName: string }>()

  /** Monotonic id for control requests we initiate (get_context_usage, set_model). */
  private controlSeq = 0
  /** In-flight control requests awaiting a control_response, by request_id. */
  private pendingControl = new Map<string, { verb: string; resolve: (r: { ok: boolean; response?: Record<string, unknown>; error?: string }) => void; timer: ReturnType<typeof setTimeout> }>()

  /** Non-init system lifecycle events: model-request status, background-task
   *  (bash/subagent) lifecycle, compaction boundaries. */
  private handleSystemLifecycle(msg: ClaudeStdoutMessage & { type: 'system' }) {
    switch (msg.subtype) {
      case 'status':
        // 'requesting' = a model request just started — surface as a live
        // status so the UI spinner is grounded in reality.
        if (msg.status === 'requesting') {
          this.emitHub({ type: 'status', sessionId: this.id, text: 'Waiting for model…' })
        }
        break
      case 'task_started':
        if (msg.task_id) {
          this.emitHub({
            type: 'bg_task',
            sessionId: this.id,
            taskId: msg.task_id,
            toolUseId: msg.tool_use_id,
            status: 'started',
            description: msg.description,
            taskType: msg.task_type,
          })
        }
        break
      case 'task_notification':
        if (msg.task_id) {
          const raw = (msg as unknown as { status?: string }).status
          this.emitHub({
            type: 'bg_task',
            sessionId: this.id,
            taskId: msg.task_id,
            toolUseId: msg.tool_use_id,
            status: raw === 'failed' ? 'failed' : 'completed',
            summary: msg.summary,
          })
        }
        break
      // task_updated carries incremental patches (e.g. status/end_time) — the
      // completion signal we care about arrives via task_notification, skip.
      case 'compact_boundary':
        this.emitHub({ type: 'status', sessionId: this.id, text: 'Context compacted' })
        break
    }
  }

  /** Mine the CLI's rich tool_use_result for Edit/Write structuredPatch — the
   *  same ready-made unified diff the terminal renders. */
  private handleToolUseResult(msg: ClaudeStdoutMessage & { type: 'user' }) {
    const r = msg.tool_use_result
    if (!r || !Array.isArray(r.structuredPatch) || r.structuredPatch.length === 0 || !r.filePath) return
    // Pair the diff to its tool call: the same user message carries the
    // tool_result block with the tool_use_id.
    const toolResultBlock = msg.message.content.find((b) => b.type === 'tool_result') as { tool_use_id?: string } | undefined
    if (!toolResultBlock?.tool_use_id) return
    this.emitHub({
      type: 'tool_diff',
      sessionId: this.id,
      toolUseId: toolResultBlock.tool_use_id,
      filePath: r.filePath,
      hunks: r.structuredPatch,
    })
  }

  /** Send a control_request to the CLI and await its control_response. */
  private sendControlRequest(verb: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<{ ok: boolean; response?: Record<string, unknown>; error?: string }> {
    return new Promise((resolve) => {
      if (!this.process || !this.processAlive || !this.stdinReady) {
        resolve({ ok: false, error: 'process not available' })
        return
      }
      const requestId = `hub_${++this.controlSeq}_${Date.now()}`
      const timer = setTimeout(() => {
        if (this.pendingControl.delete(requestId)) resolve({ ok: false, error: 'control request timeout' })
      }, timeoutMs)
      this.pendingControl.set(requestId, { verb, resolve, timer })
      this.writeStdin({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: verb, ...params },
      } as any)
    })
  }

  private handleControlResponse(msg: ClaudeStdoutMessage & { type: 'control_response' }) {
    const r = msg.response
    const pending = this.pendingControl.get(r.request_id)
    if (!pending) return // response to an approval or an unknown/expired request
    this.pendingControl.delete(r.request_id)
    clearTimeout(pending.timer)
    pending.resolve(r.subtype === 'success'
      ? { ok: true, response: r.response }
      : { ok: false, error: r.error ?? 'control request failed' })
  }

  /** Fetch the CLI's authoritative categorized context usage and re-emit an
   *  accurate context_update. Fire-and-forget; failures are silent (the rough
   *  estimate from the result path stays). */
  private requestContextUsage() {
    void this.sendControlRequest('get_context_usage').then((res) => {
      if (!res.ok || !res.response) return
      const resp = res.response as { totalTokens?: number; maxTokens?: number; categories?: Array<{ name: string; tokens: number }> }
      if (typeof resp.totalTokens !== 'number') return
      if (typeof resp.maxTokens === 'number' && resp.maxTokens > 0) this.contextWindow = resp.maxTokens
      this.emitHub({
        type: 'context_update',
        sessionId: this.id,
        used: resp.totalTokens,
        total: this.contextWindow,
        breakdown: (resp.categories ?? [])
          .filter((c) => c.name !== 'Free space' && c.tokens > 0)
          .map((c) => ({ name: c.name, tokens: c.tokens })),
      })
    })
  }

  /** Switch the live subprocess's model in place via the CLI's set_model
   *  control verb — no respawn, context fully preserved. Returns false when
   *  the fast path isn't possible (process dead / not inited / timeout);
   *  caller falls back to restartForModelChange(). */
  async setModelLive(model: string): Promise<boolean> {
    if (!this.process || !this.processAlive || !this.gotSystemInit || this.status === 'ended') return false
    // Same attribution translation as the spawn path — an in-place model switch
    // must not silently drop the session onto an untagged bare id.
    const res = await this.sendControlRequest('set_model', { model: taggedModelId(model) })
    if (!res.ok) return false
    this.spawnedModel = model
    const { displayName, contextWindow } = parseModelString(model)
    this.contextWindow = contextWindow
    // Re-announce init-level metadata so clients update the model label.
    // (SPA ignores the empty slashCommands and keeps its current context
    // meter; the follow-up get_context_usage below re-syncs it accurately.)
    this.emitHub({
      type: 'session_init',
      sessionId: this.id,
      claudeSessionId: this.claudeSessionId ?? '',
      model: displayName,
      slashCommands: [],
      contextWindow,
    })
    this.requestContextUsage()
    return true
  }

  /** Pin THIS session to `model` (or clear the pin with null → back to the
   *  hub-wide model) and apply it mid-session: setModelLive fast path first,
   *  kill+respawn fallback (context preserved via --resume). */
  async setSessionModel(model: string | null): Promise<{ ok: boolean; error?: string }> {
    if (this.status === 'ended') return { ok: false, error: 'session has ended' }
    this.modelOverride = model ?? undefined
    const target = model ?? resolveAgentModel()
    if (this.spawnedModel === target) return { ok: true } // already there (e.g. clearing a pin that matched)
    const fast = await this.setModelLive(target)
    if (fast) return { ok: true }
    // Fast path unavailable (dead / pre-init / timeout) — respawn onto the
    // pinned model (spawn() reads modelOverride; resolveAgentModel is the
    // fallback when the pin was cleared).
    this.restartForModelChange()
    return { ok: true }
  }

  /** Log a message that should be replayed to late-joining clients.
   *  Rolls the oldest entry off once at MAX_LOG_SIZE; logOffset accounts for
   *  the absolute index so client pagination keeps working. */
  logMessage(msg: LoggableHubMessage) {
    this.messageLog.push(msg)
    if (this.messageLog.length > this.MAX_LOG_SIZE) {
      this.messageLog.shift()
      this.logOffset++
    }
    // Stamp the absolute index on the object so any subsequent broadcast of
    // it carries authoritative positioning (clients upsert, not append —
    // the transcript-duplication fix). Callers must log BEFORE broadcasting.
    ;(msg as unknown as { absIndex?: number }).absIndex = this.messageLogLength - 1
  }

  /** Absolute message count ever logged (monotonic, equals what would have
   *  been `messageLog.length` without the rolling cap). Indexing semantics
   *  expected by the client. */
  get messageLogLength(): number {
    return this.logOffset + this.messageLog.length
  }

  // Offline-outbox send dedup: last ~50 client dedupeKeys. Checking marks the
  // key as seen, so the FIRST delivery wins and retries drop.
  private readonly seenDedupeKeys: string[] = []
  hasSeenDedupeKey(key: string): boolean {
    if (this.seenDedupeKeys.includes(key)) return true
    this.seenDedupeKeys.push(key)
    if (this.seenDedupeKeys.length > 50) this.seenDedupeKeys.shift()
    return false
  }

  /** Absolute index of `messageLog[0]`. Used by get_older_messages to map
   *  the client's absolute beforeIndex into the in-memory window. */
  get messageLogOffset(): number {
    return this.logOffset
  }

  /** Clear the message log (e.g. after /clear). Resets the offset too —
   *  client indices start over from 0 after this. */
  clearLog() {
    this.messageLog.length = 0
    this.logOffset = 0
  }

  /** Flush accumulated deltas into coalesced log entries */
  private flushPendingDeltas() {
    if (this.pendingThinking) {
      this.logMessage({ type: 'thinking', sessionId: this.id, content: this.pendingThinking })
      this.pendingThinking = ''
    }
    if (this.pendingText) {
      // Scan the *complete* coalesced text — deltas split "@" and "amar" across
      // chunks, so per-delta scanning would miss it.
      this.scanForAttention(this.pendingText)
      this.scanForHandoff(this.pendingText)
      this.noteTextSnippet(this.pendingText)
      this.logMessage({ type: 'text', sessionId: this.id, content: this.pendingText })
      this.pendingText = ''
    }
  }

  /** Last assistant-text opener — the unified Inbox row preview. */
  lastTextSnippet?: string
  private noteTextSnippet(content: string) {
    const line = content.trim().split('\n')[0] ?? ''
    if (line) this.lastTextSnippet = line.length > 140 ? `${line.slice(0, 139)}…` : line
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
      // Directly-emitted text (e.g. synthetic slash-command output) bypasses the
      // delta buffer — scan it too.
      if (msg.type === 'text') { this.scanForAttention(msg.content); this.scanForHandoff(msg.content); this.noteTextSnippet(msg.content) }
      // Log non-ephemeral messages (skip status + all delta streams — including
      // tool_input_delta, which fires per-chunk while tool args stream in and
      // would flood the rolling log)
      if (msg.type !== 'status' && msg.type !== 'tool_input_delta') {
        this.logMessage(msg as LoggableHubMessage) // stamps absIndex pre-broadcast
      }
    }
    this.emit('hub_message', msg)
  }

  // --------------------------------------------------------------------------
  // @amar attention mechanism — agents emit `@amar` to pull Yousef's eyes
  // without injecting into his active workflow timeline. See ~/CLAUDE.md.
  // --------------------------------------------------------------------------

  private scanForAttention(content: string) {
    if (!mentionsAmar(content)) return
    this.flagAttention(extractAttentionSnippet(content), true)
  }

  /** Raise the red attention marker. `wantPush:false` for callers whose event
   *  already has its own notification (pending AskUserQuestion/ExitPlanMode). */
  flagAttention(snippet: string, wantPush: boolean) {
    const now = Date.now()
    this.needsAttention = { ts: now, snippet }

    // Anti-noise: dedup pushes within 60s; suppress (marker-only) if a session
    // floods ≥5 pushes in 10 min — a misbehaving session per the CLAUDE.md rule.
    this.attentionPushTimes = this.attentionPushTimes.filter((t) => now - t < 10 * 60_000)
    const within60s = now - this.lastAttentionPushAt < 60_000
    const flooding = this.attentionPushTimes.length >= 5
    const push = wantPush && !within60s && !flooding
    if (push) { this.lastAttentionPushAt = now; this.attentionPushTimes.push(now) }
    if (flooding) console.warn(`[attention] session ${this.id} (${this.name ?? '?'}) flooding @amar — suppressing push, keeping marker`)

    this.emit('hub_message', {
      type: 'session_attention',
      sessionId: this.id,
      sessionName: this.name,
      needsAttention: this.needsAttention,
      push,
      // Desktop-notification hint: false when the triggering event already
      // notifies (approval_required does its own) — the marker still sticks.
      notify: wantPush,
    } satisfies HubMessage)
  }

  /** Clear the marker (Yousef opened / marked-read the session). */
  clearAttention() {
    if (!this.needsAttention) return
    this.needsAttention = null
    this.emit('hub_message', {
      type: 'session_attention',
      sessionId: this.id,
      sessionName: this.name,
      needsAttention: null,
    } satisfies HubMessage)
  }

  private lastHandoff = ''
  private lastHandoffAt = 0
  /** Detect `@handoff(<agentKey>)` in finalized assistant text → ask the SPA to
   *  offer Yousef a direct line to that agent. Deduped per-target within 30s so a
   *  sentinel re-scanned across flushes fires once. */
  private scanForHandoff(content: string) {
    const target = parseHandoff(content)
    if (!target) return
    const now = Date.now()
    if (target === this.lastHandoff && now - this.lastHandoffAt < 30_000) return
    this.lastHandoff = target
    this.lastHandoffAt = now
    this.emit('hub_message', {
      type: 'session_handoff',
      sessionId: this.id,
      targetAgentKey: target,
    } satisfies HubMessage)
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

