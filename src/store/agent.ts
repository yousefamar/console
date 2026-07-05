import { create } from 'zustand'
import { getHubWsUrl, setHubUrl as saveHubUrl } from '@/hub'
import { flattenSidebarOrder } from '@/components/agent/session-tree'

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
    /** Unified diff for an Edit/Write (from the CLI's structuredPatch) —
     *  rendered terminal-style under the paired tool_use block. */
    | { type: 'tool_diff'; toolUseId: string; filePath: string; hunks: DiffHunk[] }
    /** Background bash / Task subagent lifecycle chip. */
    | { type: 'bg_task'; taskId: string; status: 'started' | 'completed' | 'failed'; description?: string; taskType?: string; summary?: string }
    | { type: 'user_prompt'; content: string; images?: string[] }
    | { type: 'status'; text: string }
    | { type: 'error'; message: string }
    | { type: 'result'; cost: number; tokens: TokenUsage; duration: number; ttftMs?: number; stopReason?: string | null; numTurns?: number; modelUsage?: ResultModelUsage[] }
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Lines carry their own '+' / '-' / ' ' prefixes (jsdiff format). */
  lines: string[]
}

export interface ResultModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUSD?: number
}

export interface ContextBreakdownEntry {
  name: string
  tokens: number
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
  /** claudeSessionId of the parent session if this is a fork — nests forks
   *  under their parent in the sidebar tree. */
  parentClaudeSessionId?: string
  /** Durable org-chart role this session embodies (agents/registry.ts). */
  agentKey?: string
  status: 'running' | 'idle' | 'ended'
  createdAt: number
  prompt: string
  cwd?: string
  totalCost: number
  totalTokens: TokenUsage
  model?: string
  contextWindow: number
  contextUsed: number
  /** Categorized context breakdown from the CLI's get_context_usage (system
   *  prompt / tools / messages …). Present after the first accurate update. */
  contextBreakdown?: ContextBreakdownEntry[]
  /** Per-session model pin (hub-side). Set → this session ignores the hub-wide
   *  model; undefined → follows it. */
  modelOverride?: string
  statusText?: string
  permissionMode?: string
  messageLogLength?: number
  /** Hub-persisted index of the last message marked read.
   *  hasUnread is derived from `messageLogLength > lastReadIndex`. */
  lastReadIndex?: number
  /** Live child-process count from `ps -eo pid,ppid` on the claude PID —
   *  approximates running background bashes. Refreshed on sessions_list. */
  backgroundProcessCount?: number
  /** Set when the session emitted `@amar` (wants Yousef's eyes). Sticky red
   *  marker in the sidebar; cleared on open / mark-read. */
  needsAttention?: { ts: number; snippet: string } | null
  hasUnread?: boolean
  isAl?: boolean
  gitBranch?: string
  gitDirty?: boolean
  gitStats?: { added: number; deleted: number }
}

/** A durable agent role (org-chart node). Mirrors server/src/agents/registry.ts. */
export interface AgentRole {
  key: string
  title: string
  manager: string | null
  goals: string[]
  cwd: string | null
  created: string | null
  charter: string
  hasFile: boolean
  /** Organization-only folder node (no session, not spawnable). */
  folder?: boolean
}

export interface OrgNode {
  role: AgentRole
  children: OrgNode[]
  danglingManager?: string
  cycleBroken?: boolean
}

/** A delegation task (mirrors server/src/agents/tasks.ts). */
export interface AgentTask {
  id: string
  title: string
  brief: string
  fromKey: string
  toKey: string
  origin: 'human' | 'agent'
  parentTaskId: string | null
  chain: string[]
  status: 'pending' | 'in_progress' | 'blocked' | 'done' | 'failed' | 'cancelled'
  result: string | null
  workerSessionId?: string
  ephemeral?: boolean
  createdAt: number
  updatedAt: number
}

/** A reversible org-chart edit. Covers the two key-stable, easily-inverted
 *  mutations (reparent + rename); folder create/delete are not undoable (the key
 *  is hub-minted async). */
