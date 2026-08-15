// Spaces — the project-first pane. The left rail is a drill-down: the top
// level lists spaces (areas + projects); selecting one drills INTO it — the
// rail becomes that space's contents (its files + its agents, one glance),
// with a back header. Centre: Board | Docs, where Docs IS the vault editor
// scoped to the space (this is the Notes tab being absorbed — file list in
// the rail, editor in the centre). Right: the active agent session, 50/50.
//
// The board is the SAME file the hub's BoardWatcher dispatches from: moving
// a card into In Progress with an assignee IS delegation; the ^blockid stamps
// and Done/Blocked transitions all round-trip through the vault file.

import { memo, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Bot, FileText, FolderKanban, GitBranch, Kanban, Plus, RefreshCw, Tag, UserPlus, X } from 'lucide-react'
import clsx from 'clsx'
import { useSpacesStore, type SpaceSummary } from '@/store/spaces'
import { useAgentStore } from '@/store/agent'
import { useNotesStore } from '@/store/notes'
import { useUiStore } from '@/store/ui'
import { showPrompt } from '@/dialog'
import { AgentSessionView } from './AgentSessionView'
import { NotesEditor } from './NotesEditor'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import type { BoardCard, CardRef } from '@/kanban/board'

export const SpacesTab = memo(function SpacesTab() {
  const spaces = useSpacesStore((s) => s.spaces)
  const activeSlug = useSpacesStore((s) => s.activeSlug)
  const refreshSpaces = useSpacesStore((s) => s.refreshSpaces)

  useEffect(() => {
    void refreshSpaces().then(() => {
      // Re-hydrate the board for a persisted selection once spaces are known.
      const { activeSlug, board, loadBoard } = useSpacesStore.getState()
      if (activeSlug && !board) void loadBoard()
    })
    // The rail file list + Docs editor need the vault; connect it here so
    // Spaces works without ever visiting the Notes pane.
    const notes = useNotesStore.getState()
    if (!notes.adapter && !notes.loading) void notes.reconnectVault()
  }, [refreshSpaces])

  const active = spaces.find((s) => s.slug === activeSlug) ?? null

  return (
    <div className="flex flex-1 h-full min-w-0">
      {/* Left rail — space list, or the selected space's contents */}
      <div className="w-60 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
        {active ? <SpaceRail space={active} /> : <SpaceListRail />}
      </div>

      {/* Centre — board / docs (the editor) */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {active ? <SpaceCentre space={active} /> : (
          <div className="flex-1 grid place-items-center text-sm text-text-tertiary">Select a space</div>
        )}
      </div>

      {/* Right — the active agent session, 50/50 with the centre */}
      {active && <SpaceAgentPanel space={active} />}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Rail, top level: all spaces
// ---------------------------------------------------------------------------

function SpaceListRail() {
  const spaces = useSpacesStore((s) => s.spaces)
  const loading = useSpacesStore((s) => s.loading)
  const refreshSpaces = useSpacesStore((s) => s.refreshSpaces)
  const selectSpace = useSpacesStore((s) => s.selectSpace)

  const areas = useMemo(() => spaces.filter((s) => s.kind === 'area'), [spaces])
  const projects = useMemo(() => spaces.filter((s) => s.kind === 'project'), [spaces])

  // Agent count + alert state per space (forks included) → rail badge.
  // Attention (@amar) beats unread, mirroring the org-chart dot priority.
  const roles = useAgentStore((s) => s.agentRoles)
  const sessions = useAgentStore((s) => s.sessions)
  const agentBadges = useMemo(() => {
    const m = new Map<string, { count: number; unread: boolean; attention: boolean }>()
    const bump = (slug: string, unread: boolean, attention: boolean) => {
      const cur = m.get(slug) ?? { count: 0, unread: false, attention: false }
      m.set(slug, { count: cur.count + 1, unread: cur.unread || unread, attention: cur.attention || attention })
    }
    for (const r of roles) {
      if (r.folder) continue
      const live = sessions.find((s) => s.agentKey === r.key && s.status !== 'ended')
      const unread = !!live?.hasUnread
      const attention = !!live?.needsAttention
      if (r.project) bump(r.project, unread, attention)
      for (const a of r.areas ?? []) bump(a, unread, attention)
    }
    return m
  }, [roles, sessions])

  return (
    <>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <span className="text-xs font-medium text-text-primary">Spaces</span>
        <button onClick={() => void refreshSpaces()} className="text-text-tertiary hover:text-text-primary" title="Refresh">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        <RailSection label="Areas">
          {areas.map((s) => (
            <SpaceListItem key={s.slug} space={s} badge={agentBadges.get(s.slug)} onClick={() => selectSpace(s.slug)} />
          ))}
        </RailSection>
        <RailSection label="Projects">
          {projects.map((s) => (
            <SpaceListItem key={s.slug} space={s} badge={agentBadges.get(s.slug)} onClick={() => selectSpace(s.slug)} />
          ))}
        </RailSection>
      </div>
    </>
  )
}

function RailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-text-tertiary">{label}</div>
      {children}
    </div>
  )
}

function SpaceListItem({ space, badge, onClick }: { space: SpaceSummary; badge?: { count: number; unread: boolean; attention: boolean }; onClick: () => void }) {
  const botColor = badge?.attention ? 'text-red-500' : badge?.unread ? 'text-blue-500' : 'text-text-tertiary opacity-60'
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
    >
      {space.kind === 'area' ? <Tag size={10} className="flex-shrink-0 opacity-60" /> : <FolderKanban size={10} className="flex-shrink-0 opacity-60" />}
      <span className="truncate">{space.title}</span>
      {space.status === 'dormant' && <span className="ml-auto text-[9px] text-text-tertiary">zzz</span>}
      <span className={clsx('flex items-center gap-1', space.status !== 'dormant' && 'ml-auto')}>
        {badge && badge.count > 0 && (
          <span
            className={clsx('flex items-center gap-0.5 text-[9px]', botColor)}
            title={`${badge.count} agent${badge.count > 1 ? 's' : ''}${badge.attention ? ' · needs you' : badge.unread ? ' · unread' : ''}`}
          >
            <Bot size={9} />{badge.count}
          </span>
        )}
        {space.boardPath && <Kanban size={9} className="flex-shrink-0 opacity-40" />}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Rail, drilled in: ONE space's files + agents in a single glance
// ---------------------------------------------------------------------------

export function spaceScopePrefixes(space: SpaceSummary): string[] {
  // Projects own projects/<slug>/** plus the flat projects/<slug>.md; areas
  // have no folder (their writing is blog posts) — no file scope.
  return space.kind === 'project' ? [`projects/${space.slug}/`, `projects/${space.slug}.md`] : []
}

function SpaceRail({ space }: { space: SpaceSummary }) {
  const selectSpace = useSpacesStore((s) => s.selectSpace)
  const setActiveView = useSpacesStore((s) => s.setActiveView)
  const files = useNotesStore((s) => s.files)
  const storeActivePath = useNotesStore((s) => s.activeFilePath)
  const roles = useAgentStore((s) => s.agentRoles)
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const selectSession = useAgentStore((s) => s.selectSession)
  const reviveAgent = useAgentStore((s) => s.reviveAgent)

  const prefixes = spaceScopePrefixes(space)
  const spaceFiles = useMemo(
    () => files
      .filter((f) => prefixes.some((p) => f.path.startsWith(p) || f.path === p))
      .sort((a, b) => a.path.localeCompare(b.path)),
    [files, space.slug], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Forks included — they inherit the source role's space binding and are
  // first-class here (assignable on the board, revivable, chattable).
  const spaceRoles = useMemo(
    () => roles.filter((r) => !r.folder && (
      space.kind === 'project' ? r.project === space.slug : (r.areas ?? []).includes(space.slug)
    )).sort((a, b) => Number(a.fork ?? false) - Number(b.fork ?? false)),
    [roles, space],
  )
  const sessionFor = (key: string) => sessions.find((s) => s.agentKey === key && s.status !== 'ended')

  const openDoc = async (path: string) => {
    const notes = useNotesStore.getState()
    if (!notes.adapter) await notes.reconnectVault()
    await useNotesStore.getState().openFile(path)
    setActiveView('docs')
  }

  const displayPath = (path: string) =>
    path === `projects/${space.slug}.md` ? `${space.slug}.md` : path.slice(`projects/${space.slug}/`.length)

  return (
    <>
      <button
        onClick={() => selectSpace(null)}
        className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-left hover:bg-surface-1 transition-colors"
      >
        <ArrowLeft size={11} className="text-text-tertiary flex-shrink-0" />
        <span className="text-xs font-medium text-text-primary truncate">{space.title}</span>
        {space.kind === 'area' && <Tag size={9} className="text-text-tertiary flex-shrink-0" />}
      </button>
      <div className="flex-1 overflow-y-auto py-1">
        <RailSection label="Agents">
          {spaceRoles.length === 0 && (
            <div className="px-3 py-1 text-[10px] text-text-tertiary">
              None — stamp {space.kind === 'project' ? `project: ${space.slug}` : `areas: [${space.slug}]`} in a role file
            </div>
          )}
          {spaceRoles.map((r) => {
            const live = sessionFor(r.key)
            const isActive = live?.id === activeSessionId
            const alert = live?.needsAttention ? 'attention' : live?.hasUnread ? 'unread' : null
            const agent = useAgentStore.getState()
            const menuItems: ContextMenuItem[] = [
              { label: 'Show info', onClick: () => agent.openRoleInfo(r.key) },
              ...(live ? [
                { label: 'Mark read', onClick: () => agent.markSessionRead(live.id) },
                { label: 'Mark unread', onClick: () => agent.markSessionUnread(live.id) },
                { label: 'Fork', onClick: () => agent.forkSession(live.id) },
                ...(r.fork || r.manager ? [{ label: 'Merge into parent', onClick: () => agent.mergeSession(live.id) }] : []),
                { label: 'End session', onClick: () => agent.killSession(live.id), destructive: true },
              ] : [
                { label: 'Revive', onClick: () => reviveAgent(r.key) },
              ]),
            ]
            return (
              <ContextMenu key={r.key} items={menuItems}>
                <button
                  onClick={() => { if (live) selectSession(live.id); else reviveAgent(r.key) }}
                  className={clsx(
                    'flex w-full items-center gap-2 px-3 py-1 text-left text-xs transition-colors',
                    isActive ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-1 hover:text-text-primary',
                  )}
                  title={`${r.fork ? 'fork · ' : ''}${live ? r.title : `${r.title} (parked — click to revive)`} · @${r.key}`}
                >
                  {r.fork
                    ? <GitBranch size={10} className={clsx('flex-shrink-0', alert === 'attention' ? 'text-red-500' : alert === 'unread' ? 'text-blue-500' : 'opacity-60')} />
                    : <Bot size={10} className={clsx('flex-shrink-0', alert === 'attention' ? 'text-red-500' : alert === 'unread' ? 'text-blue-500' : 'opacity-60')} />}
                  <span className={clsx('truncate', !live && 'opacity-60')}>{r.title}</span>
                  {!live && <span className="ml-auto text-[9px] text-text-tertiary flex-shrink-0">⏾</span>}
                </button>
              </ContextMenu>
            )
          })}
        </RailSection>
        <RailSection label="Files">
          {space.kind === 'area' && (
            <div className="px-3 py-1 text-[10px] text-text-tertiary">
              Area writing lives in the blog (tag: {space.slug})
            </div>
          )}
          {space.kind === 'project' && spaceFiles.length === 0 && (
            <div className="px-3 py-1 text-[10px] text-text-tertiary">No files under projects/{space.slug}/</div>
          )}
          {spaceFiles.map((f) => (
            <button
              key={f.path}
              onClick={() => void openDoc(f.path)}
              className={clsx(
                'flex w-full items-center gap-2 px-3 py-1 text-left text-xs transition-colors',
                storeActivePath === f.path ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-1 hover:text-text-primary',
              )}
            >
              <FileText size={10} className="flex-shrink-0 opacity-50" />
              <span className="truncate">{displayPath(f.path)}</span>
            </button>
          ))}
        </RailSection>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Centre: board or docs (docs = the scoped vault editor)
// ---------------------------------------------------------------------------

function SpaceCentre({ space }: { space: SpaceSummary }) {
  const activeView = useSpacesStore((s) => s.activeView)
  const setActiveView = useSpacesStore((s) => s.setActiveView)
  // Only ONE live CM6 editor per file across the app: the Notes pane already
  // gates its editor on being the active pane; mirror that here.
  const isActivePane = useUiStore((s) => s.activePane === 'spaces')
  const hasBoard = !!space.boardPath
  const showBoard = activeView === 'board' && hasBoard

  return (
    <>
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-3 py-1.5">
        <span className="text-xs font-medium text-text-primary truncate">{space.title}</span>
        <div className="flex items-center gap-1 ml-auto">
          {hasBoard && (
            <ViewTab label="Board" icon={<Kanban size={10} />} active={showBoard} onClick={() => setActiveView('board')} />
          )}
          <ViewTab label="Docs" icon={<FileText size={10} />} active={!showBoard} onClick={() => setActiveView('docs')} />
        </div>
      </div>
      {showBoard
        ? <BoardView />
        : (isActivePane ? <NotesEditor scopePrefixes={spaceScopePrefixes(space)} /> : null)}
    </>
  )
}

function ViewTab({ label, icon, active, onClick }: { label: string; icon: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1 rounded-sm px-2 py-0.5 text-[10px] transition-colors',
        active ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-secondary',
      )}
    >
      {icon}{label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Board view — columns of cards, click-to-move, assign
// ---------------------------------------------------------------------------

function BoardView() {
  const board = useSpacesStore((s) => s.board)
  const boardError = useSpacesStore((s) => s.boardError)
  const moveCardTo = useSpacesStore((s) => s.moveCardTo)
  const addCardTo = useSpacesStore((s) => s.addCardTo)
  const assignCard = useSpacesStore((s) => s.assignCard)
  const roles = useAgentStore((s) => s.agentRoles)
  // Filter the board to one assignee's cards — how a fork (or you) views ITS
  // OWN queue rather than the whole master board. null = everyone.
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null)

  if (boardError) return <div className="flex-1 grid place-items-center text-xs text-destructive">{boardError}</div>
  if (!board) return <div className="flex-1 grid place-items-center text-xs text-text-tertiary">Loading board…</div>

  const columnTitles = board.columns.map((c) => c.title)
  // Assignable = any non-folder role, forks included.
  const assignable = roles.filter((r) => !r.folder)
  const assignees = [...new Set(board.columns.flatMap((c) => c.cards.map((card) => card.agentKey)).filter(Boolean))] as string[]

  const promptAssign = async (ref: CardRef, card: BoardCard) => {
    const keys = assignable.map((r) => r.key).join(', ')
    const key = await showPrompt(`Assign to which agent? (${keys})`, {
      title: 'Assign card', defaultValue: card.agentKey ?? '', placeholder: 'agentkey — empty to unassign',
    })
    if (key === null) return
    await assignCard(ref, key.trim() || null)
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {assignees.length > 0 && (
        <div className="flex flex-shrink-0 items-center gap-1 border-b border-border px-2 py-1 overflow-x-auto">
          <span className="text-[9px] uppercase tracking-wide text-text-tertiary flex-shrink-0">Assignee</span>
          <button
            onClick={() => setAssigneeFilter(null)}
            className={clsx('flex-shrink-0 rounded-sm px-1.5 py-px text-[10px]', assigneeFilter === null ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-secondary')}
          >
            all
          </button>
          {assignees.map((key) => (
            <button
              key={key}
              onClick={() => setAssigneeFilter(assigneeFilter === key ? null : key)}
              className={clsx('flex-shrink-0 rounded-sm px-1.5 py-px text-[10px]', assigneeFilter === key ? 'bg-violet-500/20 text-violet-300' : 'text-text-tertiary hover:text-text-secondary')}
            >
              @{key}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-1 min-h-0 gap-2 overflow-x-auto p-2">
      {board.columns.map((col) => (
        <div key={col.title} className="flex w-56 flex-shrink-0 flex-col rounded border border-border bg-surface-1/40">
          <div className="flex items-center justify-between px-2 py-1 border-b border-border">
            <span className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">{col.title}</span>
            <button
              onClick={async () => {
                const text = await showPrompt('Card text', { title: `Add to ${col.title}` })
                if (text?.trim()) await addCardTo(col.title, text.trim())
              }}
              className="text-text-tertiary hover:text-text-primary"
              title={`Add card to ${col.title}`}
            >
              <Plus size={10} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5">
            {/* Filter hides non-matching cards but `index` stays the column-
                relative position — CardRef must address the REAL board. */}
            {col.cards.map((card, index) => (
              (assigneeFilter === null || card.agentKey === assigneeFilter) ? (
                <CardTile
                  key={card.blockId ?? `${col.title}:${index}`}
                  card={card}
                  columnTitles={columnTitles}
                  currentColumn={col.title}
                  onMove={(to) => void moveCardTo({ column: col.title, index }, to)}
                  onAssign={() => void promptAssign({ column: col.title, index }, card)}
                />
              ) : null
            ))}
          </div>
        </div>
      ))}
      </div>
    </div>
  )
}

function CardTile({ card, columnTitles, currentColumn, onMove, onAssign }: {
  card: BoardCard
  columnTitles: string[]
  currentColumn: string
  onMove: (to: string) => void
  onAssign: () => void
}) {
  const detail = card.lines.slice(1).map((l) => l.trim()).filter(Boolean)
  return (
    <div className={clsx('rounded-sm border border-border bg-surface-0 px-2 py-1.5', card.checked && 'opacity-50')}>
      <div className={clsx('text-xs text-text-primary', card.checked && 'line-through')}>{card.text}</div>
      {detail.length > 0 && <div className="mt-0.5 text-[10px] text-text-tertiary line-clamp-2">{detail.join(' · ')}</div>}
      <div className="mt-1 flex items-center gap-1.5">
        {card.agentKey && (
          <span className="flex items-center gap-0.5 rounded-sm bg-violet-500/15 px-1 py-px text-[9px] text-violet-400">
            <Bot size={8} />{card.agentKey}
          </span>
        )}
        {card.blockId && <span className="text-[9px] text-text-tertiary" title="Dispatched">^{card.blockId}</span>}
        <button onClick={onAssign} className="ml-auto text-text-tertiary hover:text-text-primary" title="Assign to agent">
          <UserPlus size={10} />
        </button>
        <select
          value={currentColumn}
          onChange={(e) => { if (e.target.value !== currentColumn) onMove(e.target.value) }}
          className="max-w-20 cursor-pointer border-none bg-transparent text-[9px] text-text-tertiary outline-none"
          title="Move to column"
        >
          {columnTitles.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Right — the active agent session (50/50 with the centre)
// ---------------------------------------------------------------------------

function SpaceAgentPanel({ space }: { space: SpaceSummary }) {
  const roles = useAgentStore((s) => s.agentRoles)
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const [collapsed, setCollapsed] = useState(false)

  // Show the session only when it belongs to this space (rail owns selection).
  const spaceKeys = useMemo(
    () => new Set(roles.filter((r) => !r.folder && (
      space.kind === 'project' ? r.project === space.slug : (r.areas ?? []).includes(space.slug)
    )).map((r) => r.key)),
    [roles, space],
  )
  const activeSession = sessions.find((s) => s.id === activeSessionId && s.status !== 'ended')
  const activeBelongs = !!activeSession?.agentKey && spaceKeys.has(activeSession.agentKey)

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="w-8 flex-shrink-0 border-l border-border grid place-items-center text-text-tertiary hover:text-text-primary"
        title="Show agent chat"
      >
        <Bot size={13} />
      </button>
    )
  }

  return (
    <div className="flex flex-1 min-w-0 flex-col border-l border-border overflow-hidden">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-2 py-1.5">
        <span className="flex items-center gap-1.5 text-xs text-text-secondary truncate">
          <Bot size={11} className="text-text-tertiary flex-shrink-0" />
          {activeBelongs ? (activeSession?.name ?? 'Agent') : 'Agent chat'}
        </span>
        <button onClick={() => setCollapsed(true)} className="flex-shrink-0 text-text-tertiary hover:text-text-primary" title="Collapse">
          <X size={11} />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        {activeBelongs ? (
          <AgentSessionView />
        ) : (
          <div className="flex-1 grid place-items-center px-4 text-center text-[11px] text-text-tertiary">
            {spaceKeys.size ? 'Pick an agent in the left rail' : 'No agents bound to this space yet'}
          </div>
        )}
      </div>
    </div>
  )
}
