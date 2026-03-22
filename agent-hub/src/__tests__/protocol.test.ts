import { describe, it, expect } from 'vitest'
import type {
  ClientMessage,
  HubMessage,
  ClaudeStdoutMessage,
  ClaudeStdinMessage,
  ClaudeContentBlock,
  SessionInfo,
  TokenUsage,
  PastSession,
} from '../protocol.js'

// --------------------------------------------------------------------------
// These tests validate the protocol types by constructing valid instances
// and verifying their shape. Since TypeScript types are erased at runtime,
// we test that the protocol shapes match expectations.
// --------------------------------------------------------------------------

describe('ClientMessage protocol', () => {
  it('create_session has correct shape', () => {
    const msg: ClientMessage = {
      type: 'create_session',
      prompt: 'Fix the bug in auth.ts',
      cwd: '/home/user/project',
    }
    expect(msg.type).toBe('create_session')
    expect(msg.prompt).toBe('Fix the bug in auth.ts')
    expect(msg.cwd).toBe('/home/user/project')
  })

  it('send_message has correct shape', () => {
    const msg: ClientMessage = {
      type: 'send_message',
      sessionId: 'sess_1',
      content: 'Now do the other thing',
    }
    expect(msg.type).toBe('send_message')
  })

  it('approve_tool has correct shape', () => {
    const msg: ClientMessage = {
      type: 'approve_tool',
      sessionId: 'sess_1',
      requestId: 'req_1',
      modifiedInput: { command: 'ls -la' },
    }
    expect(msg.type).toBe('approve_tool')
  })

  it('deny_tool has correct shape', () => {
    const msg: ClientMessage = {
      type: 'deny_tool',
      sessionId: 'sess_1',
      requestId: 'req_1',
      reason: 'Too dangerous',
    }
    expect(msg.type).toBe('deny_tool')
  })

  it('interrupt has correct shape', () => {
    const msg: ClientMessage = { type: 'interrupt', sessionId: 'sess_1' }
    expect(msg.type).toBe('interrupt')
  })

  it('list_sessions has correct shape', () => {
    const msg: ClientMessage = { type: 'list_sessions' }
    expect(msg.type).toBe('list_sessions')
  })

  it('resume_session has correct shape', () => {
    const msg: ClientMessage = {
      type: 'resume_session',
      sessionId: 'old_session_1',
      prompt: 'Continue where we left off',
      cwd: '/home/user/project',
    }
    expect(msg.type).toBe('resume_session')
    expect(msg.cwd).toBe('/home/user/project')
  })

  it('list_past_sessions has correct shape', () => {
    const msg: ClientMessage = {
      type: 'list_past_sessions',
      cwd: '/home/user/project',
    }
    expect(msg.type).toBe('list_past_sessions')
    expect(msg.cwd).toBe('/home/user/project')
  })
})

describe('HubMessage protocol', () => {
  it('session_created', () => {
    const msg: HubMessage = { type: 'session_created', sessionId: 'sess_1', cwd: '/tmp', prompt: 'hello' }
    expect(msg.type).toBe('session_created')
  })

  it('text with content', () => {
    const msg: HubMessage = { type: 'text', sessionId: 'sess_1', content: 'Hello world' }
    expect(msg.type).toBe('text')
  })

  it('text_delta with content', () => {
    const msg: HubMessage = { type: 'text_delta', sessionId: 'sess_1', content: 'chunk' }
    expect(msg.type).toBe('text_delta')
  })

  it('thinking', () => {
    const msg: HubMessage = { type: 'thinking', sessionId: 'sess_1', content: 'reasoning...' }
    expect(msg.type).toBe('thinking')
  })

  it('tool_use', () => {
    const msg: HubMessage = {
      type: 'tool_use',
      sessionId: 'sess_1',
      toolUseId: 'tu_1',
      toolName: 'Bash',
      input: { command: 'npm test' },
    }
    expect(msg.type).toBe('tool_use')
  })

  it('tool_result', () => {
    const msg: HubMessage = {
      type: 'tool_result',
      sessionId: 'sess_1',
      toolUseId: 'tu_1',
      content: 'All tests passed',
      isError: false,
    }
    expect(msg.type).toBe('tool_result')
  })

  it('approval_required', () => {
    const msg: HubMessage = {
      type: 'approval_required',
      sessionId: 'sess_1',
      requestId: 'req_1',
      toolName: 'Bash',
      input: { command: 'rm -rf /tmp/test' },
    }
    expect(msg.type).toBe('approval_required')
  })

  it('result with full token usage', () => {
    const msg: HubMessage = {
      type: 'result',
      sessionId: 'sess_1',
      cost: 0.1234,
      tokens: { input: 5000, output: 2000, cacheRead: 1000, cacheCreation: 500 },
      duration: 30000,
      sessionIdClaude: 'claude_abc123',
    }
    expect(msg.type).toBe('result')
    if (msg.type === 'result') {
      expect(msg.tokens.cacheRead).toBe(1000)
    }
  })

  it('error', () => {
    const msg: HubMessage = { type: 'error', sessionId: 'sess_1', message: 'Something went wrong' }
    expect(msg.type).toBe('error')
  })

  it('session_ended', () => {
    const msg: HubMessage = { type: 'session_ended', sessionId: 'sess_1' }
    expect(msg.type).toBe('session_ended')
  })

  it('past_sessions', () => {
    const msg: HubMessage = {
      type: 'past_sessions',
      sessions: [
        { sessionId: 'abc-123', prompt: 'Fix the bug', date: 1710000000000 },
      ],
    }
    expect(msg.type).toBe('past_sessions')
    if (msg.type === 'past_sessions') {
      expect(msg.sessions).toHaveLength(1)
      expect(msg.sessions[0].sessionId).toBe('abc-123')
    }
  })

  it('hub_error', () => {
    const msg: HubMessage = { type: 'hub_error', message: 'Invalid JSON' }
    expect(msg.type).toBe('hub_error')
  })
})

