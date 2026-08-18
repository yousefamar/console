// Spaces — the project-first pane. TWO persistent rails: rail 1 lists all
// spaces (areas + projects, alert items inline); rail 2 shows the selected
// space's contents (agents + files) — both always visible, no drill/back.
// Centre: Board | Docs, where Docs IS the vault editor scoped to the space
// (this is the Notes tab being absorbed — file list in rail 2, editor in
// the centre). Right: the active agent session, 50/50 with the centre.
//
// The board is the SAME file the hub's BoardWatcher dispatches from: moving
// a card into In Progress with an assignee IS delegation; the ^blockid stamps
// and Done/Blocked transitions all round-trip through the vault file.

import { memo, useEffect, useMemo, useState } from 'react'
import { Bot, FileText, FolderKanban, GitBranch, Kanban, Plus, RefreshCw, Tag, UserPlus, X } from 'lucide-react'
import clsx from 'clsx'
import { useSpacesStore, type SpaceSummary } from '@/store/spaces'
import { useAgentStore } from '@/store/agent'
import { useNotesStore } from '@/store/notes'
import { useUiStore } from '@/store/ui'
import { showPrompt, showConfirm } from '@/dialog'
import { AgentSessionView } from './AgentSessionView'
import { NotesEditor } from './NotesEditor'
import { NotesFileBrowser } from './NotesFileBrowser'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { SpacesQuickSwitcher } from './SpacesQuickSwitcher'
import { NewNoteModal } from './NewNoteModal'
import type { BoardCard, CardRef } from '@/kanban/board'

