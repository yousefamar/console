import { create } from 'zustand'

// ============================================================================
// Agent Store — manages WebSocket connection to the Console Agent Hub,
// session state, message streams, and tool approval flow.
// ============================================================================

const DEFAULT_HUB_URL = 'ws://localhost:9877'
const RECONNECT_DELAY_MS = 3000

function getHubUrl(): string {
  try {
    return localStorage.getItem('console-server-url') || DEFAULT_HUB_URL
  } catch {
    return DEFAULT_HUB_URL
  }
}

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface AgentMessage {
  id: string
  timestamp: number
  block:
    | { type: 'text'; content: string }
    | { type: 'thinking'; content: string; collapsed: boolean }
    | { type: 'tool_use'; toolUseId: string; toolName: string; input: Record<string, unknown> }
    | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
    | { type: 'user_prompt'; content: string; images?: string[] }
    | { type: 'status'; text: string }
    | { type: 'error'; message: string }
    | { type: 'result'; cost: number; tokens: TokenUsage; duration: number }
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead?: number
  cacheCreation?: number
}

export interface PendingApproval {
  sessionId: string
  requestId: string
  toolName: string
  input: Record<string, unknown>
}

export interface SessionInfo {
  id: string
  claudeSessionId?: string
  status: 'running' | 'idle' | 'ended'
  createdAt: number
  prompt: string
  cwd?: string
  totalCost: number
  totalTokens: TokenUsage
  model?: string
  contextWindow: number
  contextUsed: number
  statusText?: string
  isAl?: boolean
}

export interface PastSession {
  sessionId: string
  prompt: string
  date: number
}

// Auto-approve rules: tools that don't need confirmation
const AUTO_APPROVE_TOOLS = new Set<string>()

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

interface AgentState {
  // Connection
  connected: boolean
  connecting: boolean
  hubUrl: string

  // Project directories (discovered from ~/.claude/projects/)
  projectDirs: string[]

  // Sessions
  sessions: SessionInfo[]
  activeSessionId: string | null

  // Past sessions (from Claude's own JSONL files)
  pastSessions: PastSession[]

  // True when user intentionally deselected to create a new session (prevents auto-select)
  creatingNewSession: boolean

  // Messages per session
  messagesBySession: Record<string, AgentMessage[]>

  // Streaming accumulators (for deltas) — per session
  pendingTextBySession: Record<string, string>
  pendingThinkingBySession: Record<string, string>

  // Pending prompt (for showing user message when session_created arrives)
  pendingPrompt: string | null
  // True when a createSession/resumeSession request is in-flight (session_created should activate)
  pendingSessionActivate: boolean

  // Pending tool approval
  pendingApproval: PendingApproval | null

  // Slash commands (from session init, shared across sessions)
  sessionSlashCommands: string[]

  // Actions
  connect: () => void
  disconnect: () => void
  createSession: (prompt: string, cwd?: string, images?: Array<{ media_type: string; data: string }>) => void
  sendMessage: (content: string, images?: Array<{ media_type: string; data: string }>) => void
  approveTool: (requestId: string, modifiedInput?: Record<string, unknown>) => void
  denyTool: (requestId: string, reason?: string) => void
  autoApproveTool: (toolName: string) => void
  interrupt: () => void
  killSession: (sessionId: string) => void
  selectSession: (sessionId: string | null) => void
  selectNextSession: () => void
  selectPrevSession: () => void
  listSessions: () => void
  toggleThinkingCollapsed: (messageId: string) => void
  resumeSession: (claudeSessionId: string, prompt: string, cwd?: string) => void
  listPastSessions: (cwd: string) => void
  setHubUrl: (url: string) => void
}

// Internal refs (not in Zustand — avoids serialization issues)
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let disconnectedManually = false
let messageIdCounter = 0

function nextId(): string {
  return `msg_${++messageIdCounter}_${Date.now()}`
}

