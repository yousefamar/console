import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Session, setAgentModelResolver } from '../session.js'
import { ModelConfig } from '../model-config.js'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HubMessage } from '../protocol.js'

// --------------------------------------------------------------------------
// Mock child_process.spawn
// --------------------------------------------------------------------------

class MockProcess extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() }
  stdout = new Readable({ read() {} }) // proper readable stream for createInterface
  stderr = new Readable({ read() {} })
  pid = 12345
  killed = false

  kill(signal?: string) {
    this.killed = true
    this.emit('exit', signal === 'SIGINT' ? 130 : 0)
  }
}

let lastSpawnArgs: { command: string; args: string[]; options: Record<string, unknown> } | null = null
let mockProcess: MockProcess

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    lastSpawnArgs = { command, args, options }
    mockProcess = new MockProcess()
    return mockProcess
  },
  // process-tree.ts (imported via session.ts) promisifies execFile for its
  // `ps` snapshots. Yield an empty process list in tests.
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
    cb?.(null, { stdout: '' })
  },
  // execSync is used by Session.checkGit
  execSync: () => '',
}))

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function collectHubMessages(session: Session): HubMessage[] {
  const messages: HubMessage[] = []
  session.on('hub_message', (msg: HubMessage) => messages.push(msg))
  return messages
}

function sendStdoutLine(line: string) {
  mockProcess.stdout.push(line + '\n')
}

function sendStdoutJson(obj: Record<string, unknown>) {
  mockProcess.stdout.push(JSON.stringify(obj) + '\n')
}

beforeEach(() => {
  lastSpawnArgs = null
})

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('Session spawn', () => {
  it('spawns claude with correct arguments and sends prompt via stdin', () => {
    const session = new Session({ prompt: 'Fix the bug' })

    expect(lastSpawnArgs).not.toBeNull()
    expect(lastSpawnArgs!.command).toBe('claude')
    expect(lastSpawnArgs!.args).toContain('--output-format')
    expect(lastSpawnArgs!.args).toContain('stream-json')
    expect(lastSpawnArgs!.args).toContain('--input-format')
    expect(lastSpawnArgs!.args).toContain('stream-json')
    expect(lastSpawnArgs!.args).toContain('--verbose')
    expect(lastSpawnArgs!.args).toContain('--permission-prompt-tool')
    expect(lastSpawnArgs!.args).toContain('stdio')
    // Every agent spawns with an explicit --model (resolved from ModelConfig in
    // the running hub; falls back to the built-in default with no resolver).
    expect(lastSpawnArgs!.args).toContain('--model')
    expect(lastSpawnArgs!.args).toContain('claude-opus-4-8')
    // Prompt sent via stdin, not -p
    expect(lastSpawnArgs!.args).not.toContain('-p')
    const written = JSON.parse(mockProcess.stdin.write.mock.calls[0]![0].replace('\n', ''))
    expect(written).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Fix the bug' },
    })
  })

  it('includes resume flag when specified', () => {
    const session = new Session({ prompt: 'continue', resume: 'old_session_123' })

    expect(lastSpawnArgs!.args).toContain('--resume')
    expect(lastSpawnArgs!.args).toContain('old_session_123')
  })

  it('spawns with the model from the injected resolver', async () => {
    const { setAgentModelResolver } = await import('../session.js')
    setAgentModelResolver(() => 'claude-sonnet-4-6')
    try {
      const session = new Session({ prompt: 'x' })
      const i = lastSpawnArgs!.args.indexOf('--model')
      expect(lastSpawnArgs!.args[i + 1]).toBe('claude-sonnet-4-6')
    } finally {
      setAgentModelResolver(() => 'claude-opus-4-8') // reset to a known default
    }
  })

  it('emits model_failure once when it exits before init', async () => {
    setAgentModelResolver(() => 'claude-dead-model')
    try {
      const session = new Session({ prompt: 'x' })
      const failures: Array<{ model: string }> = []
      session.on('model_failure', (model: string) => failures.push({ model }))
      // Process dies before ever emitting a `system` init message.
      mockProcess.emit('exit', 1)
      expect(failures).toHaveLength(1)
      expect(failures[0]!.model).toBe('claude-dead-model')
    } finally {
      setAgentModelResolver(() => 'claude-opus-4-8')
    }
  })

  it('auto-falls-back to the next model and re-spawns on exit-before-init', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sess-fallback-'))
    const cfg = new ModelConfig(join(dir, 'm.json'))
    cfg.setChain(['claude-dead', 'claude-good'])
    setAgentModelResolver(() => cfg.getModel())
    try {
      const session = new Session({ prompt: 'x' })
      // Mirror the hub's createSession wiring (routes/agents.ts).
      session.on('model_failure', (failed: string) => {
        if (cfg.reportFailure(failed).changed) session.restartForModelChange()
      })
      // First spawn used the (dead) head of the chain.
      let i = lastSpawnArgs!.args.indexOf('--model')
      expect(lastSpawnArgs!.args[i + 1]).toBe('claude-dead')
      // Subprocess dies before init → fallback + silent re-spawn on the good model.
      mockProcess.emit('exit', 1)
      expect(cfg.getModel()).toBe('claude-good')
      i = lastSpawnArgs!.args.indexOf('--model')
      expect(lastSpawnArgs!.args[i + 1]).toBe('claude-good')
      expect(session.getInfo().status).not.toBe('ended')
    } finally {
      setAgentModelResolver(() => 'claude-opus-4-8')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('generates unique session IDs', () => {
    const s1 = new Session({ prompt: 'a' })
    const s2 = new Session({ prompt: 'b' })

    expect(s1.id).not.toBe(s2.id)
    expect(s1.id).toMatch(/^session_/)
    expect(s2.id).toMatch(/^session_/)
  })

  it('initializes with running status', () => {
    const session = new Session({ prompt: 'test' })
    expect(session.status).toBe('running')
  })
})

