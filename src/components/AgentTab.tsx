import { Fragment, memo, useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { useAgentStore } from '@/store/agent'
import { AgentSessionView } from './AgentSessionView'
import { ContextMenu } from './ContextMenu'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { useSwipeActions } from '@/hooks/useSwipeActions'
import clsx from 'clsx'
import { AlertCircle, Check, ChevronDown, ChevronRight, Circle, Clock, Folder, FolderOpen, GitBranch, Plus, Terminal } from 'lucide-react'
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
  const isMobile = useIsMobile()

  // Separate Al from regular sessions — always pinned at top.
  // Keep ENDED sessions visible while they're still unread, so a terminated
  // chat fork (or any finished session) survives for audit until acknowledged.
  // Marking it read removes it (see markSessionRead → delete on ended).
  const alSession = sessions.find((s) => s.id === 'al')
  const activeSessions = sessions.filter((s) => s.id !== 'al' && (s.status !== 'ended' || s.hasUnread))

  // Auto-connect on mount
  useEffect(() => {
    connect()
    return () => {
      // Don't disconnect on unmount — keep connection alive across tab switches
    }
  }, [connect])

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

  return (
    <div className="flex flex-1 h-full min-w-0">
      {/* Session sidebar */}
      {showList && (
        <div className={`${isMobile ? 'w-full' : 'w-72'} flex-shrink-0 border-r border-border overflow-hidden flex flex-col`}>
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <span className="text-xs font-medium text-text-primary">Sessions</span>
            <div className="flex items-center gap-2">
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

          <div className="flex-1 overflow-y-auto">
            {/* Al — pinned at top */}
            {alSession && <AlListItem session={alSession} isActive={alSession.id === activeSessionId} onSelect={selectSession} />}

            {activeSessions.length === 0 && !alSession && connected && (
              <div className="flex h-32 items-center justify-center">
                <p className="text-xs text-text-tertiary">No active sessions</p>
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
        </div>
      )}

      {/* Session view */}
      {showDetail && (
        <div className="flex-1 min-w-0 flex flex-col">
          <AgentSessionView />
        </div>
      )}
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
  const renameSession = useAgentStore((s) => s.renameSession)
  const generateTitleAction = useAgentStore((s) => s.generateTitle)
  const markSessionRead = useAgentStore((s) => s.markSessionRead)
  const reloadSessionHistory = useAgentStore((s) => s.reloadSessionHistory)
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
  const swipe = useSwipeActions(swipeContainerRef, swipeContentRef, {
    onSwipeStart: () => { if (longPressTimer.current) clearTimeout(longPressTimer.current) },
    onSwipeRight: () => markSessionRead(session.id),
    leftIconRef: swipeIconRef,
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
    if (session.status !== 'ended') {
      items.push({
        label: 'End session',
        onClick: () => killSession(session.id),
        destructive: true,
      })
    }
    return items
  }, [session.status, session.id, killSession, startRename, generateTitleAction, forkSession, reloadSessionHistory])

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
          'w-full text-left py-1.5 pr-2 border-b transition-colors duration-fast',
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
        'w-full text-left px-3 py-2 border-b border-border transition-colors duration-fast',
        isActive ? 'bg-surface-2' : 'hover:bg-surface-1',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-primary">Al</span>
        <StatusDot status={session.status} />
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
  return (
    <Circle
      size={6}
      className={clsx(
        'fill-current flex-shrink-0',
        status === 'running' && 'text-warning',
        status === 'idle' && 'text-success',
        status === 'ended' && 'text-text-tertiary',
      )}
    />
  )
}

function dirBasename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

// --------------------------------------------------------------------------
// Group tree — derived from session.cwd at render time.
// Sessions sharing a cwd form a group; cwds that are subdirectories of
// another sessioned cwd nest underneath it. Within a group, sessions are
// ordered by the flat sessionOrder (synced via hub); groups themselves are
// ordered by the position of their first member in the same flat order.
// --------------------------------------------------------------------------

interface GroupNode {
  cwd: string                  // '' = "no directory" bucket
  label: string                // path segment relative to parent
  fullPath: string             // for tooltip
  sessions: SessionInfo[]
  children: GroupNode[]
  depth: number
}

function buildGroupTree(sessions: SessionInfo[], order: string[]): GroupNode[] {
  const orderIdx = new Map(order.map((id, i) => [id, i]))
  const sessionKey = (s: SessionInfo) => orderIdx.get(s.id) ?? Number.MAX_SAFE_INTEGER
  const sortSessions = (a: SessionInfo, b: SessionInfo) => {
    const ai = sessionKey(a)
    const bi = sessionKey(b)
    if (ai !== bi) return ai - bi
    return b.createdAt - a.createdAt
  }

  // Bucket by cwd
  const byCwd = new Map<string, SessionInfo[]>()
  for (const s of sessions) {
    const cwd = s.cwd ?? ''
    const arr = byCwd.get(cwd) ?? []
    arr.push(s)
    byCwd.set(cwd, arr)
  }
  for (const arr of byCwd.values()) arr.sort(sortSessions)

  // Sort cwds shortest-first so each node's parent already exists when we link
  const cwds = [...byCwd.keys()].sort((a, b) => a.length - b.length)
  const nodeByCwd = new Map<string, GroupNode>()
  for (const cwd of cwds) {
    nodeByCwd.set(cwd, {
      cwd,
      label: cwd ? dirBasename(cwd) : '(no directory)',
      fullPath: cwd,
      sessions: byCwd.get(cwd)!,
      children: [],
      depth: 0,
    })
  }

  const roots: GroupNode[] = []
  for (const cwd of cwds) {
    const node = nodeByCwd.get(cwd)!
    // Find longest *sessioned* cwd that is a strict ancestor
    let parentCwd: string | null = null
    if (cwd) {
      for (const other of cwds) {
        if (!other || other === cwd) continue
        if (cwd.startsWith(other + '/') && (parentCwd === null || other.length > parentCwd.length)) {
          parentCwd = other
        }
      }
    }
    if (parentCwd !== null) {
      const parent = nodeByCwd.get(parentCwd)!
      parent.children.push(node)
      node.depth = parent.depth + 1
      node.label = cwd.slice(parentCwd.length + 1)
    } else {
      roots.push(node)
    }
  }

  // Group sort key: first-member's order index, recursing into children if empty
  const groupKey = (n: GroupNode): number => {
    if (n.sessions.length > 0) return sessionKey(n.sessions[0]!)
    if (n.children.length > 0) return groupKey(n.children[0]!)
    return Number.MAX_SAFE_INTEGER
  }
  const sortGroupsRec = (arr: GroupNode[]) => {
    arr.sort((a, b) => groupKey(a) - groupKey(b))
    for (const n of arr) sortGroupsRec(n.children)
  }
  sortGroupsRec(roots)

  return roots
}

/** If the tree has a single root (one cwd shared by everything), drop its
 *  redundant header — promote its sessions to the top level (alongside Al)
 *  and its child groups become the new roots. */
function peelUniversalRoot(roots: GroupNode[]): { rootSessions: SessionInfo[]; roots: GroupNode[] } {
  if (roots.length !== 1) return { rootSessions: [], roots }
  const only = roots[0]!
  const promoted = only.children.map((c) => shiftDepth(c, -1))
  return { rootSessions: only.sessions, roots: promoted }
}

function shiftDepth(node: GroupNode, delta: number): GroupNode {
  return {
    ...node,
    depth: node.depth + delta,
    children: node.children.map((c) => shiftDepth(c, delta)),
  }
}

/** Arrange a flat list of sessions (all sharing one cwd group) into a fork
 *  lineage: each fork is emitted right after its parent, one indent deeper.
 *  Preserves the incoming order for roots; a fork whose parent isn't in this
 *  list is treated as a root. */
function arrangeLineage(sessions: SessionInfo[]): Array<{ session: SessionInfo; depth: number }> {
  const inSet = new Set(sessions.map((s) => s.claudeSessionId).filter(Boolean) as string[])
  const childrenOf = new Map<string, SessionInfo[]>()
  for (const s of sessions) {
    const p = s.parentClaudeSessionId
    if (p && inSet.has(p)) {
      const arr = childrenOf.get(p) ?? []
      arr.push(s)
      childrenOf.set(p, arr)
    }
  }
  const out: Array<{ session: SessionInfo; depth: number }> = []
  const emit = (s: SessionInfo, depth: number) => {
    out.push({ session: s, depth })
    if (s.claudeSessionId) {
      for (const child of childrenOf.get(s.claudeSessionId) ?? []) emit(child, depth + 1)
    }
  }
  for (const s of sessions) {
    const isRoot = !s.parentClaudeSessionId || !inSet.has(s.parentClaudeSessionId)
    if (isRoot) emit(s, 0)
  }
  return out
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