export const useAgentStore = create<AgentState>((set, get) => ({
  connected: false,
  connecting: false,
  hubUrl: getHubUrl(),

  projectDirs: [],

  sessions: [],
  activeSessionId: null,

  pastSessions: [],

  creatingNewSession: false,

  messagesBySession: {},

  pendingTextBySession: {},
  pendingThinkingBySession: {},

  pendingPrompt: null,
  pendingSessionActivate: false,

  pendingApproval: null,

  sessionSlashCommands: [],

  connect: () => {
    if (ws && ws.readyState === WebSocket.OPEN) return
    if (get().connecting) return

    set({ connecting: true })
    reconnectAttempts = 0
    disconnectedManually = false
    doConnect()
  },

  disconnect: () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    disconnectedManually = true
    if (ws) {
      ws.close()
      ws = null
    }
    set({ connected: false, connecting: false })
  },

  createSession: (prompt, cwd, images) => {
    sendWs({
      type: 'create_session',
      prompt,
      ...(cwd ? { cwd } : {}),
      ...(images?.length ? { images } : {}),
    })
    set({
      pendingPrompt: prompt,
      pendingSessionActivate: true,
      pendingApproval: null,
      creatingNewSession: false,
    })
  },

  sendMessage: (content, images) => {
    const sessionId = get().activeSessionId
    if (!sessionId) return

    sendWs({ type: 'send_message', sessionId, content, ...(images?.length ? { images } : {}) })

    // Add user message to stream (with data-URL previews for images)
    const imagePreviews = images?.map((img) => `data:${img.media_type};base64,${img.data}`)
    addMessage(sessionId, {
      type: 'user_prompt',
      content,
      ...(imagePreviews?.length ? { images: imagePreviews } : {}),
    })
    updateSession(sessionId, { status: 'running' })
  },

  approveTool: (requestId, modifiedInput) => {
    const approval = get().pendingApproval
    const sessionId = approval?.sessionId ?? get().activeSessionId
    if (!sessionId) return
    sendWs({ type: 'approve_tool', sessionId, requestId, modifiedInput })
    set({ pendingApproval: null })
  },

  denyTool: (requestId, reason) => {
    const approval = get().pendingApproval
    const sessionId = approval?.sessionId ?? get().activeSessionId
    if (!sessionId) return
    sendWs({ type: 'deny_tool', sessionId, requestId, reason })
    set({ pendingApproval: null })
  },

  autoApproveTool: (toolName) => {
    AUTO_APPROVE_TOOLS.add(toolName)
    // If there's a pending approval for this tool, approve it
    const approval = get().pendingApproval
    if (approval && approval.toolName === toolName) {
      get().approveTool(approval.requestId)
    }
  },

  interrupt: () => {
    const sessionId = get().activeSessionId
    if (!sessionId) return
    sendWs({ type: 'interrupt', sessionId })
  },

  killSession: (sessionId) => {
    sendWs({ type: 'kill_session', sessionId })
  },

  selectSession: (sessionId) => {
    set({ activeSessionId: sessionId, pendingApproval: null, creatingNewSession: sessionId === null })
    // Request history if we have no messages for this session yet
    if (sessionId && !(get().messagesBySession[sessionId]?.length)) {
      sendWs({ type: 'get_session_history', sessionId })
    }
  },

  selectNextSession: () => {
    const { sessions, activeSessionId } = get()
    const active = sortedActiveSessions(sessions)
    if (active.length === 0) return
    const idx = active.findIndex((s) => s.id === activeSessionId)
    const next = active[Math.min(idx + 1, active.length - 1)]
    if (next) set({ activeSessionId: next.id, pendingApproval: null })
  },

  selectPrevSession: () => {
    const { sessions, activeSessionId } = get()
    const active = sortedActiveSessions(sessions)
    if (active.length === 0) return
    const idx = active.findIndex((s) => s.id === activeSessionId)
    const prev = active[Math.max(idx - 1, 0)]
    if (prev) set({ activeSessionId: prev.id, pendingApproval: null })
  },

  listSessions: () => {
    sendWs({ type: 'list_sessions' })
  },

  toggleThinkingCollapsed: (messageId) => {
    set((state) => {
      const sessionId = state.activeSessionId
      if (!sessionId) return state
      const messages = state.messagesBySession[sessionId]
      if (!messages) return state
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: messages.map((m) =>
            m.id === messageId && m.block.type === 'thinking'
              ? { ...m, block: { ...m.block, collapsed: !m.block.collapsed } }
              : m,
          ),
        },
      }
    })
  },

  resumeSession: (claudeSessionId, prompt, cwd) => {
    sendWs({
      type: 'resume_session',
      sessionId: claudeSessionId,
      prompt,
      ...(cwd ? { cwd } : {}),
    })
    set({
      pendingPrompt: prompt,
      pendingSessionActivate: true,
      pendingApproval: null,
    })
  },

  listPastSessions: (cwdPath) => {
    sendWs({ type: 'list_past_sessions', cwd: cwdPath })
  },

  setHubUrl: (url) => {
    try { localStorage.setItem('console-server-url', url) } catch { /* */ }
    // Disconnect and reconnect with new URL
    get().disconnect()
    set({ hubUrl: url })
    get().connect()
  },
}))