describe('Session getInfo', () => {
  it('returns session metadata', () => {
    const session = new Session({ prompt: 'Fix the bug' })
    const info = session.getInfo()

    expect(info.id).toBe(session.id)
    expect(info.status).toBe('running')
    expect(info.prompt).toBe('Fix the bug')
    expect(info.totalCost).toBe(0)
    expect(info.totalTokens).toEqual({ input: 0, output: 0 })
    expect(info.createdAt).toBeGreaterThan(0)
  })

  // Regression: a hub restart re-spawns sessions with an empty in-memory log, so
  // messageLogLength reported 0 while the persisted lastReadIndex stayed (e.g.)
  // 18 — making hasUnread (= messageLogLength > lastReadIndex) false for EVERY
  // session, wiping all unread markers in the Agents tab. Restoring logOffset
  // from the manifest's high-water keeps the count on the same scale.
  it('restores messageLogLength from a hub-restart resume so unread survives', () => {
    const session = new Session({ prompt: 'continue', resume: 'csid_abc', silent: true, restoreMessageLogLength: 18 })
    expect(session.getInfo().messageLogLength).toBe(18)
  })

  it('a fresh session (no restore) starts at messageLogLength 0', () => {
    const session = new Session({ prompt: 'hi' })
    expect(session.getInfo().messageLogLength).toBe(0)
  })

  it('new logged messages advance the restored count (no double-count)', () => {
    const session = new Session({ prompt: 'continue', resume: 'csid_abc', silent: true, restoreMessageLogLength: 18 })
    session.logMessage({ type: 'text', sessionId: session.id, content: 'a new reply' })
    expect(session.getInfo().messageLogLength).toBe(19)
  })
})

