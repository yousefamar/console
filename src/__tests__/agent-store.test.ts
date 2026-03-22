import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAgentStore } from '@/store/agent'

// Mock document for keybindings (not used here but may be imported transitively)
vi.stubGlobal('document', {
  documentElement: {
    classList: { toggle: vi.fn() },
  },
  querySelector: vi.fn(),
})

// --------------------------------------------------------------------------
// Mock WebSocket
// --------------------------------------------------------------------------

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3

  readyState = MockWebSocket.OPEN
  url: string
  sentMessages: string[] = []

  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
    // Simulate async connection
    setTimeout(() => this.onopen?.(), 0)
  }

  send(data: string) {
    this.sentMessages.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  // Test helper: simulate receiving a message from hub
  receiveMessage(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  static reset() {
    MockWebSocket.instances = []
  }

  static latest(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1]
  }
}

vi.stubGlobal('WebSocket', MockWebSocket)

// --------------------------------------------------------------------------
// Reset store between tests
// --------------------------------------------------------------------------

beforeEach(() => {
  // Disconnect any existing connection (resets module-level ws variable)
  useAgentStore.getState().disconnect()
  MockWebSocket.reset()
  useAgentStore.setState({
    connected: false,
    connecting: false,
    hubUrl: 'ws://localhost:9877',
    projectDirs: [],
    sessions: [],
    activeSessionId: null,
    pastSessions: [],
    messagesBySession: {},
    pendingTextBySession: {},
    pendingThinkingBySession: {},
    pendingPrompt: null,
    pendingApproval: null,
    sessionSlashCommands: [],
  })
})

// Flush microtasks (WebSocket onopen fires via setTimeout)
const flush = () => new Promise((r) => setTimeout(r, 10))

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('connection', () => {
  it('connects to the hub WebSocket', async () => {
    useAgentStore.getState().connect()
    expect(useAgentStore.getState().connecting).toBe(true)

    await flush()
    expect(useAgentStore.getState().connected).toBe(true)
    expect(useAgentStore.getState().connecting).toBe(false)
  })

  it('does not send list_sessions on connect (hub pushes it)', async () => {
    useAgentStore.getState().connect()
    await flush()

    const ws = MockWebSocket.latest()!
    expect(ws.sentMessages.length).toBe(0)
  })

  it('sets connected=false on close', async () => {
    useAgentStore.getState().connect()
    await flush()
    expect(useAgentStore.getState().connected).toBe(true)

    const ws = MockWebSocket.latest()!
    ws.close()
    expect(useAgentStore.getState().connected).toBe(false)
  })

  it('disconnect prevents reconnection', async () => {
    useAgentStore.getState().connect()
    await flush()

    useAgentStore.getState().disconnect()
    expect(useAgentStore.getState().connected).toBe(false)
  })
})

describe('session management', () => {
  it('createSession sends create_session message', async () => {
    useAgentStore.getState().connect()
    await flush()

    useAgentStore.getState().createSession('Fix the bug')
    const ws = MockWebSocket.latest()!
    const msgs = ws.sentMessages.map((m) => JSON.parse(m))
    const createMsg = msgs.find((m: Record<string, unknown>) => m.type === 'create_session')
    expect(createMsg).toEqual({
      type: 'create_session',
      prompt: 'Fix the bug',
    })
  })

  it('handles session_created from hub', async () => {
    useAgentStore.getState().connect()
    await flush()

    // Simulate user initiating session creation
    useAgentStore.setState({ pendingSessionActivate: true })

    const ws = MockWebSocket.latest()!
    ws.receiveMessage({ type: 'session_created', sessionId: 'sess_1' })

    const state = useAgentStore.getState()
    expect(state.activeSessionId).toBe('sess_1')
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]!.id).toBe('sess_1')
  })

  it('handles sessions_list from hub', async () => {
    useAgentStore.getState().connect()
    await flush()

    const ws = MockWebSocket.latest()!
    ws.receiveMessage({
      type: 'sessions_list',
      sessions: [
        { id: 's1', status: 'idle', createdAt: 1000, prompt: 'test', totalCost: 0.01, totalTokens: { input: 100, output: 50 } },
        { id: 's2', status: 'running', createdAt: 2000, prompt: 'test2', totalCost: 0, totalTokens: { input: 0, output: 0 } },
      ],
    })

    expect(useAgentStore.getState().sessions).toHaveLength(2)
    expect(useAgentStore.getState().sessions[0]!.id).toBe('s1')
  })

  it('selectSession changes active session', async () => {
    useAgentStore.setState({
      sessions: [
        { id: 's1', status: 'idle', createdAt: 1000, prompt: 'a', totalCost: 0, totalTokens: { input: 0, output: 0 }, contextWindow: 200_000, contextUsed: 0 },
        { id: 's2', status: 'idle', createdAt: 2000, prompt: 'b', totalCost: 0, totalTokens: { input: 0, output: 0 }, contextWindow: 200_000, contextUsed: 0 },
      ],
      activeSessionId: 's1',
    })

    useAgentStore.getState().selectSession('s2')
    expect(useAgentStore.getState().activeSessionId).toBe('s2')
  })
})