export type OrgHistoryEntry =
  | { kind: 'manager'; agentKey: string; prev: string | null; next: string | null }
  | { kind: 'rename'; agentKey: string; prev: string; next: string }

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

  // Agent model config (model-config.ts). `agentModel` is what new/restarted
  // sessions spawn with; `agentModelChain` is the ordered fallback list shown in
  // the picker; `agentModelLockedByEnv` disables the picker (CLAUDE_MODEL set).
  // Org-chart roles (agents/registry.ts). Pushed by the hub on connect + change.
  agentRoles: AgentRole[]
  agentTree: OrgNode[]
  /** Delegation tasks (pushed by the hub on connect + on every change). */
  tasks: AgentTask[]
  /** A pending hand-off offer (Al emitted `@handoff(<key>)`); drives a "Talk to
   *  X" affordance. Cleared once acted on or dismissed. */
  pendingHandoff: { fromSessionId: string; targetAgentKey: string } | null
  /** When the user followed a hand-off, the session to return to ("Back to Al"). */
  handoffReturnTo: string | null
  /** Agents-pane view: the session list, or the visual org chart. Device-local. */
  agentViewMode: 'list' | 'orgchart'
  /** "Needs me" filter — shared by the list and the org chart. When on, the list
   *  shows only alerted sessions and the chart prunes to the alerted subtree.
   *  Device-local (localStorage). */
  filterAlerted: boolean
  /** Role whose info dialog is open (null = closed). Opened via a "Show info"
   *  context-menu action in either view; rendered centered/modal. */
  roleInfoKey: string | null
  /** "/" quick-switcher: fuzzy-find an agent by name and jump to it. */
  showAgentSwitcher: boolean
  /** Undo/redo of org-chart edits (reparent + rename). Reparenting via drag was
   *  easy to trigger accidentally, so these make every edge change reversible. */
  orgPast: OrgHistoryEntry[]
  orgFuture: OrgHistoryEntry[]

  agentModel: string
  agentModelChain: string[]
  agentModelLockedByEnv: boolean
  /** Set when the hub auto-fell-back after a model became unavailable. Drives a
   *  dismissible banner; cleared by dismissModelFallbackNotice. */
  modelFallbackNotice: { failedModel: string; model: string } | null

  // Sessions
  sessions: SessionInfo[]
  activeSessionId: string | null
  generatingTitleFor: Set<string>
  /** Custom session ordering — IDs in display order. Sessions not listed fall to the end. */
  sessionOrder: string[]
  /** Collapsed group cwds — used by AgentTab grouping UI. Synced via hub. */
  collapsedGroups: Set<string>

  // Past sessions (from Claude's own JSONL files)
  pastSessions: PastSession[]

  // True when user intentionally deselected to create a new session (prevents auto-select)
  creatingNewSession: boolean

  // Messages per session
  messagesBySession: Record<string, AgentMessage[]>

  // Streaming accumulators (for deltas) — per session
  pendingTextBySession: Record<string, string>
  pendingThinkingBySession: Record<string, string>
  /** Live tool-call arguments streaming in (input_json_delta), per session:
   *  the accumulated raw JSON of the CURRENT tool call being typed. Cleared
   *  when the finalized tool_use block arrives. */
  pendingToolInputBySession: Record<string, { toolUseId: string; toolName: string; json: string } | undefined>

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

  /** Pending tool approval for the currently-active session — denormalized
   *  view of pendingApprovalsBySession[activeSessionId]. UI components subscribe
   *  to this. Kept in sync by the approval_required / tool_approved /
   *  tool_denied handlers and by selectSession. */
  pendingApproval: PendingApproval | null
  /** All outstanding approvals keyed by sessionId. Multiple sessions can be
   *  blocked on input simultaneously (e.g. parent + fork) — single-slot
   *  pendingApproval would let later arrivals overwrite earlier ones. */
  pendingApprovalsBySession: Record<string, PendingApproval>

  // Slash commands (from session init, shared across sessions)
  sessionSlashCommands: string[]

  // Actions
  connect: () => void
  disconnect: () => void
  createSession: (prompt: string, cwd?: string, images?: Array<{ media_type: string; data: string }>, name?: string) => void
  sendMessage: (content: string, images?: Array<{ media_type: string; data: string }>) => void
  approveTool: (requestId: string, modifiedInput?: Record<string, unknown>) => void
  denyTool: (requestId: string, reason?: string) => void
  autoApproveTool: (toolName: string) => void
  interrupt: () => void
  killSession: (sessionId: string) => void
  selectSession: (sessionId: string | null) => void
  /** Pop back to the session list on mobile — clears active session WITHOUT
   *  entering "creating new session" mode (which selectSession(null) does). */
  goToSessionList: () => void
  selectNextSession: () => void
  selectPrevSession: () => void
  listSessions: () => void
  /** Switch the model all hub agents spawn with (restarts live sessions). */
  setAgentModel: (model: string) => void
  /** Pin ONE session to a model, applied mid-session (in-place set_model with
   *  respawn fallback). null clears the pin — back to the hub-wide model. */
  setSessionModel: (sessionId: string, model: string | null) => void
  dismissModelFallbackNotice: () => void
  /** Reparent a role in the org chart (null = make it a root). `record` (default
   *  true) pushes an undo entry; undo/redo pass false. */
  setAgentManager: (agentKey: string, manager: string | null, record?: boolean) => void
  /** Toggle the "needs me" filter (shared list + chart). */
  toggleFilterAlerted: () => void
  /** Open / close the role info dialog. */
  openRoleInfo: (agentKey: string) => void
  closeRoleInfo: () => void
  /** Open / close the "/" agent quick-switcher. */
  openAgentSwitcher: () => void
  closeAgentSwitcher: () => void
  /** Undo / redo the last org-chart edge/rename change. */
  undoOrg: () => void
  redoOrg: () => void
  /** Spawn a fresh session for a parked role. */
  reviveAgent: (agentKey: string) => void
  /** Reload a live session (role-backed → re-derives charter via fresh spawn). */
  reloadSession: (sessionId: string) => void
  /** Delete a role (kills its live session + removes the file). */
  deleteRole: (agentKey: string) => void
  /** Create an organization-only folder node (optionally under a manager). */
  createFolder: (title: string, manager?: string | null) => void
  /** Rename a role/folder. `record` (default true) pushes an undo entry. */
  renameRole: (agentKey: string, title: string, record?: boolean) => void
  setAgentViewMode: (mode: 'list' | 'orgchart') => void
  /** Delegate a task to a role (fromKey defaults to 'al'). */
  delegate: (toKey: string, brief: string, fromKey?: string) => void
  /** Cancel a delegation task. */
  cancelTask: (taskId: string) => void
  /** Follow a hand-off: open the target agent's session, remember where to return. */
  acceptHandoff: (targetAgentKey: string) => void
  /** Dismiss the pending hand-off offer without following it. */
  dismissHandoff: () => void
  /** Return to Al after a hand-off (clears the return marker). */
  returnFromHandoff: () => void
  toggleThinkingCollapsed: (messageId: string) => void
  markSessionRead: (id?: string) => void
  markSessionUnread: (id?: string) => void
  loadOlderMessages: (sessionId: string) => void
  /** Drop the in-memory message view and re-pull the full transcript from the
   *  hub (reads the complete JSONL from disk). Use when the local view is stale
   *  or was truncated by the visible-window cap. */
  reloadSessionHistory: (sessionId: string) => void
  setTailing: (sessionId: string, tailing: boolean) => void
  reorderSession: (fromId: string, toId: string) => void
  toggleGroupCollapsed: (cwd: string) => void
  forkSession: (sessionId: string) => void
  /** Merge a fork back into its parent (summary folded in), then close the fork. */
  mergeSession: (sessionId: string) => void
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