describe('Session stdin writes', () => {
  it('sendMessage writes user message to stdin', () => {
    const session = new Session({ prompt: 'test' })
    session.sendMessage('Follow up question')

    expect(mockProcess.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('"type":"user"'),
    )
    // calls[0] is the initial prompt from constructor, calls[1] is the follow-up
    const written = JSON.parse(mockProcess.stdin.write.mock.calls[1]![0].replace('\n', ''))
    expect(written).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Follow up question' },
    })
  })

  it('approveTool writes control_response with double-nested response format', () => {
    const session = new Session({ prompt: 'test' })
    session.approveTool('req_123')

    // calls[0] is the initial prompt from constructor, calls[1] is the approval
    const written = JSON.parse(mockProcess.stdin.write.mock.calls[1]![0].replace('\n', ''))
    expect(written).toEqual({
      type: 'control_response',
      response: {
        request_id: 'req_123',
        response: { behavior: 'allow' },
      },
    })
  })

  it('approveTool with AskUserQuestion answers includes updatedInput', () => {
    const session = new Session({ prompt: 'test' })
    const questions = [{ question: 'What color?', options: [{ label: 'Blue' }] }]
    session.approveTool('req_123', { questions, answers: { 'What color?': 'Blue' } })

    const written = JSON.parse(mockProcess.stdin.write.mock.calls[1]![0].replace('\n', ''))
    expect(written.response.response.behavior).toBe('allow')
    expect(written.response.response.updatedInput.answers).toEqual({ 'What color?': 'Blue' })
  })

  it('denyTool writes control_response with deny', () => {
    const session = new Session({ prompt: 'test' })
    session.denyTool('req_123', 'Too dangerous')

    const written = JSON.parse(mockProcess.stdin.write.mock.calls[1]![0].replace('\n', ''))
    expect(written).toEqual({
      type: 'control_response',
      response: {
        request_id: 'req_123',
        response: { behavior: 'deny', message: 'Too dangerous' },
      },
    })
  })
})

describe('Session interrupt and kill', () => {
  it('interrupt sends SIGINT to process', () => {
    const session = new Session({ prompt: 'test' })
    const killSpy = vi.spyOn(mockProcess, 'kill')

    session.interrupt()
    expect(killSpy).toHaveBeenCalledWith('SIGINT')
  })

  it('kill sends SIGTERM and sets status to ended', () => {
    const session = new Session({ prompt: 'test' })
    session.kill()

    expect(session.status).toBe('ended')
    expect(mockProcess.killed).toBe(true)
  })
})