describe('message handling', () => {
  async function setupSession() {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!
    useAgentStore.setState({ pendingSessionActivate: true })
    ws.receiveMessage({ type: 'session_created', sessionId: 'sess_1' })
    return ws
  }

  it('handles text messages', async () => {
    const ws = await setupSession()
    ws.receiveMessage({ type: 'text', sessionId: 'sess_1', content: 'Hello world' })

    const msgs = useAgentStore.getState().messagesBySession['sess_1']!
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.block).toEqual({ type: 'text', content: 'Hello world' })
  })

  it('handles thinking messages', async () => {
    const ws = await setupSession()
    ws.receiveMessage({ type: 'thinking', sessionId: 'sess_1', content: 'Let me think...' })

    const msgs = useAgentStore.getState().messagesBySession['sess_1']!
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.block.type).toBe('thinking')
    if (msgs[0]!.block.type === 'thinking') {
      expect(msgs[0]!.block.content).toBe('Let me think...')
      expect(msgs[0]!.block.collapsed).toBe(true)
    }
  })

  it('handles tool_use messages', async () => {
    const ws = await setupSession()
    ws.receiveMessage({
      type: 'tool_use',
      sessionId: 'sess_1',
      toolUseId: 'tu_1',
      toolName: 'Read',
      input: { file_path: '/src/App.tsx' },
    })

    const msgs = useAgentStore.getState().messagesBySession['sess_1']!
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.block.type).toBe('tool_use')
  })

  it('handles tool_result messages', async () => {
    const ws = await setupSession()
    ws.receiveMessage({
      type: 'tool_result',
      sessionId: 'sess_1',
      toolUseId: 'tu_1',
      content: 'file contents here',
      isError: false,
    })

    const msgs = useAgentStore.getState().messagesBySession['sess_1']!
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.block.type).toBe('tool_result')
    if (msgs[0]!.block.type === 'tool_result') {
      expect(msgs[0]!.block.isError).toBe(false)
    }
  })

  it('handles error messages', async () => {
    const ws = await setupSession()
    ws.receiveMessage({ type: 'error', sessionId: 'sess_1', message: 'Something broke' })

    const msgs = useAgentStore.getState().messagesBySession['sess_1']!
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.block.type).toBe('error')
  })

  it('handles result messages and updates cost/tokens', async () => {
    const ws = await setupSession()

    ws.receiveMessage({
      type: 'result',
      sessionId: 'sess_1',
      cost: 0.05,
      tokens: { input: 1000, output: 500 },
      duration: 15000,
      sessionIdClaude: 'claude_sess_1',
    })

    const state = useAgentStore.getState()
    const session = state.sessions.find((s) => s.id === 'sess_1')
    expect(session?.status).toBe('idle')
    expect(session?.totalCost).toBe(0.05)

    const msgs = state.messagesBySession['sess_1']!
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.block.type).toBe('result')
  })

  it('handles session_ended', async () => {
    const ws = await setupSession()
    ws.receiveMessage({ type: 'session_ended', sessionId: 'sess_1' })

    const session = useAgentStore.getState().sessions.find((s) => s.id === 'sess_1')
    expect(session?.status).toBe('ended')
  })

  it('accumulates text deltas', async () => {
    const ws = await setupSession()
    ws.receiveMessage({ type: 'text_delta', sessionId: 'sess_1', content: 'Hello ' })
    ws.receiveMessage({ type: 'text_delta', sessionId: 'sess_1', content: 'world' })

    expect(useAgentStore.getState().pendingTextBySession['sess_1']).toBe('Hello world')
  })

  it('flushes pending text on full text message', async () => {
    const ws = await setupSession()
    useAgentStore.setState({ pendingTextBySession: { sess_1: 'partial text' } })

    ws.receiveMessage({ type: 'text', sessionId: 'sess_1', content: 'Full message' })

    const state = useAgentStore.getState()
    expect(state.pendingTextBySession['sess_1'] ?? '').toBe('')
    // Should have flushed partial + added full
    const msgs = state.messagesBySession['sess_1']!
    expect(msgs).toHaveLength(2)
    expect(msgs[0]!.block).toEqual({ type: 'text', content: 'partial text' })
    expect(msgs[1]!.block).toEqual({ type: 'text', content: 'Full message' })
  })

  it('accumulates thinking deltas', async () => {
    const ws = await setupSession()
    ws.receiveMessage({ type: 'thinking_delta', sessionId: 'sess_1', content: 'Let me ' })
    ws.receiveMessage({ type: 'thinking_delta', sessionId: 'sess_1', content: 'think' })

    expect(useAgentStore.getState().pendingThinkingBySession['sess_1']).toBe('Let me think')
  })
})