// The agent WS uses the hub's "default" path dispatch (anything that doesn't
// match a named handler). We target `/hub/agents` explicitly because (a)
// `/hub` with no trailing path falls outside Caddy's `handle_path /hub/*`
// matcher, and (b) Chrome's HTTP/2 WebSocket bridge through Caddy is flaky
// on `/hub/` (trailing-slash-only) but reliable on `/hub/<word>`.
const agentWsUrl = `${getHubWsUrl()}/agents`

export const useAgentStore = create<AgentState>((set, get) => ({
  connected: false,
  connecting: false,
  hubUrl: agentWsUrl,

  projectDirs: [],

  agentRoles: [],
  agentTree: [],
  tasks: [],
  pendingHandoff: null,
  handoffReturnTo: null,
  agentViewMode: (typeof localStorage !== 'undefined' && localStorage.getItem('console:agents:viewMode') === 'orgchart') ? 'orgchart' : 'list',
  filterAlerted: typeof localStorage !== 'undefined' && localStorage.getItem('console:agents:filterAlerted') === '1',
  roleInfoKey: null,
  showAgentSwitcher: false,
  orgPast: [],
  orgFuture: [],

  agentModel: '',
  agentModelChain: [],
  agentModelLockedByEnv: false,
  modelFallbackNotice: null,

  sessions: [],
  activeSessionId: null,
  generatingTitleFor: new Set(),
  sessionOrder: [],
  collapsedGroups: new Set(),

  pastSessions: [],

  creatingNewSession: false,

  messagesBySession: {},

  pendingTextBySession: {},
  pendingThinkingBySession: {},
  pendingToolInputBySession: {},

  activeSubagentsBySession: {},

  lastReadTsBySession: {},

  hasOlderBySession: {},
  loadingOlderBySession: {},

  isTailingBySession: {},

  pendingPrompt: null,
  pendingSessionActivate: false,

  pendingApproval: null,
  pendingApprovalsBySession: {},

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

  createSession: (prompt, cwd, images, name) => {
    sendWs({
      type: 'create_session',
      prompt,
      ...(cwd ? { cwd } : {}),
      ...(images?.length ? { images } : {}),
      ...(name ? { name } : {}),
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

    // Replying = read (chat-style). Optimistic local clear; hub also auto-marks
    // on receipt of send_message and broadcasts session_read_state for sync.
    const sess = get().sessions.find((s) => s.id === sessionId)
    if (sess) updateSession(sessionId, { lastReadIndex: (sess.messageLogLength ?? 0) + 1, hasUnread: false })
    const msgs = get().messagesBySession[sessionId]
    const lastTs = msgs?.length ? msgs[msgs.length - 1]!.timestamp : Date.now()
    set((s) => ({ lastReadTsBySession: { ...s.lastReadTsBySession, [sessionId]: lastTs } }))

    // /clear — clear this session's chat history in the UI
    if (content.trim() === '/clear') {
      dropBufferedMessages(sessionId) // a later flush must not resurrect rows
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
    // Find the approval — prefer per-session map (handles approvals for
    // sessions other than the active one) before the denormalized view.
    const map = get().pendingApprovalsBySession
    const approval = Object.values(map).find((a) => a.requestId === requestId) ?? get().pendingApproval
    const sessionId = approval?.sessionId ?? get().activeSessionId
    if (!sessionId) return
    // Claude CLI requires updatedInput in the approve response. When the caller
    // doesn't override, pass the original tool input back unchanged.
    const finalInput = modifiedInput ?? approval?.input ?? {}
    sendWs({ type: 'approve_tool', sessionId, requestId, modifiedInput: finalInput })
    clearApprovalByRequestId(requestId)
  },

  denyTool: (requestId, reason) => {
    const approval = get().pendingApproval
    const sessionId = approval?.sessionId ?? get().activeSessionId
    if (!sessionId) return
    sendWs({ type: 'deny_tool', sessionId, requestId, reason })
    clearApprovalByRequestId(requestId)
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

  goToSessionList: () => {
    set({ activeSessionId: null, pendingApproval: null, creatingNewSession: false })
    import('@/notifications').then(({ setActiveAgentSession }) => setActiveAgentSession(null))
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
    // Re-project the per-session approval map to the denormalized view for the
    // newly active session.
    const activeApproval = sessionId ? (get().pendingApprovalsBySession[sessionId] ?? null) : null
    set({ activeSessionId: sessionId, pendingApproval: activeApproval, creatingNewSession: sessionId === null })
    // Opening a session does NOT clear its @amar marker — it stays sticky until
    // Yousef explicitly marks the session read (chat-style; see markSessionRead).
    // Don't auto-mark read on selection — chat-style: stays unread until the
    // user replies (sendMessage) or explicitly hits `e`.
    import('@/notifications').then(({ setActiveAgentSession }) => setActiveAgentSession(sessionId))
    // Request history if we have no messages for this session yet
    if (sessionId && !(get().messagesBySession[sessionId]?.length)) {
      sendWs({ type: 'get_session_history', sessionId })
    }
  },

  selectNextSession: () => {
    const state = get()
    const active = visibleSidebarOrder(state) // same order the sidebar renders
    if (active.length === 0) return
    const idx = active.findIndex((s) => s.id === state.activeSessionId)
    const next = active[Math.min(idx + 1, active.length - 1)] ?? active[0]
    if (next) {
      const activeApproval = state.pendingApprovalsBySession[next.id] ?? null
      set({ activeSessionId: next.id, pendingApproval: activeApproval })
      import('@/notifications').then(({ setActiveAgentSession }) => setActiveAgentSession(next.id))
    }
  },

  selectPrevSession: () => {
    const state = get()
    const active = visibleSidebarOrder(state)
    if (active.length === 0) return
    const idx = active.findIndex((s) => s.id === state.activeSessionId)
    const prev = active[Math.max(idx - 1, 0)] ?? active[0]
    if (prev) {
      const activeApproval = state.pendingApprovalsBySession[prev.id] ?? null
      set({ activeSessionId: prev.id, pendingApproval: activeApproval })
      import('@/notifications').then(({ setActiveAgentSession }) => setActiveAgentSession(prev.id))
    }
  },

  listSessions: () => {
    sendWs({ type: 'list_sessions' })
  },

  setAgentModel: (model) => {
    sendWs({ type: 'set_model', model })
  },

  setSessionModel: (sessionId, model) => {
    sendWs({ type: 'set_session_model', sessionId, model })
  },

  dismissModelFallbackNotice: () => set({ modelFallbackNotice: null }),

  setAgentManager: (agentKey, manager, record = true) => {
    const prev = get().agentRoles.find((r) => r.key === agentKey)?.manager ?? null
    if (prev === manager) return // no-op edge (e.g. dropped on current parent)
    // Optimistic: patch the role locally so the chart reparents instantly; the
    // hub's agents_list broadcast reconciles (and reverts if it rejected, e.g.
    // a self/cycle edge).
    set((s) => ({ agentRoles: s.agentRoles.map((r) => (r.key === agentKey ? { ...r, manager } : r)) }))
    sendWs({ type: 'set_manager', agentKey, manager })
    if (record) set((s) => ({ orgPast: [...s.orgPast, { kind: 'manager', agentKey, prev, next: manager }], orgFuture: [] }))
  },

  toggleFilterAlerted: () => {
    set((s) => {
      const next = !s.filterAlerted
      if (typeof localStorage !== 'undefined') localStorage.setItem('console:agents:filterAlerted', next ? '1' : '0')
      return { filterAlerted: next }
    })
  },

  openRoleInfo: (agentKey) => set({ roleInfoKey: agentKey }),
  closeRoleInfo: () => set({ roleInfoKey: null }),

  openAgentSwitcher: () => set({ showAgentSwitcher: true }),
  closeAgentSwitcher: () => set({ showAgentSwitcher: false }),

  undoOrg: () => {
    const past = get().orgPast
    const entry = past[past.length - 1]
    if (!entry) return
    set((s) => ({ orgPast: s.orgPast.slice(0, -1), orgFuture: [...s.orgFuture, entry] }))
    if (entry.kind === 'manager') get().setAgentManager(entry.agentKey, entry.prev, false)
    else get().renameRole(entry.agentKey, entry.prev, false)
  },

  redoOrg: () => {
    const future = get().orgFuture
    const entry = future[future.length - 1]
    if (!entry) return
    set((s) => ({ orgFuture: s.orgFuture.slice(0, -1), orgPast: [...s.orgPast, entry] }))
    if (entry.kind === 'manager') get().setAgentManager(entry.agentKey, entry.next, false)
    else get().renameRole(entry.agentKey, entry.next, false)
  },

  reviveAgent: (agentKey) => {
    sendWs({ type: 'revive_agent', agentKey })
  },

  reloadSession: (sessionId) => {
    sendWs({ type: 'reload_session', sessionId })
  },

  deleteRole: (agentKey) => {
    sendWs({ type: 'delete_role', agentKey })
  },

  createFolder: (title, manager = null) => {
    sendWs({ type: 'create_folder', title, manager })
  },

  renameRole: (agentKey, title, record = true) => {
    const prev = get().agentRoles.find((r) => r.key === agentKey)?.title ?? ''
    if (prev === title) return
    // Optimistic title update; the agents_list broadcast reconciles.
    set((s) => ({ agentRoles: s.agentRoles.map((r) => (r.key === agentKey ? { ...r, title } : r)) }))
    sendWs({ type: 'rename_role', agentKey, title })
    if (record) set((s) => ({ orgPast: [...s.orgPast, { kind: 'rename', agentKey, prev, next: title }], orgFuture: [] }))
  },

  setAgentViewMode: (mode) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('console:agents:viewMode', mode)
    set({ agentViewMode: mode })
  },

  delegate: (toKey, brief, fromKey = 'al') => {
    sendWs({ type: 'delegate', toKey, brief, fromKey })
  },

  cancelTask: (taskId) => {
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, status: 'cancelled' } : t)) }))
    sendWs({ type: 'cancel_task', taskId })
  },

  acceptHandoff: (targetAgentKey) => {
    const sessions = get().sessions
    const al = sessions.find((s) => s.id === 'al' || s.name === 'Al')
    const live = sessions.find((s) => s.agentKey === targetAgentKey && s.status !== 'ended')
    if (live) get().selectSession(live.id)
    else get().reviveAgent(targetAgentKey) // spawns; sessions_list update lets the user land in it
    set({ pendingHandoff: null, handoffReturnTo: al?.id ?? null })
  },

  dismissHandoff: () => set({ pendingHandoff: null }),

  returnFromHandoff: () => {
    const to = get().handoffReturnTo
    set({ handoffReturnTo: null })
    if (to) get().selectSession(to)
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

  markSessionRead: (id) => {
    const sessionId = id ?? get().activeSessionId
    if (!sessionId) return
    const sess = get().sessions.find((s) => s.id === sessionId)
    // Reading an ENDED session = acknowledging a terminated chat fork / finished
    // session. It only lingered in the list because it was unread; once read,
    // remove it for good (delete from hub + manifest).
    if (sess && sess.status === 'ended') {
      // Drop locally immediately; hub delete_session broadcasts the new list.
      set((s) => ({
        sessions: s.sessions.filter((x) => x.id !== sessionId),
        ...(s.activeSessionId === sessionId ? { activeSessionId: null } : {}),
      }))
      sendWs({ type: 'delete_session', sessionId })
      return
    }
    // Optimistic local clear; hub broadcasts session_read_state which lands
    // on every client (including this one) for cross-device sync.
    if (sess) updateSession(sessionId, { lastReadIndex: sess.messageLogLength ?? 0, hasUnread: false })
    sendWs({ type: 'mark_session_read', sessionId })
    // Marking read also acknowledges any @amar attention marker.
    if (sess?.needsAttention) {
      updateSession(sessionId, { needsAttention: null })
      sendWs({ type: 'clear_attention', sessionId })
    }
  },

  markSessionUnread: (id) => {
    const sessionId = id ?? get().activeSessionId
    if (!sessionId) return
    const sess = get().sessions.find((s) => s.id === sessionId)
    if (sess) {
      const len = sess.messageLogLength ?? 0
      updateSession(sessionId, { lastReadIndex: Math.max(0, len - 1), hasUnread: len > 0 })
    }
    sendWs({ type: 'mark_session_unread', sessionId })
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

  reloadSessionHistory: (sessionId) => {
    // Drop the in-memory view + any pending deltas, then re-pull the full
    // transcript from the hub (loadSessionHistory reads the complete JSONL from
    // disk). The session_history handler prepends onto the now-empty list.
    dropBufferedMessages(sessionId) // a later flush must not resurrect rows
    set((s) => {
      const messagesBySession = { ...s.messagesBySession }; delete messagesBySession[sessionId]
      const pendingTextBySession = { ...s.pendingTextBySession }; delete pendingTextBySession[sessionId]
      const pendingThinkingBySession = { ...s.pendingThinkingBySession }; delete pendingThinkingBySession[sessionId]
      const pendingToolInputBySession = { ...s.pendingToolInputBySession }; delete pendingToolInputBySession[sessionId]
      const hasOlderBySession = { ...s.hasOlderBySession }; delete hasOlderBySession[sessionId]
      const activeSubagentsBySession = { ...s.activeSubagentsBySession }; delete activeSubagentsBySession[sessionId]
      return { messagesBySession, pendingTextBySession, pendingThinkingBySession, pendingToolInputBySession, hasOlderBySession, activeSubagentsBySession }
    })
    sendWs({ type: 'get_session_history', sessionId })
  },

  setTailing: (sessionId, tailing) => {
    const current = get().isTailingBySession[sessionId]
    if (current === tailing) return
    set((s) => ({ isTailingBySession: { ...s.isTailingBySession, [sessionId]: tailing } }))
  },

  toggleGroupCollapsed: (cwd) => {
    const next = new Set(get().collapsedGroups)
    if (next.has(cwd)) next.delete(cwd)
    else next.add(cwd)
    set({ collapsedGroups: next })
    sendWs({ type: 'set_collapsed_groups', collapsed: [...next] })
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
      seed: true,     // inject a branch-point marker so the fork knows its own work
      seedRole: true, // mint a child role (reporting to the source) so the fork
                      // appears in the org chart, not just the session list. The
                      // chart is role-keyed; a role-less fork has no node.
      ...(session.cwd ? { cwd: session.cwd } : {}),
    })
    set({
      pendingSessionActivate: true,
      pendingApproval: null,
      creatingNewSession: false,
    })
  },

  mergeSession: (sessionId) => {
    sendWs({ type: 'merge_session', sessionId })
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
    // Model config (model_state) is pushed by the hub on connect, like
    // sessions_list — no request needed.
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
      // A model-switch re-announce carries empty slashCommands — don't let it
      // clobber the real list learned from the true init.
      const slash = msg.slashCommands as string[]
      if (slash.length > 0) useAgentStore.setState({ sessionSlashCommands: slash })
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
        ...(msg.breakdown ? { contextBreakdown: msg.breakdown as ContextBreakdownEntry[] } : {}),
      })
      break
    }

    case 'project_dirs': {
      const dirs = msg.dirs as string[]
      useAgentStore.setState({ projectDirs: dirs })
      break
    }

    case 'agents_list': {
      useAgentStore.setState({
        agentRoles: (msg.roles as AgentRole[]) ?? [],
        agentTree: (msg.tree as OrgNode[]) ?? [],
      })
      break
    }

    case 'tasks': {
      useAgentStore.setState({ tasks: (msg.tasks as AgentTask[]) ?? [] })
      break
    }

    case 'session_handoff': {
      useAgentStore.setState({
        pendingHandoff: { fromSessionId: msg.sessionId as string, targetAgentKey: msg.targetAgentKey as string },
      })
      break
    }

    case 'session_merged': {
      // The fork is gone (sessions_list update handles removal); surface a toast
      // so the user knows the digest landed in the parent.
      const parentId = msg.parentId as string
      const parent = useAgentStore.getState().sessions.find((s) => s.id === parentId)
      if (!suppressNotifications) {
        import('@/notifications').then(({ notify }) => notify({
          title: 'Fork merged',
          body: `Summary folded into ${parent?.name || 'its parent'}.`,
          data: { pane: 'agents', itemId: parentId },
        })).catch(() => {})
      }
      break
    }

    case 'model_state': {
      useAgentStore.setState({
        agentModel: msg.model as string,
        agentModelChain: (msg.chain as string[]) ?? [],
        agentModelLockedByEnv: !!msg.lockedByEnv,
        ...(msg.autoFellBack
          ? { modelFallbackNotice: { failedModel: msg.failedModel as string, model: msg.model as string } }
          : {}),
      })
      if (msg.autoFellBack) {
        import('@/notifications').then(({ notify }) => notify({
          title: 'Agent model fell back',
          body: `${msg.failedModel} unavailable — switched to ${msg.model}`,
          data: { pane: 'agents' },
        })).catch(() => {})
      }
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

      // Merge hub data with local per-session state (model, context, statusText).
      // hasUnread is now derived from hub-supplied messageLogLength + lastReadIndex
      // (no longer preserved from local — hub is source of truth).
      const merged = hubSessions.map((s) => {
        const isAl = s.id === 'al'
        const local = existingMap.get(s.id) ?? (s.claudeSessionId ? existingMap.get(claudeToOldId.get(s.claudeSessionId) ?? '') : undefined)
        const hasUnread = (s.messageLogLength ?? 0) > (s.lastReadIndex ?? 0)
        return local
          ? { ...s, isAl, name: local.name ?? s.name, model: local.model, contextWindow: local.contextWindow ?? 200_000, contextUsed: local.contextUsed ?? 0, statusText: local.statusText, hasUnread }
          : { ...s, isAl, contextWindow: s.contextWindow ?? 200_000, contextUsed: s.contextUsed ?? 0, hasUnread }
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
          // Not-yet-flushed appends must follow the rename too, or the next
          // rAF flush would write them under the dead pre-restart id.
          const buffered = msgBuffer.get(oldId)
          if (buffered) { msgBuffer.set(newId, [...(msgBuffer.get(newId) ?? []), ...buffered]); msgBuffer.delete(oldId) }
        }
      }

      // Re-add preserved Al session if it was missing from hub list
      if (existingAl) merged.unshift({ ...existingAl, isAl: true, hasUnread: existingAl.hasUnread ?? false })

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

      // Auto-select first active session ONLY if no session is selected and
      // user isn't creating a new one. Skip on mobile — there the list and
      // detail are separate "screens" and auto-selecting would yank the user
      // into a session (typically Al, since it's pinned first) every time the
      // 10s sessions_list poll fires while they're browsing the list.
      const currentActiveId = useAgentStore.getState().activeSessionId
      const isCreatingNew = useAgentStore.getState().creatingNewSession
      const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
      if (!isMobile && !isCreatingNew && !currentActiveId && merged.length > 0) {
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
      bumpMessageLog(sessionId)
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

    case 'tool_input_delta': {
      const sessionId = msg.sessionId as string
      bufferToolInputDelta(sessionId, msg.toolUseId as string, msg.toolName as string, msg.content as string)
      break
    }

    case 'tool_use': {
      const sessionId = msg.sessionId as string
      const toolName = msg.toolName as string
      const toolUseId = msg.toolUseId as string
      const input = msg.input as Record<string, unknown>
      flushPending(sessionId)
      // The finalized tool_use supersedes its live input preview.
      if (useAgentStore.getState().pendingToolInputBySession[sessionId]) {
        useAgentStore.setState((s) => {
          const next = { ...s.pendingToolInputBySession }
          delete next[sessionId]
          return { pendingToolInputBySession: next }
        })
      }
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

    case 'tool_diff': {
      const sessionId = msg.sessionId as string
      addMessage(sessionId, {
        type: 'tool_diff',
        toolUseId: msg.toolUseId as string,
        filePath: msg.filePath as string,
        hunks: msg.hunks as DiffHunk[],
      })
      break
    }

    case 'bg_task': {
      const sessionId = msg.sessionId as string
      addMessage(sessionId, {
        type: 'bg_task',
        taskId: msg.taskId as string,
        status: msg.status as 'started' | 'completed' | 'failed',
        description: msg.description as string | undefined,
        taskType: msg.taskType as string | undefined,
        summary: msg.summary as string | undefined,
      })
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

      const approval: PendingApproval = { sessionId: approvalSessionId, requestId, toolName, input }
      useAgentStore.setState((s) => ({
        pendingApprovalsBySession: { ...s.pendingApprovalsBySession, [approvalSessionId]: approval },
        // Only surface in the denormalized view when it belongs to the active session
        ...(s.activeSessionId === approvalSessionId ? { pendingApproval: approval } : {}),
      }))
      bumpMessageLog(approvalSessionId)
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
      // Turn over — a lingering tool-input preview would be stale.
      if (useAgentStore.getState().pendingToolInputBySession[sessionId]) {
        useAgentStore.setState((s) => {
          const next = { ...s.pendingToolInputBySession }
          delete next[sessionId]
          return { pendingToolInputBySession: next }
        })
      }

      addMessage(sessionId, {
        type: 'result',
        cost,
        tokens,
        duration,
        ttftMs: msg.ttftMs as number | undefined,
        stopReason: msg.stopReason as string | null | undefined,
        numTurns: msg.numTurns as number | undefined,
        modelUsage: msg.modelUsage as ResultModelUsage[] | undefined,
      })

      updateSession(sessionId, {
        status: 'idle',
        statusText: undefined,
        // cost from hub is cumulative (total_cost_usd), not per-turn
        totalCost: cost,
      })

      bumpMessageLog(sessionId)

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
      bumpMessageLog(sessionId)
      break
    }

    case 'session_ended': {
      const sessionId = msg.sessionId as string
      updateSession(sessionId, { status: 'ended', statusText: undefined })
      // Drop any pending approval for the session — it can't be answered anymore
      const pending = useAgentStore.getState().pendingApprovalsBySession[sessionId]
      if (pending) clearApprovalByRequestId(pending.requestId)
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

    case 'collapsed_groups': {
      useAgentStore.setState({ collapsedGroups: new Set(msg.collapsed as string[]) })
      break
    }

    case 'session_read_state': {
      const sessionId = msg.sessionId as string
      const lastReadIndex = msg.lastReadIndex as number
      const messageLogLength = msg.messageLogLength as number
      useAgentStore.setState((s) => ({
        sessions: s.sessions.map((sess) => sess.id === sessionId
          ? { ...sess, lastReadIndex, messageLogLength: Math.max(sess.messageLogLength ?? 0, messageLogLength), hasUnread: Math.max(sess.messageLogLength ?? 0, messageLogLength) > lastReadIndex }
          : sess),
      }))
      break
    }

    case 'session_attention': {
      const sessionId = msg.sessionId as string
      const needsAttention = msg.needsAttention as { ts: number; snippet: string } | null
      updateSession(sessionId, { needsAttention })
      // The marker stays sticky until Yousef marks the session read — opening it
      // (even being the active session) does NOT clear it. Only skip the desktop
      // notification when he's already looking at this session, or during replay.
      if (needsAttention && !suppressNotifications) {
        const active = useAgentStore.getState().activeSessionId === sessionId
        if (!active) {
          const sess = useAgentStore.getState().sessions.find((s) => s.id === sessionId)
          import('@/notifications').then(({ notify }) => {
            notify({
              title: `${(msg.sessionName as string) || sess?.name || 'Agent'} wants your attention`,
              body: needsAttention.snippet || '@amar',
              icon: '/icon-192.png',
              tag: `attention-${sessionId}`,
              data: { pane: 'agents', itemId: sessionId },
            })
          })
        }
      }
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

    case 'tool_approved':
    case 'tool_denied': {
      clearApprovalByRequestId(msg.requestId as string)
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
    case 'tool_diff': return { type: 'tool_diff', toolUseId: m.toolUseId as string, filePath: m.filePath as string, hunks: m.hunks as DiffHunk[] }
    case 'bg_task': return { type: 'bg_task', taskId: m.taskId as string, status: m.status as 'started' | 'completed' | 'failed', description: m.description as string | undefined, taskType: m.taskType as string | undefined, summary: m.summary as string | undefined }
    case 'user_prompt': return { type: 'user_prompt', content: m.content as string, ...(m.images ? { images: m.images as string[] } : {}) }
    case 'error': return { type: 'error', message: m.message as string }
    case 'result': return { type: 'result', cost: m.cost as number, tokens: m.tokens as TokenUsage, duration: m.duration as number, ttftMs: m.ttftMs as number | undefined, stopReason: m.stopReason as string | null | undefined, numTurns: m.numTurns as number | undefined, modelUsage: m.modelUsage as ResultModelUsage[] | undefined }
    default: return null
  }
}

/** Increment local messageLogLength on new logged content and re-derive
 *  hasUnread. Hub is the source of truth for lastReadIndex (synced via
 *  session_read_state); we only bump our local count of messages so the
 *  derived flag flips without waiting for a sessions_list refresh. */
function bumpMessageLog(sessionId: string) {
  useAgentStore.setState((s) => ({
    sessions: s.sessions.map((sess) => {
      if (sess.id !== sessionId) return sess
      const newLen = (sess.messageLogLength ?? 0) + 1
      return { ...sess, messageLogLength: newLen, hasUnread: newLen > (sess.lastReadIndex ?? 0) }
    }),
  }))
}

/** Remove an approval from the per-session map (and the denormalized view if it
 *  matches). Triggered locally on approve/deny and via tool_approved/tool_denied
 *  broadcasts from other clients. */
function clearApprovalByRequestId(requestId: string) {
  useAgentStore.setState((s) => {
    const map = s.pendingApprovalsBySession
    let foundSessionId: string | null = null
    for (const [sid, a] of Object.entries(map)) {
      if (a.requestId === requestId) { foundSessionId = sid; break }
    }
    const clearView = s.pendingApproval?.requestId === requestId
    // Always honour clearView even when the per-session map has no matching
    // entry — the denormalized view is the truth UI components subscribe to,
    // and approve/deny on the active session must clear it deterministically.
    if (!foundSessionId) {
      return clearView ? { pendingApproval: null } : s
    }
    const next = { ...map }
    delete next[foundSessionId]
    return { pendingApprovalsBySession: next, ...(clearView ? { pendingApproval: null } : {}) }
  })
}

function updateSession(sessionId: string, updates: Partial<SessionInfo>) {
  useAgentStore.setState((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId ? { ...sess, ...updates } : sess,
    ),
  }))
}

// Message batching — the hub replays ~REPLAY_LIMIT messages PER SESSION on
// every WS (re)connect (≈1,400 messages with a 48-session fleet). One setState
// per message = one full-store clone + notify of every Zustand subscriber per
// message; that burst lands exactly when the phone foregrounds (the sync
// watchdog reconnects) and visibly stalls typing on mobile. Buffer appends in a
// plain Map and flush once per animation frame — same pattern as the
// text-delta buffer below. Order within a session is preserved (per-session
// FIFO array), and callers never read messagesBySession synchronously after
// addMessage (verified), so a ≤1-frame flush delay is invisible.
const msgBuffer = new Map<string, AgentMessage[]>()
let msgRafHandle: number | null = null

/** Discard not-yet-flushed appends for a session — used by the /clear and
 *  reload-history paths, where a later flush would resurrect pre-clear rows. */
function dropBufferedMessages(sessionId: string) {
  msgBuffer.delete(sessionId)
}

function addMessage(sessionId: string, block: AgentMessage['block']) {
  const arr = msgBuffer.get(sessionId)
  const msg: AgentMessage = { id: nextId(), timestamp: Date.now(), block }
  if (arr) arr.push(msg)
  else msgBuffer.set(sessionId, [msg])
  if (msgRafHandle === null) msgRafHandle = requestAnimationFrame(drainMessageBuffer)
}

function drainMessageBuffer() {
  msgRafHandle = null
  if (msgBuffer.size === 0) return
  const entries = Array.from(msgBuffer.entries())
  msgBuffer.clear()
  useAgentStore.setState((s) => {
    const messagesBySession = { ...s.messagesBySession }
    let hasOlder: Record<string, boolean> | null = null
    for (const [sessionId, msgs] of entries) {
      const appended = [...(messagesBySession[sessionId] ?? []), ...msgs]
      // Cap the in-memory window when the user is tailing — older entries stay on the hub.
      const tailing = s.isTailingBySession[sessionId] !== false // default to true if unset
      if (tailing && appended.length > MAX_VISIBLE_MESSAGES) {
        messagesBySession[sessionId] = appended.slice(appended.length - MAX_VISIBLE_MESSAGES)
        if (!hasOlder) hasOlder = { ...s.hasOlderBySession }
        hasOlder[sessionId] = true
      } else {
        messagesBySession[sessionId] = appended
      }
    }
    return hasOlder ? { messagesBySession, hasOlderBySession: hasOlder } : { messagesBySession }
  })
}

// Delta batching — stream chunks can fire many times per frame. Each setState
// creates a new pendingXBySession map and notifies every Zustand subscriber in
// the app; during bursts this saturates the main thread and delays input events.
// Accumulate deltas in a plain Map and flush once per animation frame.
const deltaBuffer = new Map<string, { text: string; thinking: string; toolInput?: { toolUseId: string; toolName: string; json: string } }>()
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

/** Buffer a chunk of streaming tool-call arguments (input_json_delta) — same
 *  per-frame coalescing as text/thinking so typing stays smooth. A new
 *  toolUseId resets the accumulator (one live tool preview per session). */
function bufferToolInputDelta(sessionId: string, toolUseId: string, toolName: string, chunk: string) {
  let entry = deltaBuffer.get(sessionId)
  if (!entry) {
    entry = { text: '', thinking: '' }
    deltaBuffer.set(sessionId, entry)
  }
  if (!entry.toolInput || entry.toolInput.toolUseId !== toolUseId) {
    // Chain from what's already in the store when the same call continues
    // across frames; start fresh when a new tool call begins.
    const existing = useAgentStore.getState().pendingToolInputBySession[sessionId]
    entry.toolInput = existing?.toolUseId === toolUseId
      ? { ...existing }
      : { toolUseId, toolName, json: '' }
  }
  entry.toolInput.json += chunk
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
    let newToolInput = s.pendingToolInputBySession
    for (const [sessionId, buf] of entries) {
      if (buf.text) newText[sessionId] = (newText[sessionId] ?? '') + buf.text
      if (buf.thinking) newThinking[sessionId] = (newThinking[sessionId] ?? '') + buf.thinking
      if (buf.toolInput) {
        if (newToolInput === s.pendingToolInputBySession) newToolInput = { ...newToolInput }
        newToolInput[sessionId] = buf.toolInput
      }
    }
    return { pendingTextBySession: newText, pendingThinkingBySession: newThinking, pendingToolInputBySession: newToolInput }
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

/** The flat session order exactly as the sidebar renders it (Al pinned first,
 *  then sessions clustered by cwd in `sessionOrder`, fork lineage, collapsed
 *  groups skipped, and the "needs me" filter applied) — so j/k cycling moves
 *  top-to-bottom through what the user actually sees. */
function visibleSidebarOrder(s: AgentState): SessionInfo[] {
  const isAlerted = (x: SessionInfo) => !!(x.hasUnread || x.needsAttention || s.pendingApprovalsBySession[x.id] || x.status === 'running')
  const al = s.sessions.find((x) => x.id === 'al')
  const active = s.sessions.filter((x) =>
    x.id !== 'al'
    && (x.status !== 'ended' || x.hasUnread)
    && (!s.filterAlerted || isAlerted(x)))
  const ordered: SessionInfo[] = []
  if (al && (!s.filterAlerted || isAlerted(al))) ordered.push(al)
  ordered.push(...flattenSidebarOrder(active, s.sessionOrder, s.collapsedGroups))
  return ordered
}