describe('PastSession', () => {
  it('has all required fields', () => {
    const ps: PastSession = {
      sessionId: 'abc-123-def',
      prompt: 'Fix the authentication bug',
      date: Date.now(),
    }
    expect(ps.sessionId).toBe('abc-123-def')
    expect(ps.prompt).toBe('Fix the authentication bug')
    expect(ps.date).toBeGreaterThan(0)
  })
})

describe('Claude CLI protocol types', () => {
  it('system init message', () => {
    const msg: ClaudeStdoutMessage = {
      type: 'system',
      subtype: 'init',
      session_id: 'abc123',
      tools: ['Read', 'Edit', 'Bash'],
      model: 'claude-opus-4-6',
    }
    expect(msg.type).toBe('system')
  })

  it('assistant message with text and tool_use', () => {
    const content: ClaudeContentBlock[] = [
      { type: 'text', text: "I'll read the file" },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/src/App.tsx' } },
    ]
    const msg: ClaudeStdoutMessage = {
      type: 'assistant',
      message: { role: 'assistant', content },
    }
    expect(msg.type).toBe('assistant')
  })

  it('assistant message with thinking block', () => {
    const content: ClaudeContentBlock[] = [
      { type: 'thinking', thinking: 'Let me analyze this...', signature: 'sig123' },
      { type: 'text', text: 'Here is my analysis' },
    ]
    const msg: ClaudeStdoutMessage = {
      type: 'assistant',
      message: { role: 'assistant', content },
    }
    expect(msg.type).toBe('assistant')
  })

  it('user message with tool_result', () => {
    const content: ClaudeContentBlock[] = [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents', is_error: false },
    ]
    const msg: ClaudeStdoutMessage = {
      type: 'user',
      message: { role: 'user', content },
    }
    expect(msg.type).toBe('user')
  })

  it('result message', () => {
    const msg: ClaudeStdoutMessage = {
      type: 'result',
      subtype: 'success',
      duration_ms: 15000,
      session_id: 'abc123',
      total_cost_usd: 0.0567,
      usage: {
        input_tokens: 3000,
        output_tokens: 1500,
        cache_read_input_tokens: 500,
      },
    }
    expect(msg.type).toBe('result')
  })

  it('control_request for tool approval', () => {
    const msg: ClaudeStdoutMessage = {
      type: 'control_request',
      id: 'req_1',
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'npm test' },
    }
    expect(msg.type).toBe('control_request')
  })

  it('stream_event with text delta', () => {
    const msg: ClaudeStdoutMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
    }
    expect(msg.type).toBe('stream_event')
  })

  it('stdin user message', () => {
    const msg: ClaudeStdinMessage = {
      type: 'user',
      message: { role: 'user', content: 'Fix the bug' },
    }
    expect(msg.type).toBe('user')
  })

  it('stdin control_response allow', () => {
    const msg: ClaudeStdinMessage = {
      type: 'control_response',
      id: 'req_1',
      permission: { behavior: 'allow', updated_input: { command: 'ls' } },
    }
    expect(msg.type).toBe('control_response')
  })

  it('stdin control_response deny', () => {
    const msg: ClaudeStdinMessage = {
      type: 'control_response',
      id: 'req_1',
      permission: { behavior: 'deny', message: 'Not allowed' },
    }
    expect(msg.type).toBe('control_response')
  })
})

describe('SessionInfo', () => {
  it('has all required fields', () => {
    const info: SessionInfo = {
      id: 'sess_1',
      claudeSessionId: 'claude_abc',
      status: 'running',
      createdAt: Date.now(),
      prompt: 'Fix the bug',
      totalCost: 0.05,
      totalTokens: { input: 1000, output: 500 },
    }
    expect(info.status).toBe('running')
    expect(info.totalCost).toBe(0.05)
  })
})

describe('TokenUsage', () => {
  it('required fields only', () => {
    const usage: TokenUsage = { input: 100, output: 50 }
    expect(usage.input).toBe(100)
    expect(usage.cacheRead).toBeUndefined()
  })

  it('with optional cache fields', () => {
    const usage: TokenUsage = { input: 100, output: 50, cacheRead: 30, cacheCreation: 10 }
    expect(usage.cacheRead).toBe(30)
    expect(usage.cacheCreation).toBe(10)
  })
})