describe('tool approvals', () => {
  async function setupSession() {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!
    useAgentStore.setState({ pendingSessionActivate: true })
    ws.receiveMessage({ type: 'session_created', sessionId: 'sess_1' })
    return ws
  }

  it('handles approval_required', async () => {
    const ws = await setupSession()
    ws.receiveMessage({
      type: 'approval_required',
      sessionId: 'sess_1',
      requestId: 'req_1',
      toolName: 'Bash',
      input: { command: 'rm -rf /tmp/test' },
    })

    const approval = useAgentStore.getState().pendingApproval
    expect(approval).toEqual({
      sessionId: 'sess_1',
      requestId: 'req_1',
      toolName: 'Bash',
      input: { command: 'rm -rf /tmp/test' },
    })
  })

  it('approveTool sends approve_tool message', async () => {
    const ws = await setupSession()
    useAgentStore.setState({
      pendingApproval: { requestId: 'req_1', toolName: 'Bash', input: {} },
    })

    useAgentStore.getState().approveTool('req_1')

    const msgs = ws.sentMessages.map((m) => JSON.parse(m))
    const approveMsg = msgs.find((m: Record<string, unknown>) => m.type === 'approve_tool')
    expect(approveMsg).toEqual({
      type: 'approve_tool',
      sessionId: 'sess_1',
      requestId: 'req_1',
    })
    expect(useAgentStore.getState().pendingApproval).toBeNull()
  })

  it('denyTool sends deny_tool message', async () => {
    const ws = await setupSession()
    useAgentStore.setState({
      pendingApproval: { requestId: 'req_1', toolName: 'Bash', input: {} },
    })

    useAgentStore.getState().denyTool('req_1', 'Not safe')

    const msgs = ws.sentMessages.map((m) => JSON.parse(m))
    const denyMsg = msgs.find((m: Record<string, unknown>) => m.type === 'deny_tool')
    expect(denyMsg).toEqual({
      type: 'deny_tool',
      sessionId: 'sess_1',
      requestId: 'req_1',
      reason: 'Not safe',
    })
    expect(useAgentStore.getState().pendingApproval).toBeNull()
  })

  it('autoApproveTool auto-approves current and future', async () => {
    const ws = await setupSession()
    useAgentStore.setState({
      pendingApproval: { requestId: 'req_1', toolName: 'Read', input: {} },
    })

    useAgentStore.getState().autoApproveTool('Read')

    // Should have auto-approved the pending one
    const msgs = ws.sentMessages.map((m) => JSON.parse(m))
    const approveMsg = msgs.find((m: Record<string, unknown>) => m.type === 'approve_tool')
    expect(approveMsg).toBeTruthy()
    expect(useAgentStore.getState().pendingApproval).toBeNull()

    // Future Read approvals should be auto-approved
    ws.receiveMessage({
      type: 'approval_required',
      sessionId: 'sess_1',
      requestId: 'req_2',
      toolName: 'Read',
      input: { file_path: '/foo' },
    })

    // Should NOT have a pending approval (auto-approved)
    expect(useAgentStore.getState().pendingApproval).toBeNull()
    const approveMsg2 = ws.sentMessages
      .map((m) => JSON.parse(m))
      .filter((m: Record<string, unknown>) => m.type === 'approve_tool')
    expect(approveMsg2).toHaveLength(2)
  })
})

