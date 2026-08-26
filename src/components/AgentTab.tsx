import { Fragment, memo, useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { useAgentStore } from '@/store/agent'
import { AgentSessionView } from './AgentSessionView'
import { ContextMenu } from './ContextMenu'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { useSwipeActions } from '@/hooks/useSwipeActions'
import clsx from 'clsx'
import { AlertCircle, ArrowLeft, Check, ChevronDown, ChevronRight, Circle, Clock, Folder, FolderOpen, GitBranch, ListFilter, ListTodo, Loader2, Mic, Moon, Plus, Terminal, X } from 'lucide-react'
import { useMicStore } from '@/store/mic'
import { AgentQuickSwitcher } from './agent/AgentQuickSwitcher'
import { buildGroupTree, peelUniversalRoot, arrangeLineage, type GroupNode } from './agent/session-tree'
import { useCronStore } from '@/store/cron'
import { todoLabel, todoProgress } from './agent/TodoList'
import { displayModel } from '@/utils/model-label'
import type { SessionInfo } from '@/store/agent'
import type { ContextMenuItem } from './ContextMenu'

// ============================================================================
// AgentTab — top-level component for the Agents pane. Shows a session
// sidebar (desktop) and the active session view.
// ============================================================================

/** Models offerable beyond whatever's in the live chain. The two backends need
 *  different id formats for the same model — a bare id 400s on Bedrock and a
 *  `us.anthropic.`-prefixed one 400s first-party — so they're separate lists,
 *  not one list plus a prefix. */
const FIRST_PARTY_MODELS = [
  'claude-opus-5',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
] as const

const BEDROCK_MODELS = [
  'us.anthropic.claude-opus-5',
  'us.anthropic.claude-fable-5',
  'us.anthropic.claude-opus-4-8',
  'us.anthropic.claude-opus-4-7',
  'us.anthropic.claude-sonnet-5',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
] as const

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
  const filterAlerted = useAgentStore((s) => s.filterAlerted)
  const toggleFilterAlerted = useAgentStore((s) => s.toggleFilterAlerted)
  const showAgentSwitcher = useAgentStore((s) => s.showAgentSwitcher)
  const pendingHandoff = useAgentStore((s) => s.pendingHandoff)
  const handoffReturnTo = useAgentStore((s) => s.handoffReturnTo)
  const acceptHandoff = useAgentStore((s) => s.acceptHandoff)
  const dismissHandoff = useAgentStore((s) => s.dismissHandoff)
  const returnFromHandoff = useAgentStore((s) => s.returnFromHandoff)
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

  // Overlays shared by both views: the role info dialog, the tasks panel, the
  // hand-off offer banner, and the Back-to-Al return control.
  const overlays = (
    <>
      {showAgentSwitcher && <AgentQuickSwitcher />}
      {pendingHandoff && (
        <div className="fixed bottom-4 left-1/2 z-50 flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-lg border border-violet-500/40 bg-surface-2 px-3 py-2 shadow-xl">
          <span className="text-xs text-text-secondary">Al suggests you talk to <span className="font-medium text-text-primary">{sessions.find((s2) => s2.agentKey === pendingHandoff.targetAgentKey)?.name ?? pendingHandoff.targetAgentKey}</span></span>
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

  return (
    <div className="flex flex-1 h-full min-w-0">
      {/* Session sidebar */}
      {showList && (
        <div className={`${isMobile ? 'w-full' : 'w-72'} flex-shrink-0 border-r border-border overflow-hidden flex flex-col`}>
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <span className="text-xs font-medium text-text-primary">Sessions</span>
            <div className="flex items-center gap-2">
              {filterToggle}
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

          {/* Backend switch — Max subscription vs Bedrock. Distinct from the
              model picker below: this rewrites the hub's auth env AND swaps the
              model chain to that backend's id format, then forces every live
              session to respawn. The lever for "we hit session limits". */}
          <AgentBackendSwitch />

          {/* Model picker — switch the model all agents spawn with. The manual
              recovery lever when a model is pulled; auto-fallback handles the
              rest. Grouped: direct Claude first-party (bare ids), then Bedrock
              (us.anthropic.* prefixed). */}
          <div className="flex items-center gap-1.5 border-t border-border px-3 py-1.5">
            <span className="text-[10px] text-text-tertiary flex-shrink-0">Model</span>
            <select
              value={agentModel}
              onChange={(e) => setAgentModel(e.target.value)}
              disabled={agentModelLockedByEnv || !connected || agentModelChain.length === 0}
              title={agentModelLockedByEnv
                ? 'Locked by the CLAUDE_MODEL env var — unset it to change the model here'
                : `Model all hub agents spawn with. Changing it restarts live sessions onto it.\n${agentModel}`}
              className="flex-1 min-w-0 bg-transparent text-[11px] text-text-secondary outline-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 truncate"
            >
              {/* Ensure the active model is selectable even if not in the chain. */}
              {agentModel && !agentModelChain.includes(agentModel) && (
                <option value={agentModel}>{displayModel(agentModel)}</option>
              )}
              {agentModelChain.map((m, i) => (
                <option key={m} value={m}>{displayModel(m)}{i === 0 ? '' : ` (fallback ${i})`}</option>
              ))}
              <optgroup label="──────────"></optgroup>
              <optgroup label="Direct (first-party)">
                {FIRST_PARTY_MODELS.filter((m) => !agentModelChain.includes(m)).map((m) => (
                  <option key={m} value={m}>{displayModel(m)}</option>
                ))}
              </optgroup>
              <optgroup label="Bedrock">
                {BEDROCK_MODELS.filter((m) => !agentModelChain.includes(m)).map((m) => (
                  <option key={m} value={m}>{displayModel(m)}</option>
                ))}
              </optgroup>
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
  // Mergeable up if it's a fork (shares a parent's conversation).
  const canMergeUp = !!session.parentClaudeSessionId
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
  // The CLI's own task list, read hub-side off ~/.claude/tasks/<csid>/. Only
  // shown while there's outstanding work — a finished list on every row is
  // clutter; the point of the chip is spotting who's mid-plan without opening
  // them.
  const todoProgress_ = useMemo(() => {
    const todos = session.todos
    if (!todos?.length) return null
    const { done, total, current } = todoProgress(todos)
    if (done === total) return null
    return { done, total, title: current ? `${done}/${total} tasks · ${todoLabel(current)}` : `${done}/${total} tasks` }
  }, [session.todos])
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
    // Mark read/unread (mobile-reachable equivalents of e / Shift+E / swipes).
    items.push({ label: 'Mark read', onClick: () => markSessionRead(session.id) })
    items.push({ label: 'Mark unread', onClick: () => markSessionUnread(session.id) })
    // Push-to-talk mic: hand it to this session (or release the owner's to Al).
    items.push(isMicOwner
      ? { label: 'Release mic to Al', onClick: () => useMicStore.getState().setMic('al') }
      : { label: 'Give mic to this agent', onClick: () => useMicStore.getState().setMic(session.id) })
    // A fork folds into its parent so the parent absorbs its knowledge —
    // instead of just killing it.
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
  }, [session.status, session.id, session.agentKey, session.parentClaudeSessionId, canMergeUp, isMicOwner, killSession, mergeSession, markSessionRead, markSessionUnread, startRename, generateTitleAction, forkSession, reloadSessionHistory])

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
                  // Neutral grey, NOT blue — blue is the unread colour and a
                  // blue count here reads as unread messages.
                  className="flex items-center gap-0.5 text-[10px] text-text-tertiary font-medium flex-shrink-0"
                  title={`${cronCount} scheduled prompt${cronCount === 1 ? '' : 's'}`}
                >
                  <Clock size={10} />
                  <span>{cronCount}</span>
                </span>
              )}
              {todoProgress_ && (
                <span
                  className="flex items-center gap-0.5 text-[10px] text-violet-400 font-medium flex-shrink-0"
                  title={todoProgress_.title}
                >
                  <ListTodo size={10} />
                  <span>{todoProgress_.done}/{todoProgress_.total}</span>
                </span>
              )}
              {session.hasUnread && (
                <Circle size={5} className="fill-current text-blue-500 flex-shrink-0" />
              )}
              {session.hibernated && session.status !== 'ended' && (
                <span title="Hibernated — subprocess reaped to save memory; wakes on next message" className="flex-shrink-0 flex items-center">
                  <Moon size={9} className="text-text-quaternary" />
                </span>
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
// Backend switch — Max subscription ↔ Bedrock. See setAgentBackend for what
// actually happens (settings.json env rewrite + model chain swap + forced
// fleet respawn). A segmented two-button control, not a <select>, since
// there are exactly two options and the active one should read at a glance.
// --------------------------------------------------------------------------

function AgentBackendSwitch() {
  const agentBackend = useAgentStore((s) => s.agentBackend)
  const setAgentBackend = useAgentStore((s) => s.setAgentBackend)
  const connected = useAgentStore((s) => s.connected)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const switchTo = useCallback(async (backend: 'first_party' | 'bedrock') => {
    if (backend === agentBackend || switching) return
    setSwitching(true)
    setError(null)
    try {
      await setAgentBackend(backend)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSwitching(false)
    }
  }, [agentBackend, switching, setAgentBackend])

  const btn = (id: 'first_party' | 'bedrock', label: string, title: string) => (
    <button
      onClick={() => switchTo(id)}
      disabled={!connected || switching}
      title={title}
      className={clsx(
        'flex-1 px-1.5 py-0.5 text-[10px] font-medium transition-colors duration-fast disabled:cursor-not-allowed',
        agentBackend === id
          ? 'bg-accent/20 text-accent'
          : 'text-text-tertiary hover:text-text-secondary disabled:opacity-60',
      )}
    >
      {label}
    </button>
  )

  return (
    <div className="border-t border-border px-3 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-text-tertiary flex-shrink-0">Backend</span>
        <div className="flex-1 flex items-center border border-border rounded-sm overflow-hidden">
          {btn('first_party', 'Max sub', 'Claude Max subscription — fixed cost, hits 5h/weekly session limits under heavy fleet load')}
          <div className="w-px bg-border self-stretch" />
          {btn('bedrock', 'Bedrock', 'Amazon Bedrock — pay-per-token, no session limits')}
        </div>
        {switching && <Loader2 size={11} className="animate-spin text-text-tertiary flex-shrink-0" />}
      </div>
      {error && (
        <div className="mt-1 text-[10px] text-destructive">{error}</div>
      )}
    </div>
  )
}

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

