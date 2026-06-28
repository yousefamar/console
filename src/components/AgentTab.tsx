import { Fragment, memo, useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { useAgentStore } from '@/store/agent'
import { useUiStore } from '@/store/ui'
import { AgentSessionView } from './AgentSessionView'
import { ContextMenu } from './ContextMenu'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { useSwipeActions } from '@/hooks/useSwipeActions'
import clsx from 'clsx'
import { AlertCircle, ArrowLeft, Check, ChevronDown, ChevronRight, Circle, ClipboardList, Clock, Folder, FolderOpen, GitBranch, ListFilter, Mic, Network, List, Plus, Terminal, X } from 'lucide-react'
import { useMicStore } from '@/store/mic'
import { AgentOrgChart } from './agent/AgentOrgChart'
import { AgentProfilePanel } from './agent/AgentProfilePanel'
import { TasksPanel } from './agent/TasksPanel'
import { AgentQuickSwitcher } from './agent/AgentQuickSwitcher'
import { buildGroupTree, peelUniversalRoot, arrangeLineage, type GroupNode } from './agent/session-tree'
import { useCronStore } from '@/store/cron'
import type { SessionInfo } from '@/store/agent'
import type { ContextMenuItem } from './ContextMenu'

// ============================================================================
// AgentTab — top-level component for the Agents pane. Shows a session
// sidebar (desktop) and the active session view.
// ============================================================================

export const AgentTab = memo(function AgentTab() {
  const connected = useAgentStore((s) => s.connected)
  const connect = useAgentStore((s) => s.connect)
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const selectSession = useAgentStore((s) => s.selectSession)
  const sessionOrder = useAgentStore((s) => s.sessionOrder)
  const reorderSession = useAgentStore((s) => s.reorderSession)
  const collapsedGroups = useAgentStore((s) => s.collapsedGroups)
  const toggleGroupCollapsed = useAgentStore((s) => s.toggleGroupCollapsed)
  const creatingNewSession = useAgentStore((s) => s.creatingNewSession)
  const agentModel = useAgentStore((s) => s.agentModel)
  const agentModelChain = useAgentStore((s) => s.agentModelChain)
  const agentModelLockedByEnv = useAgentStore((s) => s.agentModelLockedByEnv)
  const setAgentModel = useAgentStore((s) => s.setAgentModel)
  const modelFallbackNotice = useAgentStore((s) => s.modelFallbackNotice)
  const dismissModelFallbackNotice = useAgentStore((s) => s.dismissModelFallbackNotice)
  const agentViewMode = useAgentStore((s) => s.agentViewMode)
  const setAgentViewMode = useAgentStore((s) => s.setAgentViewMode)
  const filterAlerted = useAgentStore((s) => s.filterAlerted)
  const toggleFilterAlerted = useAgentStore((s) => s.toggleFilterAlerted)
  const roleInfoKey = useAgentStore((s) => s.roleInfoKey)
  const closeRoleInfo = useAgentStore((s) => s.closeRoleInfo)
  const showAgentSwitcher = useAgentStore((s) => s.showAgentSwitcher)
  const undoOrg = useAgentStore((s) => s.undoOrg)
  const redoOrg = useAgentStore((s) => s.redoOrg)
  const openTaskCount = useAgentStore((s) => s.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked').length)
  const pendingHandoff = useAgentStore((s) => s.pendingHandoff)
  const handoffReturnTo = useAgentStore((s) => s.handoffReturnTo)
  const acceptHandoff = useAgentStore((s) => s.acceptHandoff)
  const dismissHandoff = useAgentStore((s) => s.dismissHandoff)
  const returnFromHandoff = useAgentStore((s) => s.returnFromHandoff)
  const agentRoles = useAgentStore((s) => s.agentRoles)
  const [showTasks, setShowTasks] = useState(false)
  const isMobile = useIsMobile()

  // Separate Al from regular sessions — always pinned at top.
  // Keep ENDED sessions visible while they're still unread, so a terminated
  // chat fork (or any finished session) survives for audit until acknowledged.
  // Marking it read removes it (see markSessionRead → delete on ended).
  const alSession = sessions.find((s) => s.id === 'al')

  // "Needs me" filter — show only sessions that want attention or are in
  // flight: unread, @amar-flagged, blocked on a tool approval, or actively
  // running (the orange status dot). Shared with the org chart (store-backed,
  // persisted) so toggling it in either view sticks.
  const pendingApprovals = useAgentStore((s) => s.pendingApprovalsBySession)
  const isAlerted = (s: SessionInfo) =>
    !!(s.hasUnread || s.needsAttention || pendingApprovals[s.id] || s.status === 'running')

  const activeSessions = sessions.filter((s) =>
    s.id !== 'al'
    && (s.status !== 'ended' || s.hasUnread)
    && (!filterAlerted || isAlerted(s)))
  const showAl = !!alSession && (!filterAlerted || isAlerted(alSession!))

  // Auto-connect on mount
  useEffect(() => {
    connect()
    return () => {
      // Don't disconnect on unmount — keep connection alive across tab switches
    }
  }, [connect])

  // Subscribe to push-to-talk mic ownership (hub SyncBus 'mic' service).
  useEffect(() => { useMicStore.getState().init() }, [])

  // Hydrate the cron store for ALL sessions so the sidebar can render per-row
  // task counts. Refresh every 30s for cross-client mutations.
  const refreshAllCron = useCronStore((s) => s.refreshAll)
  useEffect(() => {
    refreshAllCron()
    const id = setInterval(() => refreshAllCron(), 30_000)
    return () => clearInterval(id)
  }, [refreshAllCron])

  // Periodically re-fetch the session list so `backgroundProcessCount` stays
  // current — the hub only recomputes that field on `getInfo()` calls. 10s
  // matches the cadence at which a background shell starting/exiting becomes
  // visible in the sidebar.
  const listSessions = useAgentStore((s) => s.listSessions)
  useEffect(() => {
    const id = setInterval(() => listSessions(), 10_000)
    return () => clearInterval(id)
  }, [listSessions])

  // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z = redo, for org-chart
  // edge/rename edits. Only while the Agents pane is active and focus isn't in a
  // text field (so the rename input / prompt box keep their native undo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useUiStore.getState().activePane !== 'agents') return
      if (!(e.metaKey || e.ctrlKey)) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoOrg() }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redoOrg() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoOrg, redoOrg])

  const handleNewSession = useCallback(() => {
    selectSession(null)
    // Focus the prompt input
    setTimeout(() => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-agent-input]')
      el?.focus()
    }, 50)
  }, [selectSession])

  const showList = isMobile ? (!activeSessionId && !creatingNewSession) : true
  const showDetail = isMobile ? (!!activeSessionId || creatingNewSession || !connected) : true

  const viewToggle = (
    <button
      onClick={() => setAgentViewMode(agentViewMode === 'orgchart' ? 'list' : 'orgchart')}
      className="text-text-tertiary hover:text-text-primary transition-colors duration-fast"
      title={agentViewMode === 'orgchart' ? 'Switch to session list' : 'Switch to org chart'}
    >
      {agentViewMode === 'orgchart' ? <List size={12} /> : <Network size={12} />}
    </button>
  )

  // Shared "needs me" filter toggle — used by both the list and org-chart headers.
  const filterToggle = (
    <button
      onClick={toggleFilterAlerted}
      className={clsx(
        'transition-colors duration-fast',
        filterAlerted ? 'text-blue-500 hover:text-blue-400' : 'text-text-tertiary hover:text-text-primary',
      )}
      title={filterAlerted ? 'Showing only unread / needs-attention — click to show all' : 'Show only unread / needs-attention'}
    >
      <ListFilter size={12} />
    </button>
  )

  // Delegation tasks panel toggle (with an open-count dot).
  const tasksToggle = (
    <button
      onClick={() => setShowTasks((v) => !v)}
      className={clsx('relative transition-colors duration-fast', showTasks ? 'text-violet-400 hover:text-violet-300' : 'text-text-tertiary hover:text-text-primary')}
      title="Delegation tasks"
    >
      <ClipboardList size={12} />
      {openTaskCount > 0 && <span className="absolute -right-1.5 -top-1 rounded-full bg-violet-500 px-1 text-[8px] font-semibold leading-[1.3] text-white">{openTaskCount}</span>}
    </button>
  )

  // Overlays shared by both views: the role info dialog, the tasks panel, the
  // hand-off offer banner, and the Back-to-Al return control.
  const overlays = (
    <>
      {showAgentSwitcher && <AgentQuickSwitcher />}
      <AgentInfoDialog roleKey={roleInfoKey} onClose={closeRoleInfo} />
      {showTasks && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => setShowTasks(false)}>
          <div className="h-[70vh] w-full overflow-hidden rounded-t-xl border border-border shadow-xl sm:h-[80vh] sm:max-w-md sm:rounded-xl" onClick={(e) => e.stopPropagation()}>
            <TasksPanel onClose={() => setShowTasks(false)} />
          </div>
        </div>
      )}
      {pendingHandoff && (
        <div className="fixed bottom-4 left-1/2 z-50 flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-lg border border-violet-500/40 bg-surface-2 px-3 py-2 shadow-xl">
          <span className="text-xs text-text-secondary">Al suggests you talk to <span className="font-medium text-text-primary">{agentRoles.find((r) => r.key === pendingHandoff.targetAgentKey)?.title ?? pendingHandoff.targetAgentKey}</span></span>
          <button onClick={() => acceptHandoff(pendingHandoff.targetAgentKey)} className="rounded bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-500">Talk →</button>
          <button onClick={dismissHandoff} className="text-text-tertiary hover:text-text-primary"><X size={13} /></button>
        </div>
      )}
      {handoffReturnTo && !pendingHandoff && (
        <button onClick={returnFromHandoff} className="fixed bottom-4 left-4 z-40 flex items-center gap-1 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-[11px] text-text-secondary shadow-lg hover:text-text-primary">
          <ArrowLeft size={12} /> Back to Al
        </button>
      )}
    </>
  )

  // Org-chart mode: the chart replaces the session LIST (left), the chat panel
  // stays on the right (mirrors the Notes circles-view + editor layout). Mobile
  // shows one at a time. Left-click on an agent opens its session; on a folder
  // opens its info dialog. The rich profile is now a modal (right-click → Show
  // info), not a space-hogging bottom card.
  if (agentViewMode === 'orgchart') {
    const handlePickRole = (roleKey: string) => {
      const liveForRole = sessions.find((s) => s.agentKey === roleKey && s.status !== 'ended')
      if (liveForRole) selectSession(liveForRole.id)
      else useAgentStore.getState().openRoleInfo(roleKey) // folders / parked roles have no session → show info
    }
    const chartPanel = (
      <div className="flex flex-1 min-h-0 flex-col">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
          <span className="text-xs font-medium text-text-primary">Org chart</span>
          <div className="flex items-center gap-2">
            {tasksToggle}
            {filterToggle}
            {viewToggle}
          </div>
        </div>
        <div className="relative flex-1 min-h-0">
          <AgentOrgChart onPick={handlePickRole} />
        </div>
      </div>
    )
    if (isMobile) {
      return (
        <div className="flex flex-1 h-full min-w-0 flex-col">
          {activeSessionId || creatingNewSession ? <AgentSessionView /> : chartPanel}
          {overlays}
        </div>
      )
    }
    return (
      <div className="flex flex-1 h-full min-w-0">
        <div className="w-[42%] min-w-[340px] max-w-[640px] flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
          {chartPanel}
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
          <AgentSessionView />
        </div>
        {overlays}
      </div>
    )
  }

  return (
    <div className="flex flex-1 h-full min-w-0">
      {/* Session sidebar */}
      {showList && (
        <div className={`${isMobile ? 'w-full' : 'w-72'} flex-shrink-0 border-r border-border overflow-hidden flex flex-col`}>
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <span className="text-xs font-medium text-text-primary">Sessions</span>
            <div className="flex items-center gap-2">
              {viewToggle}
              {filterToggle}
              {tasksToggle}
              <button
                onClick={handleNewSession}
                className="text-text-tertiary hover:text-text-primary transition-colors duration-fast"
                title="New session"
              >
                <Plus size={12} />
              </button>
              <Circle
                size={6}
                className={clsx(
                  'fill-current',
                  connected ? 'text-success' : 'text-destructive',
                )}
              />
              <span className="text-[10px] text-text-tertiary">
                {connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
          </div>

          {modelFallbackNotice && (
            <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
              <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
              <span className="flex-1 leading-snug">
                <span className="font-mono">{modelFallbackNotice.failedModel}</span> was unavailable — agents fell back to <span className="font-mono">{modelFallbackNotice.model}</span>.
              </span>
              <button onClick={dismissModelFallbackNotice} className="flex-shrink-0 text-amber-300/70 hover:text-amber-200" title="Dismiss">
                <Check size={13} />
              </button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto">
            {/* Al — pinned at top */}
            {showAl && alSession && <AlListItem session={alSession} isActive={alSession.id === activeSessionId} onSelect={selectSession} />}

            {activeSessions.length === 0 && !showAl && connected && (
              <div className="flex h-32 items-center justify-center">
                <p className="text-xs text-text-tertiary">
                  {filterAlerted ? 'Nothing needs you' : 'No active sessions'}
                </p>
              </div>
            )}
            {(() => {
              const { rootSessions, roots } = peelUniversalRoot(buildGroupTree(activeSessions, sessionOrder))
              return (
                <>
                  <SessionLineage
                    sessions={rootSessions}
                    baseIndent={0}
                    activeSessionId={activeSessionId}
                    onSelect={selectSession}
                    onReorder={reorderSession}
                  />
                  {roots.map((node) => (
                    <GroupSection
                      key={node.cwd}
                      node={node}
                      activeSessionId={activeSessionId}
                      collapsedGroups={collapsedGroups}
                      onToggleCollapsed={toggleGroupCollapsed}
                      onSelect={selectSession}
                      onReorder={reorderSession}
                    />
                  ))}
                </>
              )
            })()}
          </div>

          {/* Model picker — switch the model all agents spawn with. The manual
              recovery lever when a model is pulled; auto-fallback handles the
              rest. */}
          <div className="flex items-center gap-1.5 border-t border-border px-3 py-1.5">
            <span className="text-[10px] text-text-tertiary flex-shrink-0">Model</span>
            <select
              value={agentModel}
              onChange={(e) => setAgentModel(e.target.value)}
              disabled={agentModelLockedByEnv || !connected || agentModelChain.length === 0}
              title={agentModelLockedByEnv ? 'Locked by the CLAUDE_MODEL env var — unset it to change the model here' : 'Model all hub agents spawn with. Changing it restarts live sessions onto it.'}
              className="flex-1 min-w-0 bg-transparent text-[11px] text-text-secondary font-mono outline-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 truncate"
            >
              {/* Ensure the active model is selectable even if not in the chain. */}
              {agentModel && !agentModelChain.includes(agentModel) && (
                <option value={agentModel}>{agentModel}</option>
              )}
              {agentModelChain.map((m, i) => (
                <option key={m} value={m}>{m}{i === 0 ? '' : ` (fallback ${i})`}</option>
              ))}
            </select>
            {agentModelLockedByEnv && (
              <span className="text-[9px] uppercase tracking-wider text-amber-400/80 flex-shrink-0" title="Pinned by CLAUDE_MODEL env var">env</span>
            )}
          </div>
        </div>
      )}

      {/* Session view */}
      {showDetail && (
        <div className="flex-1 min-w-0 flex flex-col">
          <AgentSessionView />
        </div>
      )}
      {overlays}
    </div>
  )
})

// --------------------------------------------------------------------------
// Agent info dialog — the role profile (charter / goals / memory / manager /
// lifecycle actions) as a centered modal. Replaces the old bottom card so it
// doesn't eat the chart's space; available in both views via "Show info".
// --------------------------------------------------------------------------

function AgentInfoDialog({ roleKey, onClose }: { roleKey: string | null; onClose: () => void }) {
  useEffect(() => {
    if (!roleKey) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [roleKey, onClose])

  if (!roleKey) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-h-[85vh] overflow-y-auto rounded-t-xl border border-border bg-surface-1 shadow-xl sm:max-w-md sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <AgentProfilePanel key={roleKey} agentKey={roleKey} onClose={onClose} />
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// Session list item with context menu
// --------------------------------------------------------------------------

const SessionListItem = memo(function SessionListItem({ session, isActive, indent, onSelect, onReorder }: {
  session: SessionInfo
  isActive: boolean
  indent: number
  onSelect: (id: string) => void
  onReorder: (fromId: string, toId: string) => void
}) {
  const killSession = useAgentStore((s) => s.killSession)
  const forkSession = useAgentStore((s) => s.forkSession)
  const mergeSession = useAgentStore((s) => s.mergeSession)
  const isMicOwner = useMicStore((s) => s.owner === session.id)
  const renameSession = useAgentStore((s) => s.renameSession)
  const generateTitleAction = useAgentStore((s) => s.generateTitle)
  const markSessionRead = useAgentStore((s) => s.markSessionRead)
  const markSessionUnread = useAgentStore((s) => s.markSessionUnread)
  const reloadSessionHistory = useAgentStore((s) => s.reloadSessionHistory)
  // Mergeable up if it's a fork (shares a parent's conversation) OR an org child
  // (its role has a manager to absorb it). Roots (Al) have no parent.
  const canMergeUp = useAgentStore((s) =>
    !!session.parentClaudeSessionId
    || (!!session.agentKey && session.agentKey !== 'al' && !!s.agentRoles.find((r) => r.key === session.agentKey)?.manager))
  const openRoleInfo = useAgentStore((s) => s.openRoleInfo)
  const isGenerating = useAgentStore((s) => s.generatingTitleFor.has(session.id))
  const isMobile = useIsMobile()
  // Latest text/prompt snippet — same pattern as Al, gives a glanceable activity preview
  const lastText = useAgentStore((s) => {
    const msgs = s.messagesBySession[session.id]
    if (!msgs) return null
    for (let i = msgs.length - 1; i >= 0; i--) {
      const block = msgs[i]!.block
      if (block.type === 'text') return block.content.slice(0, 100)
      if (block.type === 'user_prompt') return block.content.slice(0, 100)
    }
    return null
  })
  const subtitle = session.statusText || lastText
  // Live background-shell count from the hub: child PIDs of the claude
  // subprocess (via `ps -eo pid,ppid`). Reflects actual running processes
  // rather than guessing from the message stream.
  const bgBashCount = session.backgroundProcessCount ?? 0
  // Active cron tasks for this session (only counts the non-disabled ones).
  const cronCount = useCronStore((s) => {
    const csid = session.claudeSessionId
    if (!csid) return 0
    return (s.tasksBySession[csid] ?? []).filter((t) => !t.disabledAt).length
  })
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout>>(null)
  const itemRef = useRef<HTMLButtonElement>(null)
  // Mobile-only: per-row swipe-right marks the session read (mirrors the
  // session-view swipe). Coexists with the long-press-to-drag-reorder timer
  // by clearing the timer the moment the swipe hook decides direction.
  const swipeContainerRef = useRef<HTMLDivElement>(null)
  const swipeContentRef = useRef<HTMLDivElement>(null)
  const swipeIconRef = useRef<HTMLDivElement>(null)
  const swipeUnreadIconRef = useRef<HTMLDivElement>(null)
  const swipe = useSwipeActions(swipeContainerRef, swipeContentRef, {
    onSwipeStart: () => { if (longPressTimer.current) clearTimeout(longPressTimer.current) },
    onSwipeRight: () => markSessionRead(session.id),
    onSwipeLeft: () => markSessionUnread(session.id),
    leftIconRef: swipeIconRef,
    rightIconRef: swipeUnreadIconRef,
  })

  const rawName = session.name || session.prompt || session.id
  // Forks are named "<parent> (fork)". Show a branch glyph + the bare parent
  // name instead of the noisy suffix, so chat forks read cleanly in the list.
  const isFork = /\s\(fork\)$/.test(session.name || '')
  const displayName = isFork ? rawName.replace(/\s\(fork\)$/, '') : rawName
  const isEnded = session.status === 'ended'

  const startRename = useCallback(() => {
    setRenameValue(rawName)
    setIsRenaming(true)
    // Focus after render
    setTimeout(() => inputRef.current?.select(), 0)
  }, [rawName])

  const commitRename = useCallback(() => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== rawName) {
      renameSession(session.id, trimmed)
    }
    setIsRenaming(false)
  }, [renameValue, rawName, session.id, renameSession])

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [
      { label: 'Rename', onClick: startRename },
      { label: 'Generate title', onClick: () => generateTitleAction(session.id) },
      { label: 'Reload history', onClick: () => reloadSessionHistory(session.id) },
      { label: 'Fork', onClick: () => forkSession(session.id) },
    ]
    if (session.agentKey) {
      items.unshift({ label: 'Show info', onClick: () => openRoleInfo(session.agentKey!) })
    }
    // Mark unread (mobile-reachable equivalent of the Shift+E shortcut / swipe-left).
    items.push({ label: 'Mark unread', onClick: () => markSessionUnread(session.id) })
    // Push-to-talk mic: hand it to this session (or release the owner's to Al).
    items.push(isMicOwner
      ? { label: 'Release mic to Al', onClick: () => useMicStore.getState().setMic('al') }
      : { label: 'Give mic to this agent', onClick: () => useMicStore.getState().setMic(session.id) })
    // A child folds into its parent (fork lineage) or its manager (org edge) so
    // the parent absorbs its knowledge — instead of just killing it.
    if (canMergeUp && session.status !== 'ended') {
      items.push({ label: 'Merge into parent', onClick: () => mergeSession(session.id) })
    }
    if (session.status !== 'ended') {
      items.push({
        label: 'End session',
        onClick: () => killSession(session.id),
        destructive: true,
      })
    }
    return items
  }, [session.status, session.id, session.agentKey, session.parentClaudeSessionId, canMergeUp, isMicOwner, killSession, mergeSession, markSessionUnread, startRename, generateTitleAction, forkSession, reloadSessionHistory, openRoleInfo])

  return (
    <ContextMenu items={menuItems}>
      <div ref={swipeContainerRef} className="relative">
        {isMobile && (
          <div
            ref={swipeIconRef}
            className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none z-10"
            style={{ opacity: 0 }}
          >
            <Check size={16} className="text-green-500" />
          </div>
        )}
        {isMobile && (
          <div
            ref={swipeUnreadIconRef}
            className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none z-10"
            style={{ opacity: 0 }}
          >
            <Circle size={10} className="fill-blue-500 text-blue-500" />
          </div>
        )}
        <div
          ref={isMobile ? swipeContentRef : null}
          {...(isMobile ? { onTouchStart: swipe.onTouchStart, onTouchMove: swipe.onTouchMove, onTouchEnd: swipe.onTouchEnd } : {})}
        >
      <button
        ref={itemRef}
        draggable={!isRenaming}
        onClick={() => onSelect(session.id)}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', session.id)
          e.dataTransfer.setData('application/x-agent-cwd', session.cwd ?? '')
        }}
        onDragOver={(e) => {
          // Reorder only within the same group (cwd) — cross-group drag is a no-op
          const fromCwd = e.dataTransfer.types.includes('application/x-agent-cwd')
            ? e.dataTransfer.getData('application/x-agent-cwd')
            : null
          if (fromCwd !== null && fromCwd !== (session.cwd ?? '')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setIsDragOver(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragOver(false)
          const fromId = e.dataTransfer.getData('text/plain')
          const fromCwd = e.dataTransfer.getData('application/x-agent-cwd')
          if (fromId && fromId !== session.id && fromCwd === (session.cwd ?? '')) {
            onReorder(fromId, session.id)
          }
        }}
        onDragEnd={() => setIsDragOver(false)}
        onTouchStart={() => {
          longPressTimer.current = setTimeout(() => {
            if (itemRef.current) {
              itemRef.current.draggable = true
              itemRef.current.style.opacity = '0.5'
            }
          }, 500)
        }}
        onTouchEnd={() => {
          if (longPressTimer.current) clearTimeout(longPressTimer.current)
          if (itemRef.current) {
            itemRef.current.style.opacity = ''
          }
        }}
        className={clsx(
          'group w-full text-left py-1.5 pr-2 border-b transition-colors duration-fast',
          isDragOver ? 'border-t-2 border-t-text-primary border-b-border' : 'border-b-border',
          // @amar attention: prominent red left rail + tint so it can't be missed.
          session.needsAttention ? 'border-l-2 border-l-red-500 bg-red-500/5' : '',
          isActive ? 'bg-surface-2' : 'hover:bg-surface-1',
        )}
        style={{ paddingLeft: `${8 + indent * 10}px` }}
      >
        {isRenaming ? (
          <input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setIsRenaming(false)
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full text-xs font-medium bg-surface-1 border border-border rounded px-1 py-0.5 text-text-primary outline-none"
            autoFocus
          />
        ) : (
          <div className="flex items-center justify-between">
            <span className={clsx(
              'flex items-center gap-1 text-xs truncate max-w-[200px]',
              isEnded ? 'text-text-tertiary' :
              isGenerating ? 'text-text-tertiary italic font-medium' :
              session.hasUnread ? 'text-text-primary font-semibold' : 'text-text-primary font-medium',
            )}>
              {isFork && <GitBranch size={10} className="flex-shrink-0 opacity-70" />}
              <span className="truncate">{isGenerating ? 'Generating title…' : displayName}</span>
            </span>
            <div className="flex items-center gap-1.5">
              <MicButton sessionId={session.id} active={isActive} />
              {session.needsAttention && (
                <span
                  className="flex items-center gap-0.5 text-[10px] text-red-500 font-semibold flex-shrink-0"
                  title={session.needsAttention.snippet || 'This session wants your attention (@amar)'}
                >
                  <AlertCircle size={11} className="fill-red-500/20" />
                </span>
              )}
              {isEnded && (
                <span className="text-[9px] uppercase tracking-wider text-text-tertiary flex-shrink-0">ended</span>
              )}
              {bgBashCount > 0 && (
                <span
                  className="flex items-center gap-0.5 text-[10px] text-amber-400 font-medium flex-shrink-0"
                  title={`${bgBashCount} background process${bgBashCount === 1 ? '' : 'es'} alive (from \`ps -eo pid,ppid\` on the claude PID)`}
                >
                  <Terminal size={10} />
                  <span>{bgBashCount}</span>
                </span>
              )}
              {cronCount > 0 && (
                <span
                  className="flex items-center gap-0.5 text-[10px] text-blue-400 font-medium flex-shrink-0"
                  title={`${cronCount} scheduled prompt${cronCount === 1 ? '' : 's'}`}
                >
                  <Clock size={10} />
                  <span>{cronCount}</span>
                </span>
              )}
              {session.hasUnread && (
                <Circle size={5} className="fill-current text-blue-500 flex-shrink-0" />
              )}
              <StatusDot status={session.status} />
            </div>
          </div>
        )}
        {subtitle && (
          <div className="text-[10px] text-text-tertiary truncate mt-0.5">
            {subtitle}
          </div>
        )}
      </button>
        </div>
      </div>
    </ContextMenu>
  )
})