describe('user actions', () => {
  async function setupSession() {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!
    useAgentStore.setState({ pendingSessionActivate: true })
    ws.receiveMessage({ type: 'session_created', sessionId: 'sess_1' })
    return ws
  }

  it('sendMessage sends message and adds user prompt', async () => {
    const ws = await setupSession()
    useAgentStore.getState().sendMessage('Do something')

    const msgs = ws.sentMessages.map((m) => JSON.parse(m))
    const sendMsg = msgs.find((m: Record<string, unknown>) => m.type === 'send_message')
    expect(sendMsg).toEqual({
      type: 'send_message',
      sessionId: 'sess_1',
      content: 'Do something',
    })

    const agentMsgs = useAgentStore.getState().messagesBySession['sess_1']!
    expect(agentMsgs.some((m) => m.block.type === 'user_prompt')).toBe(true)
  })

  it('interrupt sends interrupt message', async () => {
    const ws = await setupSession()
    useAgentStore.getState().interrupt()

    const msgs = ws.sentMessages.map((m) => JSON.parse(m))
    const interruptMsg = msgs.find((m: Record<string, unknown>) => m.type === 'interrupt')
    expect(interruptMsg).toEqual({
      type: 'interrupt',
      sessionId: 'sess_1',
    })
  })
})

describe('toggleThinkingCollapsed', () => {
  it('toggles thinking block collapsed state', async () => {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!
    useAgentStore.setState({ pendingSessionActivate: true })
    ws.receiveMessage({ type: 'session_created', sessionId: 'sess_1' })
    ws.receiveMessage({ type: 'thinking', sessionId: 'sess_1', content: 'hmm' })

    const msgs = useAgentStore.getState().messagesBySession['sess_1']!
    const thinkingMsg = msgs[0]!
    expect(thinkingMsg.block.type).toBe('thinking')
    if (thinkingMsg.block.type === 'thinking') {
      expect(thinkingMsg.block.collapsed).toBe(true)
    }

    useAgentStore.getState().toggleThinkingCollapsed(thinkingMsg.id)

    const updated = useAgentStore.getState().messagesBySession['sess_1']![0]!
    if (updated.block.type === 'thinking') {
      expect(updated.block.collapsed).toBe(false)
    }
  })
})

describe('killSession', () => {
  it('sends kill_session message with sessionId', async () => {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!
    useAgentStore.setState({ pendingSessionActivate: true })
    ws.receiveMessage({ type: 'session_created', sessionId: 'sess_1' })

    useAgentStore.getState().killSession('sess_1')

    const msgs = ws.sentMessages.map((m) => JSON.parse(m))
    const killMsg = msgs.find((m: Record<string, unknown>) => m.type === 'kill_session')
    expect(killMsg).toEqual({
      type: 'kill_session',
      sessionId: 'sess_1',
    })
  })
})

describe('resumeSession', () => {
  it('sends resume_session message with claudeSessionId, prompt, and cwd', async () => {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!

    useAgentStore.getState().resumeSession('claude_abc123', 'Continue working', '/home/amar/proj')

    const msgs = ws.sentMessages.map((m) => JSON.parse(m))
    const resumeMsg = msgs.find((m: Record<string, unknown>) => m.type === 'resume_session')
    expect(resumeMsg).toEqual({
      type: 'resume_session',
      sessionId: 'claude_abc123',
      prompt: 'Continue working',
      cwd: '/home/amar/proj',
    })
  })

  it('sends resume message and clears pending state', async () => {
    useAgentStore.getState().connect()
    await flush()

    useAgentStore.getState().resumeSession('claude_abc123', 'Continue')

    const state = useAgentStore.getState()
    expect(state.pendingPrompt).toBe('Continue')
    expect(state.pendingTextBySession).toEqual({})
    expect(state.pendingThinkingBySession).toEqual({})
  })
})

describe('listPastSessions', () => {
  it('sends list_past_sessions message with cwd', async () => {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!

    useAgentStore.getState().listPastSessions('/home/amar/proj/code/console')

    const msgs = ws.sentMessages.map((m) => JSON.parse(m))
    const listMsg = msgs.find((m: Record<string, unknown>) => m.type === 'list_past_sessions')
    expect(listMsg).toEqual({
      type: 'list_past_sessions',
      cwd: '/home/amar/proj/code/console',
    })
  })
})