// --------------------------------------------------------------------------
// WebSocket management
// --------------------------------------------------------------------------

function doConnect() {
  const url = useAgentStore.getState().hubUrl

  try {
    ws = new WebSocket(url)
  } catch {
    useAgentStore.setState({ connected: false, connecting: false })
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    reconnectAttempts = 0
    useAgentStore.setState({ connected: true, connecting: false })
    // Hub sends sessions_list + message replay on connect automatically
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
      handleHubMessage(msg)
    } catch {
      // Ignore malformed messages
    }
  }

  ws.onclose = () => {
    ws = null
    useAgentStore.setState({ connected: false, connecting: false })
    scheduleReconnect()
  }

  ws.onerror = () => {
    // onclose will fire after this
  }
}

function scheduleReconnect() {
  if (disconnectedManually) return
  if (reconnectTimer) return

  reconnectAttempts++
  // Back off: 3s, 3s, 3s, then 10s after 5 attempts
  const delay = reconnectAttempts > 5 ? 10000 : RECONNECT_DELAY_MS
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    useAgentStore.setState({ connecting: true })
    doConnect()
  }, delay)
}

function sendWs(msg: Record<string, unknown>) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

// --------------------------------------------------------------------------
// Hub message handler
// --------------------------------------------------------------------------

function handleHubMessage(msg: Record<string, unknown>) {
  switch (msg.type) {
    case 'session_created': {
      const sessionId = msg.sessionId as string
      const sessionCwd = (msg.cwd as string) || undefined
      // Use prompt from hub message (available to all clients), fall back to local pending
      const prompt = (msg.prompt as string) || useAgentStore.getState().pendingPrompt || ''
      // Only switch to this session if user requested it (pendingSessionActivate set by createSession/resumeSession)
      const shouldActivate = useAgentStore.getState().pendingSessionActivate
      // Don't add initial prompt here — it comes as a separate user_prompt message from the hub
      useAgentStore.setState((s) => ({
        ...(shouldActivate ? { activeSessionId: sessionId } : {}),
        pendingPrompt: null,
        pendingSessionActivate: false,
        creatingNewSession: false,
        sessions: [...s.sessions, {
          id: sessionId,
          status: 'running' as const,
          createdAt: Date.now(),
          prompt,
          cwd: sessionCwd,
          totalCost: 0,
          totalTokens: { input: 0, output: 0 },
          contextWindow: 200_000,
          contextUsed: 0,
          statusText: 'Starting session...',
        }],
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: s.messagesBySession[sessionId] ?? [],
        },
      }))
      break
    }

    case 'session_init': {
      const sessionId = msg.sessionId as string
      useAgentStore.setState({ sessionSlashCommands: msg.slashCommands as string[] })
      updateSession(sessionId, {
        model: msg.model as string,
        contextWindow: msg.contextWindow as number,
        contextUsed: 0,
      })
      // Refresh session list to pick up claudeSessionId from the hub
      sendWs({ type: 'list_sessions' })
      break
    }

    case 'context_update': {
      const sessionId = msg.sessionId as string
      updateSession(sessionId, {
        contextUsed: msg.used as number,
        contextWindow: msg.total as number,
      })
      break
    }

    case 'project_dirs': {
      const dirs = msg.dirs as string[]
      useAgentStore.setState({ projectDirs: dirs })
      break
    }

    case 'sessions_list': {
      const hubSessions = msg.sessions as SessionInfo[]
      const state = useAgentStore.getState()
      const existing = state.sessions
      const existingMap = new Map(existing.map((s) => [s.id, s]))

      // Build claudeSessionId → old hub ID map for remapping after hub restart
      const claudeToOldId = new Map<string, string>()
      for (const s of existing) {
        if (s.claudeSessionId) claudeToOldId.set(s.claudeSessionId, s.id)
      }

      // Detect ID remaps: hub sessions whose claudeSessionId matches an old session with a different hub ID
      const idRemap = new Map<string, string>() // old hub ID → new hub ID
      for (const s of hubSessions) {
        if (s.claudeSessionId) {
          const oldId = claudeToOldId.get(s.claudeSessionId)
          if (oldId && oldId !== s.id) {
            idRemap.set(oldId, s.id)
          }
        }
      }

      // Merge hub data with local per-session state (model, context, statusText)
      const merged = hubSessions.map((s) => {
        // Mark Al session
        const isAl = s.id === 'al'
        // Try direct match first, then remap match
        const local = existingMap.get(s.id) ?? (s.claudeSessionId ? existingMap.get(claudeToOldId.get(s.claudeSessionId) ?? '') : undefined)
        return local
          ? { ...s, isAl, model: local.model, contextWindow: local.contextWindow ?? 200_000, contextUsed: local.contextUsed ?? 0, statusText: local.statusText }
          : { ...s, isAl, contextWindow: s.contextWindow ?? 200_000, contextUsed: s.contextUsed ?? 0 }
      })

      // Remap messagesBySession keys and delta accumulators if hub restarted (IDs changed)
      let newMessages = state.messagesBySession
      let newPendingText = state.pendingTextBySession
      let newPendingThinking = state.pendingThinkingBySession
      let remappedActiveId = state.activeSessionId
      if (idRemap.size > 0) {
        newMessages = { ...newMessages }
        newPendingText = { ...newPendingText }
        newPendingThinking = { ...newPendingThinking }
        for (const [oldId, newId] of idRemap) {
          if (newMessages[oldId]) { newMessages[newId] = newMessages[oldId]; delete newMessages[oldId] }
          if (newPendingText[oldId]) { newPendingText[newId] = newPendingText[oldId]; delete newPendingText[oldId] }
          if (newPendingThinking[oldId]) { newPendingThinking[newId] = newPendingThinking[oldId]; delete newPendingThinking[oldId] }
          if (remappedActiveId === oldId) remappedActiveId = newId
        }
      }

      // Only include activeSessionId in the update if it actually changed (remap)
      const stateUpdate: Partial<AgentState> = {
        sessions: merged,
        messagesBySession: newMessages,
        pendingTextBySession: newPendingText,
        pendingThinkingBySession: newPendingThinking,
      }
      if (remappedActiveId !== state.activeSessionId) {
        stateUpdate.activeSessionId = remappedActiveId
      }
      useAgentStore.setState(stateUpdate)

      // Auto-select first active session ONLY if no session is selected and user isn't creating a new one
      const currentActiveId = useAgentStore.getState().activeSessionId
      const isCreatingNew = useAgentStore.getState().creatingNewSession
      if (!isCreatingNew && !currentActiveId && merged.length > 0) {
        const firstActive = merged.find((s) => s.status !== 'ended')
        if (firstActive) {
          useAgentStore.getState().selectSession(firstActive.id)
        }
      }
      break
    }

    case 'past_sessions': {
      const pastSessions = msg.sessions as PastSession[]
      useAgentStore.setState({ pastSessions })
      break
    }

    case 'session_history': {
      const sessionId = msg.sessionId as string
      const historyMsgs = (msg.messages as Array<{
        type: string; content?: string; toolUseId?: string;
        toolName?: string; input?: Record<string, unknown>; isError?: boolean; images?: string[]
      }>)
      const blocks: AgentMessage[] = historyMsgs.map((m) => {
        let block: AgentMessage['block']
        switch (m.type) {
          case 'user_prompt':
            block = { type: 'user_prompt', content: m.content ?? '' }
            break
          case 'text':
            block = { type: 'text', content: m.content ?? '' }
            break
          case 'thinking':
            block = { type: 'thinking', content: m.content ?? '', collapsed: true }
            break
          case 'tool_use':
            block = { type: 'tool_use', toolUseId: m.toolUseId ?? '', toolName: m.toolName ?? '', input: m.input ?? {} }
            break
          case 'tool_result':
            block = { type: 'tool_result', toolUseId: m.toolUseId ?? '', content: m.content ?? '', isError: m.isError ?? false }
            break
          default:
            block = { type: 'text', content: m.content ?? '' }
        }
        return { id: nextId(), timestamp: Date.now(), block }
      })
      useAgentStore.setState((s) => ({
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: [...blocks, ...(s.messagesBySession[sessionId] ?? [])],
        },
      }))
      break
    }

    case 'text': {
      const sessionId = msg.sessionId as string
      // Flush any pending text delta
      flushPending(sessionId)
      addMessage(sessionId, {
        type: 'text',
        content: msg.content as string,
      })
      break
    }

    case 'text_delta': {
      const sessionId = msg.sessionId as string
      useAgentStore.setState((s) => ({
        pendingTextBySession: {
          ...s.pendingTextBySession,
          [sessionId]: (s.pendingTextBySession[sessionId] ?? '') + (msg.content as string),
        },
      }))
      break
    }

    case 'thinking': {
      const sessionId = msg.sessionId as string
      flushPending(sessionId)
      addMessage(sessionId, {
        type: 'thinking',
        content: msg.content as string,
        collapsed: true,
      })
      break
    }

    case 'thinking_delta': {
      const sessionId = msg.sessionId as string
      useAgentStore.setState((s) => ({
        pendingThinkingBySession: {
          ...s.pendingThinkingBySession,
          [sessionId]: (s.pendingThinkingBySession[sessionId] ?? '') + (msg.content as string),
        },
      }))
      break
    }

    case 'tool_use': {
      const sessionId = msg.sessionId as string
      flushPending(sessionId)
      addMessage(sessionId, {
        type: 'tool_use',
        toolUseId: msg.toolUseId as string,
        toolName: msg.toolName as string,
        input: msg.input as Record<string, unknown>,
      })
      break
    }

    case 'tool_result': {
      const sessionId = msg.sessionId as string
      addMessage(sessionId, {
        type: 'tool_result',
        toolUseId: msg.toolUseId as string,
        content: msg.content as string,
        isError: msg.isError as boolean,
      })
      break
    }

    case 'approval_required': {
      const approvalSessionId = msg.sessionId as string
      const toolName = msg.toolName as string
      const requestId = msg.requestId as string
      const input = msg.input as Record<string, unknown>

      // Auto-approve if tool is in allowlist
      if (AUTO_APPROVE_TOOLS.has(toolName)) {
        useAgentStore.getState().approveTool(requestId)
        return
      }

      useAgentStore.setState({
        pendingApproval: { sessionId: approvalSessionId, requestId, toolName, input },
      })
      break
    }

    case 'result': {
      const sessionId = msg.sessionId as string
      const cost = msg.cost as number
      const tokens = msg.tokens as TokenUsage
      const duration = msg.duration as number

      flushPending(sessionId)

      addMessage(sessionId, {
        type: 'result',
        cost,
        tokens,
        duration,
      })

      updateSession(sessionId, {
        status: 'idle',
        statusText: undefined,
        // cost from hub is cumulative (total_cost_usd), not per-turn
        totalCost: cost,
      })
      break
    }

    case 'status': {
      const sessionId = msg.sessionId as string
      updateSession(sessionId, { statusText: msg.text as string })
      break
    }

    case 'error': {
      const sessionId = msg.sessionId as string
      addMessage(sessionId, {
        type: 'error',
        message: msg.message as string,
      })
      break
    }

    case 'session_ended': {
      const sessionId = msg.sessionId as string
      updateSession(sessionId, { status: 'ended', statusText: undefined })
      break
    }

    case 'user_prompt': {
      const sessionId = msg.sessionId as string
      const content = msg.content as string
      const images = msg.images as string[] | undefined
      addMessage(sessionId, {
        type: 'user_prompt',
        content,
        ...(images?.length ? { images } : {}),
      })
      updateSession(sessionId, { status: 'running' })
      break
    }

    case 'tool_approved': {
      // Another client approved the tool — dismiss local approval UI
      const approval = useAgentStore.getState().pendingApproval
      if (approval && approval.requestId === (msg.requestId as string)) {
        useAgentStore.setState({ pendingApproval: null })
      }
      break
    }

    case 'tool_denied': {
      // Another client denied the tool — dismiss local approval UI
      const approval = useAgentStore.getState().pendingApproval
      if (approval && approval.requestId === (msg.requestId as string)) {
        useAgentStore.setState({ pendingApproval: null })
      }
      break
    }

    case 'hub_error': {
      console.warn('[console-server]', msg.message)
      break
    }
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function updateSession(sessionId: string, updates: Partial<SessionInfo>) {
  useAgentStore.setState((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId ? { ...sess, ...updates } : sess,
    ),
  }))
}