// --------------------------------------------------------------------------
// Al pinned entry
// --------------------------------------------------------------------------

const AlListItem = memo(function AlListItem({ session, isActive, onSelect }: {
  session: SessionInfo
  isActive: boolean
  onSelect: (id: string) => void
}) {
  // Extract last text preview directly from store (stable selector — no new array)
  const lastText = useAgentStore((s) => {
    const msgs = s.messagesBySession[session.id]
    if (!msgs) return null
    for (let i = msgs.length - 1; i >= 0; i--) {
      const block = msgs[i]!.block
      if (block.type === 'text') return block.content.slice(0, 80)
      if (block.type === 'user_prompt') return block.content.slice(0, 80)
    }
    return null
  })

  return (
    <button
      onClick={() => onSelect(session.id)}
      className={clsx(
        'group w-full text-left px-3 py-2 border-b border-border transition-colors duration-fast',
        isActive ? 'bg-surface-2' : 'hover:bg-surface-1',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-primary">Al</span>
        <div className="flex items-center gap-1.5">
          <MicButton sessionId={session.id} active={isActive} />
          <StatusDot status={session.status} />
        </div>
      </div>
      {lastText && (
        <div className="text-[10px] text-text-tertiary truncate mt-0.5 max-w-[200px]">
          {lastText.slice(0, 80)}
        </div>
      )}
    </button>
  )
})

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function StatusDot({ status }: { status: 'running' | 'idle' | 'ended' }) {
  // Only running (amber) shows a dot. Idle/ended show nothing — absence means
  // "fine" (avoids the hard-to-distinguish green-vs-orange the user flagged).
  if (status !== 'running') return null
  return <Circle size={6} className="fill-current flex-shrink-0 text-warning" />
}

// Push-to-talk mic adornment. The owner (default = Al) is ALWAYS shown — solid,
// and RED when hot (recording). Everyone else is hidden by default and revealed
// when the row is focused (active) OR hovered, so you can hand the mic to what
// you're pointing at without cluttering every row (also reachable via the "Give
// mic" context-menu item). A <span>, not a <button>: it's nested inside the
// row's <button>, where a nested <button> is invalid HTML.
function MicButton({ sessionId, active }: { sessionId: string; active: boolean }) {
  const isOwner = useMicStore((s) => s.owner === sessionId)
  const hot = useMicStore((s) => s.owner === sessionId && s.hot)
  const setMic = useMicStore((s) => s.setMic)
  const alwaysShow = isOwner || active
  return (
    <span
      role="button"
      tabIndex={-1}
      onClick={(e) => { e.stopPropagation(); setMic(isOwner ? 'al' : sessionId) }}
      title={isOwner ? (hot ? 'Recording — mic owner' : 'Mic owner — click to release to Al') : 'Give the mic to this session'}
      className={clsx(
        'flex-shrink-0 cursor-pointer transition duration-fast',
        alwaysShow ? '' : 'opacity-0 group-hover:opacity-100',
        hot ? 'text-red-500' : isOwner ? 'text-text-primary' : 'text-text-tertiary hover:text-text-primary',
      )}
    >
      <Mic size={11} className={hot ? 'fill-red-500/20' : undefined} />
    </span>
  )
}


/** Render a session list with fork lineage nesting, at a given base indent. */
function SessionLineage({ sessions, baseIndent, activeSessionId, onSelect, onReorder }: {
  sessions: SessionInfo[]
  baseIndent: number
  activeSessionId: string | null
  onSelect: (id: string) => void
  onReorder: (fromId: string, toId: string) => void
}) {
  const arranged = useMemo(() => arrangeLineage(sessions), [sessions])
  return (
    <>
      {arranged.map(({ session, depth }) => (
        <SessionListItem
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          indent={baseIndent + depth}
          onSelect={onSelect}
          onReorder={onReorder}
        />
      ))}
    </>
  )
}

/** Recursively roll up status/unread/count for a group and its descendants. */
function aggregateGroup(node: GroupNode): { unread: number; running: boolean; total: number } {
  let unread = node.sessions.reduce((n, s) => n + (s.hasUnread ? 1 : 0), 0)
  let running = node.sessions.some((s) => s.status === 'running')
  let total = node.sessions.length
  for (const c of node.children) {
    const a = aggregateGroup(c)
    unread += a.unread
    running = running || a.running
    total += a.total
  }
  return { unread, running, total }
}

function GroupSection({ node, activeSessionId, collapsedGroups, onToggleCollapsed, onSelect, onReorder }: {
  node: GroupNode
  activeSessionId: string | null
  collapsedGroups: Set<string>
  onToggleCollapsed: (cwd: string) => void
  onSelect: (id: string) => void
  onReorder: (fromId: string, toId: string) => void
}) {
  const collapsed = collapsedGroups.has(node.cwd)
  const agg = useMemo(() => aggregateGroup(node), [node])
  const Chevron = collapsed ? ChevronRight : ChevronDown
  const FolderIcon = collapsed ? Folder : FolderOpen

  return (
    <Fragment>
      <button
        type="button"
        onClick={() => onToggleCollapsed(node.cwd)}
        className="w-full flex items-center gap-1 py-1 pr-2 text-xs text-text-secondary hover:bg-surface-1 transition-colors duration-fast"
        style={{ paddingLeft: `${8 + node.depth * 10}px` }}
        title={node.fullPath || undefined}
      >
        <Chevron size={10} className="flex-shrink-0 opacity-70" />
        <FolderIcon size={11} className="flex-shrink-0 opacity-70" />
        <span className="truncate flex-1 text-left">{node.label}</span>
        {collapsed && agg.running && (
          <Circle size={6} className="fill-current text-warning flex-shrink-0" />
        )}
        {collapsed && agg.unread > 0 && (
          <span className="text-[10px] text-blue-500 font-medium flex-shrink-0">{agg.unread}</span>
        )}
        {collapsed && agg.total > 0 && (
          <span className="text-[10px] text-text-tertiary flex-shrink-0">{agg.total}</span>
        )}
      </button>
      {!collapsed && (
        <SessionLineage
          sessions={node.sessions}
          baseIndent={node.depth + 1}
          activeSessionId={activeSessionId}
          onSelect={onSelect}
          onReorder={onReorder}
        />
      )}
      {!collapsed && node.children.map((child) => (
        <GroupSection
          key={child.cwd}
          node={child}
          activeSessionId={activeSessionId}
          collapsedGroups={collapsedGroups}
          onToggleCollapsed={onToggleCollapsed}
          onSelect={onSelect}
          onReorder={onReorder}
        />
      ))}
    </Fragment>
  )
}