export const SpacesTab = memo(function SpacesTab() {
  const spaces = useSpacesStore((s) => s.spaces)
  const activeSlug = useSpacesStore((s) => s.activeSlug)
  const refreshSpaces = useSpacesStore((s) => s.refreshSpaces)
  const switcherOpen = useSpacesStore((s) => s.switcherOpen)
  const newFileFormOpen = useNotesStore((s) => s.newFileFormOpen)
  const isActivePane = useUiStore((s) => s.activePane === 'spaces')

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

  const active = activeSlug === VAULT_SLUG ? VAULT_SPACE
    : activeSlug === UNASSIGNED_SLUG ? UNASSIGNED_SPACE
    : spaces.find((s) => s.slug === activeSlug) ?? null

  return (
    <div className="flex flex-1 h-full min-w-0">
      {/* Rail 1 — all spaces, always visible */}
      <div className="w-44 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
        <SpaceListRail />
      </div>

      {/* Rail 2 — the selected space's contents (agents + files), always visible */}
      <div className="w-52 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
        {active ? <SpaceRail space={active} /> : (
          <div className="flex-1 grid place-items-center px-3 text-center text-[11px] text-text-tertiary">Select a space</div>
        )}
      </div>

      {/* Centre — board / docs (the editor) */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {active ? <SpaceCentre space={active} /> : <div className="flex-1" />}
      </div>

      {/* Right — the active agent session, 50/50 with the centre */}
      {active && <SpaceAgentPanel space={active} />}

      {switcherOpen && <SpacesQuickSwitcher />}
      {/* NewNoteModal is store-gated and also mounted by NotesTab — gate on
          the active pane so two panes never render it twice. */}
      {newFileFormOpen && isActivePane && <NewNoteModal />}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Rail, top level: all spaces
// ---------------------------------------------------------------------------

/** Something in a space demanding attention: an unread/alerted agent session
 *  or an unsaved (dirty) open note. Rendered inline under the space's row so
 *  it's reachable in one click from the top level. */
interface SpaceAlert {
  kind: 'session' | 'file'
  id: string           // sessionId | file path
  label: string
  level: 'attention' | 'working' | 'unread' | 'dirty'
  fork?: boolean
  /** Fork-lineage depth within the space (manager edges) — indents the row. */
  depth?: number
}

function SpaceListRail() {
  const spaces = useSpacesStore((s) => s.spaces)
  const activeSlug = useSpacesStore((s) => s.activeSlug)
  const loading = useSpacesStore((s) => s.loading)
  const refreshSpaces = useSpacesStore((s) => s.refreshSpaces)
  const selectSpace = useSpacesStore((s) => s.selectSpace)
  const setActiveView = useSpacesStore((s) => s.setActiveView)

  // Agent count per space + the concrete alert items (unread/alerted sessions,
  // dirty notes) that make a space "dirty". Dirty spaces sort first.
  const roles = useAgentStore((s) => s.agentRoles)
  const sessions = useAgentStore((s) => s.sessions)
  const openFiles = useNotesStore((s) => s.openFiles)
  const { agentBadges, alertsBySlug, unassignedCount } = useMemo(() => {
    const badges = new Map<string, { count: number; unread: boolean; attention: boolean }>()
    const alerts = new Map<string, SpaceAlert[]>()
    const push = (slug: string, a: SpaceAlert) => {
      const arr = alerts.get(slug) ?? []
      arr.push(a)
      alerts.set(slug, arr)
    }
    const bump = (slug: string, unread: boolean, attention: boolean) => {
      const cur = badges.get(slug) ?? { count: 0, unread: false, attention: false }
      badges.set(slug, { count: cur.count + 1, unread: cur.unread || unread, attention: cur.attention || attention })
    }
    // Fork-lineage depth per role (manager edges among non-folder roles) so
    // alert rows can indent like the drilled rail.
    const roleByKey = new Map(roles.filter((r) => !r.folder).map((r) => [r.key, r]))
    const depthOf = (key: string): number => {
      let d = 0
      let cur = roleByKey.get(key)
      while (cur?.manager && roleByKey.has(cur.manager) && d < 6) { d++; cur = roleByKey.get(cur.manager) }
      return d
    }
    for (const r of roles) {
      if (r.folder) continue
      const live = sessions.find((s) => s.agentKey === r.key && s.status !== 'ended')
      const unread = !!live?.hasUnread
      const attention = !!live?.needsAttention
      const working = live?.status === 'running'
      const slugs = [...(r.project ? [r.project] : []), ...(r.areas ?? [])]
      for (const slug of slugs) {
        bump(slug, unread, attention)
        if (live && (unread || attention || working)) {
          push(slug, {
            kind: 'session', id: live.id,
            label: (live.name || r.title).replace(/\s\(fork\)$/, ''),
            level: attention ? 'attention' : working ? 'working' : 'unread',
            fork: r.fork,
            depth: depthOf(r.key),
          })
        }
      }
    }
    for (const [path, f] of Object.entries(openFiles)) {
      if (f.content === f.savedContent) continue
      const m = path.match(/^projects\/([^/.]+)/)
      if (!m) continue
      push(m[1]!, { kind: 'file', id: path, label: path.split('/').pop()!, level: 'dirty' })
    }
    // Unassigned pseudo-space: live sessions with no space to belong to —
    // role-less (chat forks, one-off creates) or a role with no binding.
    let unassigned = 0
    for (const s of sessions) {
      if (s.status === 'ended' || s.isAl) continue
      const r = s.agentKey ? roleByKey.get(s.agentKey) : undefined
      const bound = !!(r && (r.project || (r.areas ?? []).length))
      if (bound) continue
      unassigned++
      bump(UNASSIGNED_SLUG, !!s.hasUnread, !!s.needsAttention)
      if (s.hasUnread || s.needsAttention || s.status === 'running') {
        push(UNASSIGNED_SLUG, {
          kind: 'session', id: s.id,
          label: (s.name || s.id).replace(/\s\(fork\)$/, ''),
          level: s.needsAttention ? 'attention' : s.status === 'running' ? 'working' : 'unread',
          fork: /\s\(fork\)$/.test(s.name || ''),
        })
      }
    }
    // Dirty files outside projects/ surface under Vault.
    for (const [path, f] of Object.entries(openFiles)) {
      if (f.content === f.savedContent || path.startsWith('projects/')) continue
      push(VAULT_SLUG, { kind: 'file', id: path, label: path.split('/').pop()!, level: 'dirty' })
    }
    // Attention first, then working, unread, dirty files — within each, stable.
    const rank = { attention: 0, working: 1, unread: 2, dirty: 3 }
    for (const arr of alerts.values()) arr.sort((a, b) => rank[a.level] - rank[b.level])
    return { agentBadges: badges, alertsBySlug: alerts, unassignedCount: unassigned }
  }, [roles, sessions, openFiles])

  const byDirtyThenTitle = (a: SpaceSummary, b: SpaceSummary) => {
    const ad = alertsBySlug.has(a.slug) ? 0 : 1
    const bd = alertsBySlug.has(b.slug) ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.title.localeCompare(b.title)
  }
  const areas = useMemo(() => spaces.filter((s) => s.kind === 'area').sort(byDirtyThenTitle), [spaces, alertsBySlug]) // eslint-disable-line react-hooks/exhaustive-deps
  const projects = useMemo(() => spaces.filter((s) => s.kind === 'project').sort(byDirtyThenTitle), [spaces, alertsBySlug]) // eslint-disable-line react-hooks/exhaustive-deps

  const openAlert = (space: SpaceSummary, a: SpaceAlert) => {
    selectSpace(space.slug)
    if (a.kind === 'session') {
      useAgentStore.getState().selectSession(a.id)
    } else {
      void useNotesStore.getState().openFile(a.id)
      setActiveView('docs')
    }
  }

  const renderSpace = (s: SpaceSummary) => (
    <div key={s.slug}>
      <SpaceListItem space={s} badge={agentBadges.get(s.slug)} active={s.slug === activeSlug} onClick={() => selectSpace(s.slug)} />
      {(alertsBySlug.get(s.slug) ?? []).map((a) => (
        <button
          key={`${a.kind}:${a.id}`}
          onClick={() => openAlert(s, a)}
          className="flex w-full items-center gap-2 py-0.5 pr-3 text-left text-[11px] text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
          style={{ paddingLeft: `${32 + (a.depth ?? 0) * 14}px` }}
          title={a.level === 'attention' ? 'Needs you' : a.level === 'working' ? 'Working' : a.level === 'unread' ? 'Unread' : 'Unsaved changes'}
        >
          {a.kind === 'file'
            ? <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
            : a.fork
              ? <GitBranch size={9} className={clsx('flex-shrink-0', a.level === 'attention' ? 'text-red-500' : a.level === 'working' ? 'text-amber-500' : 'text-blue-500')} />
              : <Bot size={9} className={clsx('flex-shrink-0', a.level === 'attention' ? 'text-red-500' : a.level === 'working' ? 'text-amber-500' : 'text-blue-500')} />}
          <span className="truncate">{a.label}</span>
        </button>
      ))}
    </div>
  )

  return (
    <>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <span className="text-xs font-medium text-text-primary">Spaces</span>
        <button onClick={() => void refreshSpaces()} className="text-text-tertiary hover:text-text-primary" title="Refresh">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        <RailSection label="Areas">{areas.map(renderSpace)}</RailSection>
        <RailSection label="Projects">{projects.map(renderSpace)}</RailSection>
        <RailSection label="Everything else">
          {renderSpace(VAULT_SPACE)}
          {unassignedCount > 0 && renderSpace(UNASSIGNED_SPACE)}
        </RailSection>
      </div>
    </>
  )
}

function RailSection({ label, action, children }: { label: string; action?: { icon: React.ReactNode; title: string; onClick: () => void }; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-[10px] uppercase tracking-wide text-text-tertiary">{label}</span>
        {action && (
          <button onClick={action.onClick} className="text-text-tertiary hover:text-text-primary" title={action.title}>
            {action.icon}
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function SpaceListItem({ space, badge, active, onClick }: { space: SpaceSummary; badge?: { count: number; unread: boolean; attention: boolean }; active: boolean; onClick: () => void }) {
  const botColor = badge?.attention ? 'text-red-500' : badge?.unread ? 'text-blue-500' : 'text-text-tertiary opacity-60'
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 px-3 py-1 text-left text-xs transition-colors',
        active ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-1 hover:text-text-primary',
      )}
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

// Pseudo-spaces — client-side constructs (the hub's listSpaces knows nothing
// of them). "Vault" = the WHOLE tree, no board/agents: everything that lives
// outside projects/ (scratch/, log/, notes/, people/…) stays reachable, which
// is what lets the Notes tab retire. "Unassigned" = sessions whose role has
// no project/areas binding (chat forks, one-off creates) — also a prompt to
// stamp them.
export const VAULT_SLUG = '~vault'
export const UNASSIGNED_SLUG = '~unassigned'

export const VAULT_SPACE: SpaceSummary = {
  kind: 'project', slug: VAULT_SLUG, title: 'Vault', notePath: null, boardPath: null, status: null, fileCount: 0,
}
export const UNASSIGNED_SPACE: SpaceSummary = {
  kind: 'project', slug: UNASSIGNED_SLUG, title: 'Unassigned', notePath: null, boardPath: null, status: null, fileCount: 0,
}

export function spaceScopePrefixes(space: SpaceSummary): string[] {
  // Projects own projects/<slug>/** plus the flat projects/<slug>.md; areas
  // have no folder (their writing is blog posts) — no file scope. The Vault
  // pseudo-space scopes to nothing = everything.
  if (space.slug === VAULT_SLUG) return ['']
  if (space.slug === UNASSIGNED_SLUG) return []
  return space.kind === 'project' ? [`projects/${space.slug}/`, `projects/${space.slug}.md`] : []
}

function SpaceRail({ space }: { space: SpaceSummary }) {
  const setActiveView = useSpacesStore((s) => s.setActiveView)
  const roles = useAgentStore((s) => s.agentRoles)
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const selectSession = useAgentStore((s) => s.selectSession)
  const reviveAgent = useAgentStore((s) => s.reviveAgent)

  // Forks included — they inherit the source role's space binding and are
  // first-class here (assignable on the board, revivable, chattable).
  // Arranged as a lineage tree via `manager` edges (a fork's manager is its
  // source role), depth-indented like the Agents sidebar.
  const spaceRoles = useMemo(() => {
    const inSpace = roles.filter((r) => {
      if (r.folder) return false
      if (space.slug === VAULT_SLUG) return false
      if (space.slug === UNASSIGNED_SLUG) return !r.project && !(r.areas ?? []).length
      return space.kind === 'project' ? r.project === space.slug : (r.areas ?? []).includes(space.slug)
    })
    const keys = new Set(inSpace.map((r) => r.key))
    const childrenOf = new Map<string, typeof inSpace>()
    for (const r of inSpace) {
      if (r.manager && keys.has(r.manager)) {
        const arr = childrenOf.get(r.manager) ?? []
        arr.push(r)
        childrenOf.set(r.manager, arr)
      }
    }
    const out: Array<{ role: (typeof inSpace)[number]; depth: number }> = []
    const emit = (r: (typeof inSpace)[number], depth: number) => {
      out.push({ role: r, depth })
      for (const child of childrenOf.get(r.key) ?? []) emit(child, depth + 1)
    }
    for (const r of inSpace) {
      if (!r.manager || !keys.has(r.manager)) emit(r, 0)
    }
    return out
  }, [roles, space])
  const sessionFor = (key: string) => sessions.find((s) => s.agentKey === key && s.status !== 'ended')

  // Unassigned: also list live sessions with NO role at all (chat forks,
  // one-off `con agent create`s) — they have no role row to render.
  const rolelessSessions = useMemo(() => {
    if (space.slug !== UNASSIGNED_SLUG) return []
    return sessions.filter((s) => s.status !== 'ended' && !s.isAl && !s.agentKey)
  }, [space.slug, sessions])

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
        <span className="text-xs font-medium text-text-primary truncate">{space.title}</span>
        {space.kind === 'area' && <Tag size={9} className="text-text-tertiary flex-shrink-0" />}
      </div>
      <div className="max-h-[40%] flex-shrink-0 overflow-y-auto py-1">
        <RailSection label="Agents">
          {spaceRoles.length === 0 && rolelessSessions.length === 0 && (
            <div className="px-3 py-1 text-[10px] text-text-tertiary">
              {space.slug === VAULT_SLUG
                ? 'The vault has no agents — this is pure notes territory'
                : `None — stamp ${space.kind === 'project' ? `project: ${space.slug}` : `areas: [${space.slug}]`} in a role file`}
            </div>
          )}
          {spaceRoles.map(({ role: r, depth }) => {
            const live = sessionFor(r.key)
            const isActive = live?.id === activeSessionId
            const alert = live?.needsAttention ? 'attention' : live?.status === 'running' ? 'working' : live?.hasUnread ? 'unread' : null
            // The live session's name is the CURRENT name (renames land there);
            // the role file title is only the mint-time name. Strip the noisy
            // "(fork)" suffix — the glyph + indent already say fork.
            const displayName = (live?.name || r.title).replace(/\s\(fork\)$/, '')
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
                    'flex w-full items-center gap-2 py-1 pr-3 text-left text-xs transition-colors',
                    isActive ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-1 hover:text-text-primary',
                  )}
                  style={{ paddingLeft: `${12 + depth * 14}px` }}
                  title={`${r.fork ? 'fork · ' : ''}${live ? displayName : `${displayName} (parked — click to revive)`} · @${r.key}`}
                >
                  {r.fork
                    ? <GitBranch size={10} className={clsx('flex-shrink-0', alert === 'attention' ? 'text-red-500' : alert === 'working' ? 'text-amber-500' : alert === 'unread' ? 'text-blue-500' : 'opacity-60')} />
                    : <Bot size={10} className={clsx('flex-shrink-0', alert === 'attention' ? 'text-red-500' : alert === 'working' ? 'text-amber-500' : alert === 'unread' ? 'text-blue-500' : 'opacity-60')} />}
                  <span className={clsx('truncate', !live && 'opacity-60')}>{displayName}</span>
                  {!live && <span className="ml-auto text-[9px] text-text-tertiary flex-shrink-0">⏾</span>}
                </button>
              </ContextMenu>
            )
          })}
          {rolelessSessions.map((sess) => {
            const isActive = sess.id === activeSessionId
            const alert = sess.needsAttention ? 'attention' : sess.status === 'running' ? 'working' : sess.hasUnread ? 'unread' : null
            const agent = useAgentStore.getState()
            const name = (sess.name || sess.id).replace(/\s\(fork\)$/, '')
            const menuItems: ContextMenuItem[] = [
              { label: 'Mark read', onClick: () => agent.markSessionRead(sess.id) },
              { label: 'Mark unread', onClick: () => agent.markSessionUnread(sess.id) },
              { label: 'End session', onClick: () => agent.killSession(sess.id), destructive: true },
            ]
            return (
              <ContextMenu key={sess.id} items={menuItems}>
                <button
                  onClick={() => selectSession(sess.id)}
                  className={clsx(
                    'flex w-full items-center gap-2 py-1 pr-3 pl-3 text-left text-xs transition-colors',
                    isActive ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-1 hover:text-text-primary',
                  )}
                  title={`${name} · no role`}
                >
                  <Bot size={10} className={clsx('flex-shrink-0', alert === 'attention' ? 'text-red-500' : alert === 'working' ? 'text-amber-500' : alert === 'unread' ? 'text-blue-500' : 'opacity-60')} />
                  <span className="truncate">{name}</span>
                </button>
              </ContextMenu>
            )
          })}
        </RailSection>
      </div>
      {/* Files — the full Notes tree (context-menu rename/delete, new-note
          form, quick switcher), scoped to this project's folder. */}
      {space.slug === VAULT_SLUG ? (
        <div className="flex-1 min-h-0 flex flex-col border-t border-border">
          <NotesFileBrowser compact onOpened={() => setActiveView('docs')} />
        </div>
      ) : space.slug === UNASSIGNED_SLUG ? (
        <div className="border-t border-border px-3 py-2 text-[10px] text-text-tertiary">
          Sessions with no space — stamp `project:`/`areas:` in their role file to home them
        </div>
      ) : space.kind === 'project' ? (
        <div className="flex-1 min-h-0 flex flex-col border-t border-border">
          <NotesFileBrowser
            rootPath={`projects/${space.slug}`}
            compact
            onOpened={() => setActiveView('docs')}
          />
        </div>
      ) : (
        <div className="border-t border-border px-3 py-2 text-[10px] text-text-tertiary">
          Area writing lives in the blog (tag: {space.slug})
        </div>
      )}
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
          {hasBoard ? (
            <ViewTab label="Board" icon={<Kanban size={10} />} active={showBoard} onClick={() => setActiveView('board')} />
          ) : space.kind === 'project' && !space.slug.startsWith('~') ? (
            <ViewTab label="Create board" icon={<Kanban size={10} />} active={false} onClick={() => void useSpacesStore.getState().createBoard(space.slug)} />
          ) : null}
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
  const toggleBlocked = useSpacesStore((s) => s.toggleBlocked)
  const editCard = useSpacesStore((s) => s.editCard)
  const deleteCard = useSpacesStore((s) => s.deleteCard)
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
      {/* Done stays in the FILE (the watcher's transition diff + history need
          it) but is noise on screen — a done card was already reviewed. */}
      {board.columns.filter((col) => !/^(done|complete|completed|shipped)$/i.test(col.title)).map((col) => (
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
                  onToggleBlocked={() => void toggleBlocked({ column: col.title, index })}
                  onEdit={(text, detail) => void editCard({ column: col.title, index }, text, detail)}
                  onDelete={() => void deleteCard({ column: col.title, index })}
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

function CardTile({ card, columnTitles, currentColumn, onMove, onAssign, onToggleBlocked, onEdit, onDelete }: {
  card: BoardCard
  columnTitles: string[]
  currentColumn: string
  onMove: (to: string) => void
  onAssign: () => void
  onToggleBlocked: () => void
  onEdit: (text: string, detail: string[]) => void
  onDelete: () => void
}) {
  const detail = card.lines.slice(1).map((l) => l.trim()).filter(Boolean)
  // Inline edit: click the text → textarea seeded with "text\ndetail…"; first
  // line becomes the card, the rest indented continuations. Enter saves,
  // Shift+Enter newline, Esc cancels, blur saves.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const startEdit = () => {
    setDraft([card.text, ...detail].join('\n'))
    setEditing(true)
  }
  const commitEdit = () => {
    setEditing(false)
    const [first, ...rest] = draft.split('\n')
    if (!first?.trim()) return
    if (first.trim() === card.text && rest.join('\n') === detail.join('\n')) return
    onEdit(first.trim(), rest)
  }
  return (
    <div className={clsx(
      'rounded-sm border bg-surface-0 px-2 py-1.5',
      card.blocked ? 'border-amber-500/50' : 'border-border',
      card.checked && 'opacity-50',
    )}>
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit() }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false) }
          }}
          onBlur={commitEdit}
          rows={Math.max(2, draft.split('\n').length)}
          className="w-full resize-none rounded-sm border border-accent bg-surface-1 px-1 py-0.5 text-xs text-text-primary outline-none"
          placeholder="Card text (first line) + details…"
        />
      ) : (
        <div onClick={startEdit} className="cursor-text" title="Click to edit">
          <div className={clsx('text-xs text-text-primary', card.checked && 'line-through')}>{card.text}</div>
          {detail.length > 0 && <div className="mt-0.5 text-[10px] text-text-tertiary line-clamp-2">{detail.join(' · ')}</div>}
        </div>
      )}
      <div className="mt-1 flex items-center gap-1.5">
        {card.agentKey && (
          <span className="flex items-center gap-0.5 rounded-sm bg-violet-500/15 px-1 py-px text-[9px] text-violet-400">
            <Bot size={8} />{card.agentKey}
          </span>
        )}
        {card.blocked && (
          <button onClick={onToggleBlocked} className="rounded-sm bg-amber-500/15 px-1 py-px text-[9px] text-amber-400" title="Blocked — click to unblock">
            #blocked
          </button>
        )}
        {card.blockId && <span className="text-[9px] text-text-tertiary" title="Dispatched">^{card.blockId}</span>}
        {!card.blocked && (
          <button onClick={onToggleBlocked} className="ml-auto text-text-tertiary hover:text-amber-400 text-[9px]" title="Mark blocked">
            ⊘
          </button>
        )}
        <button onClick={onAssign} className={clsx(!card.blocked && 'ml-0', card.blocked && 'ml-auto', 'text-text-tertiary hover:text-text-primary')} title="Assign to agent">
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
        <button
          onClick={async () => {
            if (await showConfirm(`Delete card "${card.text}"?${card.blockId ? ' It has been dispatched — the assignee loses its board line.' : ''}`, { title: 'Delete card', confirmLabel: 'Delete' })) onDelete()
          }}
          className="text-text-tertiary hover:text-destructive"
          title="Delete card"
        >
          <X size={10} />
        </button>
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
    () => new Set(roles.filter((r) => {
      if (r.folder) return false
      if (space.slug === UNASSIGNED_SLUG) return !r.project && !(r.areas ?? []).length
      return space.kind === 'project' ? r.project === space.slug : (r.areas ?? []).includes(space.slug)
    }).map((r) => r.key)),
    [roles, space],
  )
  const activeSession = sessions.find((s) => s.id === activeSessionId && s.status !== 'ended')
  const activeBelongs = space.slug === UNASSIGNED_SLUG
    ? !!activeSession && !activeSession.isAl && (!activeSession.agentKey || spaceKeys.has(activeSession.agentKey))
    : !!activeSession?.agentKey && spaceKeys.has(activeSession.agentKey)

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
