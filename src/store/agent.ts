import { create } from 'zustand'
import { getHubWsUrl, setHubUrl as saveHubUrl } from '@/hub'

// ============================================================================
// Agent Store — manages WebSocket connection to the Console Agent Hub,
// session state, message streams, and tool approval flow.
// ============================================================================

const RECONNECT_DELAY_MS = 3000

/** Cap the in-memory message window per session while the user is tailing (near bottom).
 *  Older messages remain on the hub and are fetched via loadOlderMessages on scroll-up. */
const MAX_VISIBLE_MESSAGES = 300

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
  name?: string
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
  permissionMode?: string
  messageLogLength?: number
  hasUnread?: boolean
  isAl?: boolean
  gitBranch?: string
  gitDirty?: boolean
  gitStats?: { added: number; deleted: number }
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
  generatingTitleFor: Set<string>
  /** Custom session ordering — IDs in display order. Sessions not listed fall to the end. */
  sessionOrder: string[]

  // Past sessions (from Claude's own JSONL files)
  pastSessions: PastSession[]

  // True when user intentionally deselected to create a new session (prevents auto-select)
  creatingNewSession: boolean

  // Messages per session
  messagesBySession: Record<string, AgentMessage[]>

  // Streaming accumulators (for deltas) — per session
  pendingTextBySession: Record<string, string>
  pendingThinkingBySession: Record<string, string>

  // Active sub-agents per session: toolUseId → description (tool_use without matching tool_result)
  activeSubagentsBySession: Record<string, Map<string, string>>

  // Last-read message timestamp per session (for unread divider)
  lastReadTsBySession: Record<string, number>

  // Pagination: whether older messages are available per session
  hasOlderBySession: Record<string, boolean>
  loadingOlderBySession: Record<string, boolean>

  /** True while the user is scrolled near the bottom — allows the store to cap
   *  the in-memory window. Turned off when they scroll up to view history. */
  isTailingBySession: Record<string, boolean>

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
  markSessionRead: () => void
  markSessionUnread: () => void
  loadOlderMessages: (sessionId: string) => void
  setTailing: (sessionId: string, tailing: boolean) => void
  reorderSession: (fromId: string, toId: string) => void
  forkSession: (sessionId: string) => void
  renameSession: (sessionId: string, name: string) => void
  generateTitle: (sessionId: string) => void
  resumeSession: (claudeSessionId: string, prompt: string, cwd?: string) => void
  listPastSessions: (cwd: string) => void
  setHubUrl: (url: string) => void
}

// Internal refs (not in Zustand — avoids serialization issues)
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let disconnectedManually = false
/** Suppresses notifications during initial message replay on connect */
let suppressNotifications = true
let messageIdCounter = 0

function nextId(): string {
  return `msg_${++messageIdCounter}_${Date.now()}`
}