describe('Session control_request handling', () => {
  it('auto-approves regular tool control_request (not AskUserQuestion)', async () => {
    const session = new Session({ prompt: 'test' })
    const messages = collectHubMessages(session)

    // Use real nested format: request_id at top level, fields nested under request
    sendStdoutJson({
      type: 'control_request',
      request_id: 'req_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'rm -rf /tmp/test' },
        tool_use_id: 'toolu_123',
      },
    })

    // Wait for readline to process
    await new Promise((r) => setTimeout(r, 10))

    // Should NOT emit approval_required — auto-approved
    const approval = messages.find((m) => m.type === 'approval_required')
    expect(approval).toBeUndefined()

    // Should have written a control_response to stdin with nested response format
    const stdinCalls = mockProcess.stdin.write.mock.calls
    const approveCall = stdinCalls.find((call: string[]) => {
      const parsed = JSON.parse(call[0].replace('\n', ''))
      return parsed.type === 'control_response' && parsed.response?.request_id === 'req_1'
    })
    expect(approveCall).toBeTruthy()
    const written = JSON.parse(approveCall![0].replace('\n', ''))
    expect(written.response.response.behavior).toBe('allow')
  })

  it('emits approval_required for AskUserQuestion control_request', async () => {
    const session = new Session({ prompt: 'test' })
    const messages = collectHubMessages(session)

    // Use real nested format from Claude CLI
    sendStdoutJson({
      type: 'control_request',
      request_id: 'req_ask_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: {
          questions: [{
            question: 'What is your favorite language?',
            header: 'Language',
            multiSelect: false,
            options: [
              { label: 'TypeScript', description: 'Typed JS' },
              { label: 'Python', description: 'Versatile' },
            ],
          }],
        },
        tool_use_id: 'toolu_ask_1',
      },
    })

    await new Promise((r) => setTimeout(r, 10))

    const approval = messages.find((m) => m.type === 'approval_required')
    expect(approval).toBeTruthy()
    if (approval && approval.type === 'approval_required') {
      expect(approval.toolName).toBe('AskUserQuestion')
      expect(approval.requestId).toBe('req_ask_1')
      const questions = approval.input.questions as Array<Record<string, unknown>>
      expect(questions).toHaveLength(1)
      expect(questions[0].question).toBe('What is your favorite language?')
    }
  })

  it('sends answer back via approveTool with answers in permission', async () => {
    const session = new Session({ prompt: 'test' })

    // Simulate AskUserQuestion control_request (real nested format)
    sendStdoutJson({
      type: 'control_request',
      request_id: 'req_ask_2',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: {
          questions: [{
            question: 'Pick a color',
            header: 'Color',
            multiSelect: false,
            options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }],
          }],
        },
        tool_use_id: 'toolu_ask_2',
      },
    })

    await new Promise((r) => setTimeout(r, 10))

    // User selects "Blue" — frontend calls approveTool with answers
    session.approveTool('req_ask_2', { answers: { 'Pick a color': 'Blue' } })

    // Find the control_response written to stdin
    const stdinCalls = mockProcess.stdin.write.mock.calls
    const answerCall = stdinCalls.find((call: string[]) => {
      const parsed = JSON.parse(call[0].replace('\n', ''))
      return parsed.type === 'control_response' && parsed.response?.request_id === 'req_ask_2'
    })
    expect(answerCall).toBeTruthy()
    const written = JSON.parse(answerCall![0].replace('\n', ''))
    expect(written.response.response.behavior).toBe('allow')
    expect(written.response.response.updatedInput.answers).toEqual({ 'Pick a color': 'Blue' })
  })

  it('logs AskUserQuestion approval_required to messageLog', async () => {
    const session = new Session({ prompt: 'test' })

    sendStdoutJson({
      type: 'control_request',
      request_id: 'req_ask_3',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions: [{ question: 'Yes or no?', header: 'Q', multiSelect: false, options: [] }] },
        tool_use_id: 'toolu_ask_3',
      },
    })

    await new Promise((r) => setTimeout(r, 10))

    const logged = session.messageLog.find((m) => m.type === 'approval_required')
    expect(logged).toBeTruthy()
    if (logged && logged.type === 'approval_required') {
      expect(logged.toolName).toBe('AskUserQuestion')
    }
  })
})

describe('Session process exit', () => {
  it('emits session_ended on process exit', () => {
    const session = new Session({ prompt: 'test' })
    const messages = collectHubMessages(session)

    mockProcess.emit('exit', 0)

    expect(session.status).toBe('ended')
    const ended = messages.find((m) => m.type === 'session_ended')
    expect(ended).toBeTruthy()
  })

  it('emits error on process error', () => {
    const session = new Session({ prompt: 'test' })
    const messages = collectHubMessages(session)

    mockProcess.emit('error', new Error('ENOENT: claude not found'))

    const errMsg = messages.find((m) => m.type === 'error')
    expect(errMsg).toBeTruthy()
    if (errMsg && errMsg.type === 'error') {
      expect(errMsg.message).toContain('claude not found')
    }
  })
})

// --------------------------------------------------------------------------
// Rich protocol: structuredPatch diffs, tool-input streaming, task lifecycle,
// context usage, set_model fast path
// --------------------------------------------------------------------------