function addMessage(sessionId: string, block: AgentMessage['block']) {
  useAgentStore.setState((s) => {
    const messages = s.messagesBySession[sessionId] ?? []
    return {
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...messages, {
          id: nextId(),
          timestamp: Date.now(),
          block,
        }],
      },
    }
  })
}

/** Flush both accumulators in order (thinking before text) to preserve message ordering */
function flushPending(sessionId: string) {
  const { pendingThinkingBySession, pendingTextBySession } = useAgentStore.getState()
  const pendingThinking = pendingThinkingBySession[sessionId] ?? ''
  const pendingText = pendingTextBySession[sessionId] ?? ''
  if (pendingThinking) {
    addMessage(sessionId, { type: 'thinking', content: pendingThinking, collapsed: false })
  }
  if (pendingText) {
    addMessage(sessionId, { type: 'text', content: pendingText })
  }
  if (pendingThinking || pendingText) {
    const newThinking = { ...pendingThinkingBySession }
    const newText = { ...pendingTextBySession }
    delete newThinking[sessionId]
    delete newText[sessionId]
    useAgentStore.setState({ pendingThinkingBySession: newThinking, pendingTextBySession: newText })
  }
}

/** Sort active (non-ended) sessions by createdAt desc — matches sidebar order */
function sortedActiveSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions
    .filter((s) => s.status !== 'ended')
    .sort((a, b) => b.createdAt - a.createdAt)
}