export const useAgentStore = create<AgentState>((set, get) => ({
  connected: false,
  connecting: false,
  hubUrl: getHubWsUrl(),

  projectDirs: [],

  sessions: [],
  activeSessionId: null,
  generatingTitleFor: new Set(),
  sessionOrder: [],

  pastSessions: [],

  creatingNewSession: false,

  messagesBySession: {},

  pendingTextBySession: {},
  pendingThinkingBySession: {},

  activeSubagentsBySession: {},

  lastReadTsBySession: {},

  hasOlderBySession: {},
  loadingOlderBySession: {},

  isTailingBySession: {},

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

    // /clear — clear this session's chat history in the UI
    if (content.trim() === '/clear') {
      const newPending = { ...get().pendingTextBySession }
      const newThinking = { ...get().pendingThinkingBySession }
      delete newPending[sessionId]
      delete newThinking[sessionId]
      set({
        messagesBySession: { ...get().messagesBySession, [sessionId]: [] },
        pendingTextBySession: newPending,
        pendingThinkingBySession: newThinking,
      })
      return
    }

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
    // Snapshot last-read timestamp for the session we're LEAVING
    const prevId = get().activeSessionId
    if (prevId) {
      const msgs = get().messagesBySession[prevId]
      const lastTs = msgs?.length ? msgs[msgs.length - 1]!.timestamp : undefined
      if (lastTs) {
        set((s) => ({ lastReadTsBySession: { ...s.lastReadTsBySession, [prevId]: lastTs } }))
      }
    }
    set({ activeSessionId: sessionId, pendingApproval: null, creatingNewSession: sessionId === null })
    // Clear unread when viewing a session
    if (sessionId) {
      updateSession(sessionId, { hasUnread: false })
    }
    import('@/notifications').then(({ setActiveAgentSession }) => setActiveAgentSession(sessionId))
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
    if (next) {
      set({ activeSessionId: next.id, pendingApproval: null })
      import('@/notifications').then(({ setActiveAgentSession }) => setActiveAgentSession(next.id))
    }
  },

  selectPrevSession: () => {
    const { sessions, activeSessionId } = get()
    const active = sortedActiveSessions(sessions)
    if (active.length === 0) return
    const idx = active.findIndex((s) => s.id === activeSessionId)
    const prev = active[Math.max(idx - 1, 0)]
    if (prev) {
      set({ activeSessionId: prev.id, pendingApproval: null })
      import('@/notifications').then(({ setActiveAgentSession }) => setActiveAgentSession(prev.id))
    }
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

  markSessionRead: () => {
    const sessionId = get().activeSessionId
    if (sessionId) {
      updateSession(sessionId, { hasUnread: false })
    }
  },

  markSessionUnread: () => {
    const sessionId = get().activeSessionId
    if (sessionId) {
      updateSession(sessionId, { hasUnread: true })
    }
  },

  loadOlderMessages: (sessionId) => {
    if (get().loadingOlderBySession[sessionId]) return
    if (get().hasOlderBySession[sessionId] === false) return
    // Calculate beforeIndex: total log length minus messages we already have
    const session = get().sessions.find((s) => s.id === sessionId)
    const totalLog = session?.messageLogLength ?? 0
    const currentCount = get().messagesBySession[sessionId]?.length ?? 0
    const beforeIndex = Math.max(0, totalLog - currentCount)
    if (beforeIndex <= 0) {
      set((s) => ({ hasOlderBySession: { ...s.hasOlderBySession, [sessionId]: false } }))
      return
    }
    set((s) => ({ loadingOlderBySession: { ...s.loadingOlderBySession, [sessionId]: true } }))
    sendWs({ type: 'get_older_messages', sessionId, beforeIndex })
  },

  setTailing: (sessionId, tailing) => {
    const current = get().isTailingBySession[sessionId]
    if (current === tailing) return
    set((s) => ({ isTailingBySession: { ...s.isTailingBySession, [sessionId]: tailing } }))
  },

  reorderSession: (fromId, toId) => {
    const sessions = get().sessions.filter((s) => s.id !== 'al' && s.status !== 'ended')
    const currentOrder = get().sessionOrder
    // Build full order: start from currentOrder, add any missing sessions in default sort
    const defaultSorted = [...sessions].sort((a, b) => b.createdAt - a.createdAt).map((s) => s.id)
    const ordered = currentOrder.length > 0
      ? [...currentOrder.filter((id) => defaultSorted.includes(id)), ...defaultSorted.filter((id) => !currentOrder.includes(id))]
      : defaultSorted
    // Move fromId to toId's position
    const fromIdx = ordered.indexOf(fromId)
    const toIdx = ordered.indexOf(toId)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return
    ordered.splice(fromIdx, 1)
    ordered.splice(toIdx, 0, fromId)
    set({ sessionOrder: ordered })
    sendWs({ type: 'reorder_sessions', order: ordered })
  },

  forkSession: (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session) return
    sendWs({
      type: 'fork_session',
      sessionId,
      ...(session.cwd ? { cwd: session.cwd } : {}),
    })
    set({
      pendingSessionActivate: true,
      pendingApproval: null,
      creatingNewSession: false,
    })
  },

  renameSession: (sessionId, name) => {
    sendWs({ type: 'rename_session', sessionId, name })
    // Optimistic update
    updateSession(sessionId, { name })
  },

  generateTitle: (sessionId) => {
    sendWs({ type: 'generate_title', sessionId })
    set((s) => ({ generatingTitleFor: new Set(s.generatingTitleFor).add(sessionId) }))
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
    saveHubUrl(url.replace(/^ws/, 'http'))
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
    suppressNotifications = true
    useAgentStore.setState({ connected: true, connecting: false })
    // Hub sends sessions_list + message replay on connect.
    // Suppress notifications during replay — re-enable after 2s.
    setTimeout(() => { suppressNotifications = false }, 2000)
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
      // Skip if session already exists (e.g. replayed from messageLog after sessions_list)
      if (useAgentStore.getState().sessions.some((s) => s.id === sessionId)) {
        if (shouldActivate) {
          useAgentStore.setState({ activeSessionId: sessionId, pendingPrompt: null, pendingSessionActivate: false, creatingNewSession: false })
        }
        break
      }
      // Don't add initial prompt here — it comes as a separate user_prompt message from the hub
      useAgentStore.setState((s) => ({
        ...(shouldActivate ? { activeSessionId: sessionId } : {}),
        pendingPrompt: null,
        pendingSessionActivate: false,
        creatingNewSession: false,
        sessions: [...s.sessions, {
          id: sessionId,
          name: msg.name as string | undefined,
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
        permissionMode: msg.permissionMode as string | undefined,
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

      // Preserve Al session if hub list doesn't include it (e.g. list_sessions response)
      const hasAl = hubSessions.some((s) => s.id === 'al')
      const existingAl = !hasAl ? existing.find((s) => s.id === 'al') : undefined

      // Merge hub data with local per-session state (model, context, statusText)
      const merged = hubSessions.map((s) => {
        const isAl = s.id === 'al'
        // Try direct match first, then remap match
        const local = existingMap.get(s.id) ?? (s.claudeSessionId ? existingMap.get(claudeToOldId.get(s.claudeSessionId) ?? '') : undefined)
        return local
          ? { ...s, isAl, name: local.name ?? s.name, model: local.model, contextWindow: local.contextWindow ?? 200_000, contextUsed: local.contextUsed ?? 0, statusText: local.statusText, hasUnread: local.hasUnread }
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

      // Re-add preserved Al session if it was missing from hub list
      if (existingAl) merged.unshift({ ...existingAl, isAl: true })

      // Determine which sessions have older messages available
      const REPLAY_LIMIT = 50
      const hasOlder = { ...state.hasOlderBySession }
      for (const s of merged) {
        if (s.messageLogLength && s.messageLogLength > REPLAY_LIMIT && hasOlder[s.id] === undefined) {
          hasOlder[s.id] = true
        }
      }

      // Only include activeSessionId in the update if it actually changed (remap)
      const stateUpdate: Partial<AgentState> = {
        sessions: merged,
        messagesBySession: newMessages,
        pendingTextBySession: newPendingText,
        pendingThinkingBySession: newPendingThinking,
        hasOlderBySession: hasOlder,
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
      // Clear any pending deltas (the 'text' message is the authoritative coalesced version)
      // Don't use flushPending — that would create a duplicate message from the deltas
      const { pendingTextBySession, pendingThinkingBySession } = useAgentStore.getState()
      if (pendingTextBySession[sessionId] || pendingThinkingBySession[sessionId]) {
        const newText = { ...pendingTextBySession }
        const newThinking = { ...pendingThinkingBySession }
        delete newText[sessionId]
        delete newThinking[sessionId]
        useAgentStore.setState({ pendingTextBySession: newText, pendingThinkingBySession: newThinking })
      }
      addMessage(sessionId, {
        type: 'text',
        content: msg.content as string,
      })
      markUnreadIfNotActive(sessionId)
      break
    }

    case 'text_delta': {
      const sessionId = msg.sessionId as string
      bufferDelta('text', sessionId, msg.content as string)
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
      bufferDelta('thinking', sessionId, msg.content as string)
      break
    }

    case 'tool_use': {
      const sessionId = msg.sessionId as string
      const toolName = msg.toolName as string
      const toolUseId = msg.toolUseId as string
      const input = msg.input as Record<string, unknown>
      flushPending(sessionId)
      addMessage(sessionId, {
        type: 'tool_use',
        toolUseId,
        toolName,
        input,
      })
      // Track mode changes from plan mode tools
      if (toolName === 'EnterPlanMode') {
        updateSession(sessionId, { permissionMode: 'plan' })
      } else if (toolName === 'ExitPlanMode') {
        updateSession(sessionId, { permissionMode: 'default' })
      }
      // Track sub-agent spawns (tool_use without matching result = running)
      if (toolName === 'Agent') {
        const desc = (input.description as string) || (input.prompt as string)?.slice(0, 40) || 'Sub-agent'
        useAgentStore.setState((s) => {
          const map = new Map(s.activeSubagentsBySession[sessionId] ?? [])
          map.set(toolUseId, desc)
          return { activeSubagentsBySession: { ...s.activeSubagentsBySession, [sessionId]: map } }
        })
      }
      break
    }

    case 'tool_result': {
      const sessionId = msg.sessionId as string
      const toolUseId = msg.toolUseId as string
      addMessage(sessionId, {
        type: 'tool_result',
        toolUseId,
        content: msg.content as string,
        isError: msg.isError as boolean,
      })
      // Clear sub-agent tracking when result arrives
      const subagents = useAgentStore.getState().activeSubagentsBySession[sessionId]
      if (subagents?.has(toolUseId)) {
        useAgentStore.setState((s) => {
          const map = new Map(s.activeSubagentsBySession[sessionId] ?? [])
          map.delete(toolUseId)
          return { activeSubagentsBySession: { ...s.activeSubagentsBySession, [sessionId]: map } }
        })
      }
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
      markUnreadIfNotActive(approvalSessionId)
      // Notify (skip during replay)
      if (suppressNotifications) break
      import('@/notifications').then(({ notify }) => {
        const question = toolName === 'AskUserQuestion' ? (input.question as string || 'Question') : toolName
        notify({
          title: 'Claude needs input',
          body: question.length > 80 ? question.slice(0, 80) + '...' : question,
          icon: '/icon-192.png',
          tag: `agent-${requestId}`,
          data: { pane: 'agents', itemId: approvalSessionId },
        })
      })
      break
    }

    case 'result': {
      const sessionId = msg.sessionId as string
      const cost = msg.cost as number
      const tokens = msg.tokens as TokenUsage
      const duration = msg.duration as number

      // Check status BEFORE updating to idle (for notification gating)
      const wasRunning = useAgentStore.getState().sessions.find((s) => s.id === sessionId)?.status === 'running'

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

      markUnreadIfNotActive(sessionId)

      // Notify when agent finishes — skip during replay and when session wasn't running
      const session = useAgentStore.getState().sessions.find((s) => s.id === sessionId)
      if (!suppressNotifications && session && wasRunning) {
        const name = session.name || session.prompt?.slice(0, 50) || 'Agent'
        import('@/notifications').then(({ notify }) => {
          notify({
            title: `${name} finished`,
            body: `${(duration / 1000).toFixed(1)}s · $${cost.toFixed(4)}`,
            icon: '/icon-192.png',
            tag: `agent-done-${sessionId}`,
            data: { pane: 'agents', itemId: sessionId },
          })
        })
      }
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
      markUnreadIfNotActive(sessionId)
      break
    }

    case 'session_ended': {
      const sessionId = msg.sessionId as string
      updateSession(sessionId, { status: 'ended', statusText: undefined })
      break
    }

    case 'session_renamed': {
      const sessionId = msg.sessionId as string
      updateSession(sessionId, { name: msg.name as string })
      const gen = useAgentStore.getState().generatingTitleFor
      if (gen.has(sessionId)) {
        const next = new Set(gen)
        next.delete(sessionId)
        useAgentStore.setState({ generatingTitleFor: next })
      }
      break
    }

    case 'session_order': {
      useAgentStore.setState({ sessionOrder: msg.order as string[] })
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
      // Al's session status is managed by sessions_list broadcasts, not user_prompt
      if (sessionId !== 'al') {
        updateSession(sessionId, { status: 'running' })
      }
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

    case 'monzo_transaction': {
      // Real-time transaction from Monzo webhook
      const tx = msg.transaction as any
      import('@/store/money').then(({ useMoneyStore, formatAmount }) => {
        useMoneyStore.getState().handleWebhookTransaction(tx)
        // Notify
        const merchant = typeof tx.merchant === 'object' && tx.merchant ? tx.merchant : null
        const name = merchant?.name || tx.counterparty?.name || tx.description
        import('@/notifications').then(({ notify }) => {
          notify({
            title: name,
            body: formatAmount(tx.amount),
            icon: merchant?.logo || undefined,
            tag: `money-${tx.id}`,
            data: { pane: 'money', itemId: tx.id },
          })
        })
      })
      break
    }

    case 'older_messages': {
      const sessionId = msg.sessionId as string
      const olderMsgs = msg.messages as Array<Record<string, unknown>>
      const hasMore = msg.hasMore as boolean
      // Convert hub messages to AgentMessages and prepend
      const blocks: AgentMessage[] = []
      for (const m of olderMsgs) {
        const block = hubMsgToBlock(m)
        if (block) blocks.push({ id: nextId(), timestamp: Date.now(), block })
      }
      useAgentStore.setState((s) => ({
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: [...blocks, ...(s.messagesBySession[sessionId] ?? [])],
        },
        hasOlderBySession: { ...s.hasOlderBySession, [sessionId]: hasMore },
        loadingOlderBySession: { ...s.loadingOlderBySession, [sessionId]: false },
      }))
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

/** Convert a replayed hub message to an AgentMessage block */
function hubMsgToBlock(m: Record<string, unknown>): AgentMessage['block'] | null {
  switch (m.type) {
    case 'text': return { type: 'text', content: m.content as string }
    case 'thinking': return { type: 'thinking', content: m.content as string, collapsed: true }
    case 'tool_use': return { type: 'tool_use', toolUseId: m.toolUseId as string, toolName: m.toolName as string, input: m.input as Record<string, unknown> }
    case 'tool_result': return { type: 'tool_result', toolUseId: m.toolUseId as string, content: m.content as string, isError: m.isError as boolean }
    case 'user_prompt': return { type: 'user_prompt', content: m.content as string, ...(m.images ? { images: m.images as string[] } : {}) }
    case 'error': return { type: 'error', message: m.message as string }
    case 'result': return { type: 'result', cost: m.cost as number, tokens: m.tokens as TokenUsage, duration: m.duration as number }
    default: return null
  }
}

/** Mark a session as unread if it's not the currently viewed session */
function markUnreadIfNotActive(sessionId: string) {
  if (suppressNotifications) return // Don't mark unread during replay
  const state = useAgentStore.getState()
  if (state.activeSessionId !== sessionId) {
    updateSession(sessionId, { hasUnread: true })
  }
}

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
    const newMsg: AgentMessage = { id: nextId(), timestamp: Date.now(), block }
    const appended = [...messages, newMsg]
    // Cap the in-memory window when the user is tailing — older entries stay on the hub.
    const tailing = s.isTailingBySession[sessionId] !== false // default to true if unset
    if (tailing && appended.length > MAX_VISIBLE_MESSAGES) {
      const trimmed = appended.slice(appended.length - MAX_VISIBLE_MESSAGES)
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: trimmed },
        hasOlderBySession: { ...s.hasOlderBySession, [sessionId]: true },
      }
    }
    return {
      messagesBySession: { ...s.messagesBySession, [sessionId]: appended },
    }
  })
}

// Delta batching — stream chunks can fire many times per frame. Each setState
// creates a new pendingXBySession map and notifies every Zustand subscriber in
// the app; during bursts this saturates the main thread and delays input events.
// Accumulate deltas in a plain Map and flush once per animation frame.
const deltaBuffer = new Map<string, { text: string; thinking: string }>()
let deltaRafHandle: number | null = null

function bufferDelta(kind: 'text' | 'thinking', sessionId: string, chunk: string) {
  let entry = deltaBuffer.get(sessionId)
  if (!entry) {
    entry = { text: '', thinking: '' }
    deltaBuffer.set(sessionId, entry)
  }
  entry[kind] += chunk
  if (deltaRafHandle === null) {
    deltaRafHandle = requestAnimationFrame(drainDeltaBuffer)
  }
}

function drainDeltaBuffer() {
  deltaRafHandle = null
  if (deltaBuffer.size === 0) return
  const entries = Array.from(deltaBuffer.entries())
  deltaBuffer.clear()
  useAgentStore.setState((s) => {
    const newText = { ...s.pendingTextBySession }
    const newThinking = { ...s.pendingThinkingBySession }
    for (const [sessionId, buf] of entries) {
      if (buf.text) newText[sessionId] = (newText[sessionId] ?? '') + buf.text
      if (buf.thinking) newThinking[sessionId] = (newThinking[sessionId] ?? '') + buf.thinking
    }
    return { pendingTextBySession: newText, pendingThinkingBySession: newThinking }
  })
}

/** Flush both accumulators in order (thinking before text) to preserve message ordering */
function flushPending(sessionId: string) {
  // Any buffered deltas must land before we read pending*BySession, otherwise
  // in-flight chunks get dropped when we finalize the message.
  drainDeltaBuffer()
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