describe('Session rich protocol', () => {
  it('emits tool_diff from a user message carrying tool_use_result.structuredPatch', async () => {
    const session = new Session({ prompt: 'test' })
    const messages = collectHubMessages(session)

    sendStdoutJson({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e1', content: 'The file was updated.' }] },
      tool_use_result: {
        filePath: '/tmp/x.py',
        structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-def a():', '+def b():', '     pass'] }],
        userModified: false,
      },
    })
    await new Promise((r) => setTimeout(r, 10))

    const diff = messages.find((m) => m.type === 'tool_diff')
    expect(diff).toBeTruthy()
    if (diff && diff.type === 'tool_diff') {
      expect(diff.toolUseId).toBe('toolu_e1')
      expect(diff.filePath).toBe('/tmp/x.py')
      expect(diff.hunks[0]!.lines[0]).toBe('-def a():')
    }
    // Also logged for replay
    expect(session.messageLog.some((m) => m.type === 'tool_diff')).toBe(true)
  })

  it('does NOT emit tool_diff for empty/absent structuredPatch', async () => {
    const session = new Session({ prompt: 'test' })
    const messages = collectHubMessages(session)
    sendStdoutJson({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e2', content: 'created' }] },
      tool_use_result: { filePath: '/tmp/new.py', structuredPatch: [], userModified: false },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(messages.find((m) => m.type === 'tool_diff')).toBeUndefined()
  })

  it('forwards input_json_delta as tool_input_delta attributed via content_block_start', async () => {
    const session = new Session({ prompt: 'test' })
    const messages = collectHubMessages(session)

    sendStdoutJson({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_s1', name: 'Edit' } } })
    sendStdoutJson({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path": "/tmp' } } })
    sendStdoutJson({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '/x.py"' } } })
    sendStdoutJson({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
    await new Promise((r) => setTimeout(r, 10))

    const deltas = messages.filter((m) => m.type === 'tool_input_delta')
    expect(deltas).toHaveLength(2)
    if (deltas[0]!.type === 'tool_input_delta') {
      expect(deltas[0]!.toolUseId).toBe('toolu_s1')
      expect(deltas[0]!.toolName).toBe('Edit')
    }
    // Ephemeral — never logged
    expect(session.messageLog.some((m) => (m as { type: string }).type === 'tool_input_delta')).toBe(false)
  })

  it('emits bg_task lifecycle from system task events', async () => {
    const session = new Session({ prompt: 'test' })
    const messages = collectHubMessages(session)

    sendStdoutJson({ type: 'system', subtype: 'task_started', session_id: 'x', task_id: 't1', tool_use_id: 'toolu_b1', description: 'sleep 30', task_type: 'local_bash' })
    sendStdoutJson({ type: 'system', subtype: 'task_notification', session_id: 'x', task_id: 't1', tool_use_id: 'toolu_b1', status: 'completed', summary: 'done' })
    await new Promise((r) => setTimeout(r, 10))

    const tasks = messages.filter((m) => m.type === 'bg_task')
    expect(tasks).toHaveLength(2)
    if (tasks[0]!.type === 'bg_task' && tasks[1]!.type === 'bg_task') {
      expect(tasks[0]!.status).toBe('started')
      expect(tasks[0]!.description).toBe('sleep 30')
      expect(tasks[1]!.status).toBe('completed')
      expect(tasks[1]!.summary).toBe('done')
    }
  })

  it('system status/task events do not clobber init bookkeeping', async () => {
    const session = new Session({ prompt: 'test' })
    sendStdoutJson({ type: 'system', subtype: 'init', session_id: 'claude_abc', model: 'claude-opus-4-8', slash_commands: [] })
    await new Promise((r) => setTimeout(r, 10))
    expect(session.claudeSessionId).toBe('claude_abc')
    // A later status event must not overwrite claudeSessionId or re-init
    sendStdoutJson({ type: 'system', subtype: 'status', session_id: 'other_id', status: 'requesting' })
    await new Promise((r) => setTimeout(r, 10))
    expect(session.claudeSessionId).toBe('claude_abc')
  })

  it('re-emits an accurate context_update from get_context_usage after result', async () => {
    const session = new Session({ prompt: 'test' })
    const messages = collectHubMessages(session)

    sendStdoutJson({
      type: 'result', subtype: 'success', duration_ms: 100, session_id: 'x', total_cost_usd: 0.1,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000 },
    })
    await new Promise((r) => setTimeout(r, 10))

    // The rough estimate now includes cache reads
    const rough = messages.filter((m) => m.type === 'context_update')
    expect(rough.length).toBeGreaterThanOrEqual(1)
    if (rough[0]!.type === 'context_update') {
      expect(rough[0]!.used).toBe(100 + 50 + 40000 + 2000)
    }

    // The hub sent a get_context_usage control request — answer it
    const stdinCalls = mockProcess.stdin.write.mock.calls
    const ctxReq = stdinCalls.map((c: string[]) => JSON.parse(c[0])).find((p: any) => p.type === 'control_request' && p.request?.subtype === 'get_context_usage')
    expect(ctxReq).toBeTruthy()
    sendStdoutJson({
      type: 'control_response',
      response: {
        subtype: 'success', request_id: ctxReq.request_id,
        response: { totalTokens: 55000, maxTokens: 200000, categories: [
          { name: 'System prompt', tokens: 2000 }, { name: 'Messages', tokens: 53000 }, { name: 'Free space', tokens: 145000 },
        ] },
      },
    })
    await new Promise((r) => setTimeout(r, 10))

    const accurate = messages.filter((m) => m.type === 'context_update').at(-1)
    expect(accurate).toBeTruthy()
    if (accurate && accurate.type === 'context_update') {
      expect(accurate.used).toBe(55000)
      expect(accurate.total).toBe(200000)
      expect(accurate.breakdown).toEqual([
        { name: 'System prompt', tokens: 2000 }, { name: 'Messages', tokens: 53000 },
      ])
    }
  })

  it('result carries modelUsage/ttft/stopReason through to the hub message', async () => {
    const session = new Session({ prompt: 'test' })
    const messages = collectHubMessages(session)
    sendStdoutJson({
      type: 'result', subtype: 'success', duration_ms: 100, session_id: 'x', total_cost_usd: 0.2,
      ttft_ms: 1234, stop_reason: 'end_turn', num_turns: 3,
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: {
        'us.anthropic.claude-fable-5': { inputTokens: 10, outputTokens: 5, costUSD: 0.19 },
        'claude-haiku-4-5': { inputTokens: 400, outputTokens: 21, costUSD: 0.01 },
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    const result = messages.find((m) => m.type === 'result')
    expect(result).toBeTruthy()
    if (result && result.type === 'result') {
      expect(result.ttftMs).toBe(1234)
      expect(result.stopReason).toBe('end_turn')
      expect(result.numTurns).toBe(3)
      expect(result.modelUsage).toHaveLength(2)
      expect(result.modelUsage![0]!.model).toBe('us.anthropic.claude-fable-5')
      expect(result.modelUsage![0]!.costUSD).toBe(0.19)
    }
  })

  it('setModelLive switches model via set_model control request without respawn', async () => {
    const session = new Session({ prompt: 'test' })
    const messages = collectHubMessages(session)
    sendStdoutJson({ type: 'system', subtype: 'init', session_id: 'claude_m1', model: 'claude-opus-4-8', slash_commands: [] })
    await new Promise((r) => setTimeout(r, 10))

    const promise = session.setModelLive('us.anthropic.claude-fable-5')
    await new Promise((r) => setTimeout(r, 10))

    // Hub wrote a set_model control request
    const stdinCalls = mockProcess.stdin.write.mock.calls
    const req = stdinCalls.map((c: string[]) => JSON.parse(c[0])).find((p: any) => p.type === 'control_request' && p.request?.subtype === 'set_model')
    expect(req).toBeTruthy()
    expect(req.request.model).toBe('us.anthropic.claude-fable-5')

    sendStdoutJson({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id } })
    const ok = await promise
    expect(ok).toBe(true)

    // Re-announced session_init with the new model label; process NOT killed
    const inits = messages.filter((m) => m.type === 'session_init')
    expect(inits.length).toBeGreaterThanOrEqual(2)
    expect(mockProcess.killed).toBe(false)
  })

  it('setModelLive returns false pre-init (fast path unavailable)', async () => {
    const session = new Session({ prompt: 'test' })
    const ok = await session.setModelLive('claude-opus-4-8')
    expect(ok).toBe(false)
  })
})

describe('Session per-session model pin', () => {
  it('spawns with modelOverride instead of the resolver model', () => {
    const session = new Session({ prompt: 'x', modelOverride: 'claude-sonnet-4-6' })
    const i = lastSpawnArgs!.args.indexOf('--model')
    expect(lastSpawnArgs!.args[i + 1]).toBe('claude-sonnet-4-6')
    expect(session.getInfo().modelOverride).toBe('claude-sonnet-4-6')
  })

  it('setSessionModel pins mid-session via the set_model fast path', async () => {
    const session = new Session({ prompt: 'x' })
    sendStdoutJson({ type: 'system', subtype: 'init', session_id: 'c_pin1', model: 'claude-opus-4-8', slash_commands: [] })
    await new Promise((r) => setTimeout(r, 10))

    const promise = session.setSessionModel('claude-sonnet-4-6')
    await new Promise((r) => setTimeout(r, 10))
    const req = mockProcess.stdin.write.mock.calls.map((c: string[]) => JSON.parse(c[0]))
      .find((p: any) => p.type === 'control_request' && p.request?.subtype === 'set_model')
    expect(req.request.model).toBe('claude-sonnet-4-6')
    sendStdoutJson({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id } })
    const res = await promise
    expect(res.ok).toBe(true)
    expect(session.modelOverride).toBe('claude-sonnet-4-6')
    expect(mockProcess.killed).toBe(false) // in place, no respawn
  })

  it('setSessionModel(null) clears the pin and moves back to the hub model', async () => {
    const session = new Session({ prompt: 'x', modelOverride: 'claude-sonnet-4-6' })
    sendStdoutJson({ type: 'system', subtype: 'init', session_id: 'c_pin2', model: 'claude-sonnet-4-6', slash_commands: [] })
    await new Promise((r) => setTimeout(r, 10))

    const promise = session.setSessionModel(null) // resolver default = claude-opus-4-8
    await new Promise((r) => setTimeout(r, 10))
    const req = mockProcess.stdin.write.mock.calls.map((c: string[]) => JSON.parse(c[0]))
      .find((p: any) => p.type === 'control_request' && p.request?.subtype === 'set_model')
    expect(req.request.model).toBe('claude-opus-4-8')
    sendStdoutJson({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id } })
    const res = await promise
    expect(res.ok).toBe(true)
    expect(session.modelOverride).toBeUndefined()
  })

  it('respawn after a pin keeps spawning with the pinned model', async () => {
    const session = new Session({ prompt: 'x', modelOverride: 'claude-sonnet-4-6' })
    sendStdoutJson({ type: 'system', subtype: 'init', session_id: 'c_pin3', model: 'claude-sonnet-4-6', slash_commands: [] })
    await new Promise((r) => setTimeout(r, 10))
    // Force the respawn path (as if set_model had failed / process died).
    session.restartForModelChange()
    await new Promise((r) => setTimeout(r, 10))
    const i = lastSpawnArgs!.args.indexOf('--model')
    expect(lastSpawnArgs!.args[i + 1]).toBe('claude-sonnet-4-6')
  })
})

// --------------------------------------------------------------------------
// Idle hibernation — reap idle subprocesses, wake on demand via --resume
// --------------------------------------------------------------------------

describe('Session hibernation', () => {
  async function initedIdleSession(): Promise<Session> {
    const session = new Session({ prompt: 'test' })
    sendStdoutJson({ type: 'system', subtype: 'init', session_id: 'claude_hib', model: 'claude-opus-4-8', slash_commands: [] })
    sendStdoutJson({ type: 'result', subtype: 'success', duration_ms: 5, session_id: 'claude_hib', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
    await new Promise((r) => setTimeout(r, 10))
    expect(session.status).toBe('idle')
    return session
  }

  it('hibernate kills the subprocess but keeps the session idle (no session_ended)', async () => {
    const session = await initedIdleSession()
    const messages = collectHubMessages(session)
    expect(session.hibernate()).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(session.hibernated).toBe(true)
    expect(session.status).toBe('idle')
    expect(messages.find((m) => m.type === 'session_ended')).toBeUndefined()
    expect(session.getInfo().hibernated).toBe(true)
  })

  it('sendMessage wakes a hibernated session via --resume and delivers the message', async () => {
    const session = await initedIdleSession()
    session.hibernate()
    await new Promise((r) => setTimeout(r, 10))
    expect(session.hibernated).toBe(true)

    session.sendMessage('wake up please')
    // Re-spawned with --resume of the same claude session
    expect(lastSpawnArgs!.args).toContain('--resume')
    expect(lastSpawnArgs!.args).toContain('claude_hib')
    expect(session.hibernated).toBe(false)
    expect(session.status).toBe('running')
    // The message went to the NEW process's stdin
    const written = mockProcess.stdin.write.mock.calls.map((c: string[]) => JSON.parse(c[0]))
    expect(written.some((w: any) => w.type === 'user' && w.message?.content === 'wake up please')).toBe(true)
  })

  it('does not hibernate while running, ended, or with a pending approval', async () => {
    const session = await initedIdleSession()
    // Pending approval blocks
    sendStdoutJson({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {} } })
    await new Promise((r) => setTimeout(r, 10))
    expect(session.canHibernate()).toBe(false)
    session.approveTool('r1')
    expect(session.canHibernate()).toBe(true)
    // Running blocks
    session.sendMessage('busy now')
    expect(session.canHibernate()).toBe(false)
  })

  it('kill during hibernation wins — session ends', async () => {
    const session = await initedIdleSession()
    // Start hibernating, then the user kills before exit fires… simulate by
    // setting endedByUser via kill() (which also SIGTERMs the dying proc).
    session.hibernate()
    session.kill()
    await new Promise((r) => setTimeout(r, 10))
    expect(session.status).toBe('ended')
    expect(session.hibernated).toBe(false)
  })

  it('message arriving mid-hibernation (before exit) is queued and delivered after wake', async () => {
    const session = await initedIdleSession()
    // MockProcess.kill emits exit synchronously, so simulate the in-flight
    // window by intercepting kill to delay the exit.
    const proc = mockProcess
    const origKill = proc.kill.bind(proc)
    proc.kill = () => { /* swallow — exit not yet fired */ }
    session.hibernate()
    session.sendMessage('queued during death')
    expect(session.status).toBe('running')
    // Now the old process finally exits
    proc.kill = origKill
    proc.emit('exit', 0)
    await new Promise((r) => setTimeout(r, 10))
    // Woke + delivered
    expect(lastSpawnArgs!.args).toContain('--resume')
    const written = mockProcess.stdin.write.mock.calls.map((c: string[]) => JSON.parse(c[0]))
    expect(written.some((w: any) => w.type === 'user' && w.message?.content === 'queued during death')).toBe(true)
  })
})

describe('Session hibernateOnStart (restore path)', () => {
  it('restores without spawning; first message wakes with --resume', () => {
    lastSpawnArgs = null
    const session = new Session({ prompt: 'old prompt', resume: 'claude_cold', silent: true, hibernateOnStart: true, restoreMessageLogLength: 42 })
    // No subprocess was spawned
    expect(lastSpawnArgs).toBeNull()
    expect(session.status).toBe('idle')
    expect(session.hibernated).toBe(true)
    expect(session.getInfo().messageLogLength).toBe(42)
    // First message wakes it
    session.sendMessage('good morning')
    expect(lastSpawnArgs).not.toBeNull()
    expect(lastSpawnArgs!.args).toContain('--resume')
    expect(lastSpawnArgs!.args).toContain('claude_cold')
    expect(session.hibernated).toBe(false)
    const written = mockProcess.stdin.write.mock.calls.map((c: string[]) => JSON.parse(c[0]))
    expect(written.some((w: any) => w.type === 'user' && w.message?.content === 'good morning')).toBe(true)
  })

  it('model changes skip hibernated sessions (no wake); pin stored for wake', async () => {
    const session = new Session({ prompt: 'x', resume: 'claude_cold2', silent: true, hibernateOnStart: true })
    lastSpawnArgs = null
    session.restartForModelChange()
    expect(lastSpawnArgs).toBeNull() // still asleep
    const r = await session.setSessionModel('claude-sonnet-5')
    expect(r.ok).toBe(true)
    expect(lastSpawnArgs).toBeNull() // pin stored, still asleep
    session.sendMessage('wake')
    const i = lastSpawnArgs!.args.indexOf('--model')
    expect(lastSpawnArgs!.args[i + 1]).toBe('claude-sonnet-5') // pin applied at wake
  })
})