describe('past_sessions message handling', () => {
  it('updates pastSessions in store', async () => {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!

    ws.receiveMessage({
      type: 'past_sessions',
      sessions: [
        { sessionId: 'ps_1', prompt: 'Fix the bug', date: 1000 },
        { sessionId: 'ps_2', prompt: 'Add tests', date: 2000 },
      ],
    })

    const state = useAgentStore.getState()
    expect(state.pastSessions).toHaveLength(2)
    expect(state.pastSessions[0]!.sessionId).toBe('ps_1')
    expect(state.pastSessions[0]!.prompt).toBe('Fix the bug')
    expect(state.pastSessions[1]!.sessionId).toBe('ps_2')
  })
})

describe('session_init message handling', () => {
  it('sets per-session model/context and global slashCommands', async () => {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!
    useAgentStore.setState({ pendingSessionActivate: true })
    ws.receiveMessage({ type: 'session_created', sessionId: 'sess_1' })

    ws.receiveMessage({
      type: 'session_init',
      sessionId: 'sess_1',
      claudeSessionId: 'claude_xyz',
      model: 'opus 4.6 [1M]',
      slashCommands: ['/help', '/clear'],
      contextWindow: 1_000_000,
    })

    const state = useAgentStore.getState()
    const session = state.sessions.find((s) => s.id === 'sess_1')
    expect(session?.model).toBe('opus 4.6 [1M]')
    expect(session?.contextWindow).toBe(1_000_000)
    expect(session?.contextUsed).toBe(0)
    expect(state.sessionSlashCommands).toEqual(['/help', '/clear'])
  })

  it('sends list_sessions to refresh after session_init', async () => {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!
    useAgentStore.setState({ pendingSessionActivate: true })
    ws.receiveMessage({ type: 'session_created', sessionId: 'sess_1' })

    // Clear sent messages to isolate the list_sessions from session_init
    ws.sentMessages.length = 0

    ws.receiveMessage({
      type: 'session_init',
      sessionId: 'sess_1',
      claudeSessionId: 'claude_xyz',
      model: 'opus 4.6',
      slashCommands: [],
      contextWindow: 200_000,
    })

    const msgs = ws.sentMessages.map((m) => JSON.parse(m))
    expect(msgs).toContainEqual({ type: 'list_sessions' })
  })
})

describe('context_update message handling', () => {
  it('updates per-session contextUsed and contextWindow', async () => {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!
    useAgentStore.setState({ pendingSessionActivate: true })
    ws.receiveMessage({ type: 'session_created', sessionId: 'sess_1' })

    ws.receiveMessage({
      type: 'context_update',
      sessionId: 'sess_1',
      used: 50_000,
      total: 1_000_000,
    })

    const session = useAgentStore.getState().sessions.find((s) => s.id === 'sess_1')
    expect(session?.contextUsed).toBe(50_000)
    expect(session?.contextWindow).toBe(1_000_000)
  })
})

describe('project_dirs message handling', () => {
  it('updates projectDirs in store', async () => {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!

    ws.receiveMessage({
      type: 'project_dirs',
      dirs: ['/home/amar/proj/code/console', '/home/amar/proj/code/other'],
    })

    const state = useAgentStore.getState()
    expect(state.projectDirs).toEqual([
      '/home/amar/proj/code/console',
      '/home/amar/proj/code/other',
    ])
  })
})

describe('status updates', () => {
  it('updates per-session statusText on status message', async () => {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!
    useAgentStore.setState({ pendingSessionActivate: true })
    ws.receiveMessage({ type: 'session_created', sessionId: 'sess_1' })

    ws.receiveMessage({ type: 'status', sessionId: 'sess_1', text: 'Reading file...' })
    const session = useAgentStore.getState().sessions.find((s) => s.id === 'sess_1')
    expect(session?.statusText).toBe('Reading file...')
  })

  it('clears status on result', async () => {
    useAgentStore.getState().connect()
    await flush()
    const ws = MockWebSocket.latest()!
    useAgentStore.setState({ pendingSessionActivate: true })
    ws.receiveMessage({ type: 'session_created', sessionId: 'sess_1' })

    ws.receiveMessage({
      type: 'result',
      sessionId: 'sess_1',
      cost: 0,
      tokens: { input: 0, output: 0 },
      duration: 0,
      sessionIdClaude: 'x',
    })

    const session = useAgentStore.getState().sessions.find((s) => s.id === 'sess_1')
    expect(session?.statusText).toBeUndefined()
    expect(session?.status).toBe('idle')
  })
})
