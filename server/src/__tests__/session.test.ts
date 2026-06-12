import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Session } from '../session.js'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
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
    // Every agent defaults to the newest model tier (overridable via CLAUDE_MODEL)
    expect(lastSpawnArgs!.args).toContain('--model')
    expect(lastSpawnArgs!.args).toContain('claude-fable-5')
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
