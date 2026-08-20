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

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, FileText, FolderKanban, GitBranch, Kanban, Mic, Moon, Plus, RefreshCw, Tag, Trash2, UserPlus, X } from 'lucide-react'
import clsx from 'clsx'
import { useSpacesStore, type SpaceSummary } from '@/store/spaces'
import { useAgentStore } from '@/store/agent'
import { useNotesStore } from '@/store/notes'
import { useUiStore } from '@/store/ui'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { useMicStore } from '@/store/mic'
import { showPrompt, showConfirm } from '@/dialog'
import { useDictation } from '@/hooks/useDictation'
import { dictationSeparator } from '@/utils/dictation-text'
import { AgentSessionView } from './AgentSessionView'
import { NotesEditor } from './NotesEditor'
import { NotesFileBrowser } from './NotesFileBrowser'
import { BlogView } from './notes/BlogView'
import { useBlogStore } from '@/store/blog'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { SpacesQuickSwitcher } from './SpacesQuickSwitcher'
import { SpacesFleetMenu } from './SpacesFleetMenu'
import { NewNoteModal } from './NewNoteModal'
import { NotesQuickSwitcher } from './NotesQuickSwitcher'
import { NotesLinkPicker } from './NotesLinkPicker'
import { NotesCommandPalette } from './NotesCommandPalette'
import type { BoardCard, CardRef } from '@/kanban/board'

export const SpacesTab = memo(function SpacesTab() {
  const spaces = useSpacesStore((s) => s.spaces)
  const activeSlug = useSpacesStore((s) => s.activeSlug)
  const refreshSpaces = useSpacesStore((s) => s.refreshSpaces)
  const switcherOpen = useSpacesStore((s) => s.switcherOpen)
  const newFileFormOpen = useNotesStore((s) => s.newFileFormOpen)
  const notesQuickSwitcherOpen = useNotesStore((s) => s.quickSwitcherOpen)
  const linkPickerOpen = useNotesStore((s) => s.linkPickerOpen)
  const commandPaletteOpen = useNotesStore((s) => s.commandPaletteOpen)
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

  const isMobile = useIsMobile()
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const activeFilePath = useNotesStore((s) => s.activeFilePath)
  if (isMobile) {
    // One page at a time: space list → space contents → detail (session or
    // editor). mobileGoBack('spaces') walks this in reverse.
    const detail = activeSessionId ? 'session' : activeFilePath ? 'editor' : null
    return (
      <div className="flex flex-1 h-full min-w-0 flex-col">
        {!active ? (
          <div className="flex flex-1 min-h-0 flex-col"><SpaceListRail /></div>
        ) : detail === 'session' ? (
          <SpaceAgentPanel space={active} />
        ) : detail === 'editor' && isActivePane ? (
          <NotesEditor scopePrefixes={spaceScopePrefixes(active)} />
        ) : (
          <div className="flex flex-1 min-h-0 flex-col"><SpaceRail space={active} /></div>
        )}
        {switcherOpen && <SpacesQuickSwitcher />}
        <SpacesHandoffBanner />
        {newFileFormOpen && isActivePane && <NewNoteModal />}
        {notesQuickSwitcherOpen && isActivePane && <NotesQuickSwitcher />}
        {linkPickerOpen && isActivePane && <NotesLinkPicker />}
        {commandPaletteOpen && isActivePane && <NotesCommandPalette />}
      </div>
    )
  }

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
      <SpacesHandoffBanner />
      {/* NewNoteModal is store-gated and also mounted by NotesTab — gate on
          the active pane so two panes never render it twice. */}
      {newFileFormOpen && isActivePane && <NewNoteModal />}
      {/* Notes modals (Ctrl+P find-file, [[link]] picker, Ctrl+Shift+P palette)
          — store-gated like NewNoteModal, also mounted by NotesTab; pane-gate
          so only the visible pane renders them. */}
      {notesQuickSwitcherOpen && isActivePane && <NotesQuickSwitcher />}
      {linkPickerOpen && isActivePane && <NotesLinkPicker />}
      {commandPaletteOpen && isActivePane && <NotesCommandPalette />}
    </div>
  )
})

// Al hand-off affordances (mirror AgentTab's): the opt-in "Talk to X" banner
// + the "Back to Al" return chip. Global overlays, shown wherever agent
// sessions are hosted — which now includes Spaces.
function SpacesHandoffBanner() {
  const pendingHandoff = useAgentStore((s) => s.pendingHandoff)
  const handoffReturnTo = useAgentStore((s) => s.handoffReturnTo)
  const acceptHandoff = useAgentStore((s) => s.acceptHandoff)
  const dismissHandoff = useAgentStore((s) => s.dismissHandoff)
  const returnFromHandoff = useAgentStore((s) => s.returnFromHandoff)
  const agentRoles = useAgentStore((s) => s.agentRoles)
  if (pendingHandoff) {
    return (
      <div className="fixed bottom-4 left-1/2 z-50 flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-lg border border-violet-500/40 bg-surface-2 px-3 py-2 shadow-xl">
        <span className="text-xs text-text-secondary">Al suggests you talk to <span className="font-medium text-text-primary">{agentRoles.find((r) => r.key === pendingHandoff.targetAgentKey)?.title ?? pendingHandoff.targetAgentKey}</span></span>
        <button onClick={() => acceptHandoff(pendingHandoff.targetAgentKey)} className="rounded bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-500">Talk →</button>
        <button onClick={dismissHandoff} className="text-text-tertiary hover:text-text-primary"><X size={12} /></button>
      </div>
    )
  }
  if (handoffReturnTo) {
    return (
      <button
        onClick={returnFromHandoff}
        className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-secondary shadow-xl hover:text-text-primary"
      >
        ↩ Back to Al
      </button>
    )
  }
  return null
}

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
        <span className="flex items-center gap-2">
          <SpacesFleetMenu />
          <button onClick={() => void refreshSpaces()} className="text-text-tertiary hover:text-text-primary" title="Refresh">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </span>
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
  const micOwnerId = useMicStore((s) => s.owner)

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
        <RailSection
          label="Agents"
          action={!space.slug.startsWith('~') ? {
            icon: <Plus size={10} />,
            title: 'New agent in this space',
            onClick: async () => {
              const title = await showPrompt('Agent name', { title: `New agent in ${space.title}`, placeholder: 'e.g. Landing page' })
              if (!title?.trim()) return
              const prompt = await showPrompt('What should it do?', { title: title.trim(), placeholder: 'The opening prompt / charter' })
              if (prompt === null) return
              // asAgent mints a durable role with the space binding baked into
              // the role file's frontmatter — it appears here immediately.
              useAgentStore.getState().createSessionAsAgent(
                prompt.trim() || 'Await instructions.',
                undefined,
                title.trim(),
                space.kind === 'project' ? { project: space.slug } : { areas: [space.slug] },
              )
            },
          } : undefined}
        >
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
                { label: 'Rename', onClick: async () => {
                  const name = await showPrompt('Session name', { title: 'Rename', defaultValue: live.name ?? '' })
                  if (name?.trim()) agent.renameSession(live.id, name.trim())
                } },
                { label: 'Generate title', onClick: () => agent.generateTitle(live.id) },
                { label: useMicStore.getState().owner === live.id ? 'Release mic to Al' : 'Give mic', onClick: () => useMicStore.getState().setMic(useMicStore.getState().owner === live.id ? 'al' : live.id) },
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
                  <span className="ml-auto flex items-center gap-1 flex-shrink-0">
                    {live && micOwnerId === live.id && <Mic size={9} className="text-text-primary" />}
                    {live?.hibernated && <span title="Hibernated — wakes on next message"><Moon size={9} className="text-text-tertiary" /></span>}
                    {!live && <span className="text-[9px] text-text-tertiary">⏾</span>}
                  </span>
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
      {/* Devlog — projects have blogs too: posts tagged project: <slug>,
          newest first, + New post into the blog drafts flow. */}
      {space.kind === 'project' && !space.slug.startsWith('~') && (
        <ProjectDevlog slug={space.slug} onOpened={() => setActiveView('docs')} />
      )}
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
        /* Areas: writing IS the content — the blog view (drafts, projects
           with devlogs, recent posts) fills the space rail. */
        <div className="flex-1 min-h-0 flex flex-col border-t border-border">
          <BlogView compact onOpened={() => setActiveView('docs')} />
        </div>
      )}
    </>
  )
}

// Devlog strip for a project space: its published posts (tag project: slug),
// collapsed by default to a count, + New post via the blog drafts flow.
function ProjectDevlog({ slug, onOpened }: { slug: string; onOpened: () => void }) {
  const posts = useBlogStore((s) => s.postsByProject[slug])
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    void useBlogStore.getState().refreshProjectPosts(slug)
  }, [slug])
  const newPost = async () => {
    const title = await showPrompt(`Title for the post about ${slug}:`, { title: 'New devlog post', confirmLabel: 'Create' })
    if (!title?.trim()) return
    const r = await useBlogStore.getState().createDraft({ title: title.trim(), project: slug })
    if (r.ok && r.path) {
      await useNotesStore.getState().openFile(r.path)
      onOpened()
    }
  }
  return (
    <div className="flex-shrink-0 border-t border-border max-h-[30%] overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-1">
        <button onClick={() => setExpanded((v) => !v)} className="text-[10px] uppercase tracking-wide text-text-tertiary hover:text-text-secondary">
          Devlog{posts?.length ? ` (${posts.length})` : ''}
        </button>
        <button onClick={() => void newPost()} className="text-text-tertiary hover:text-text-primary" title="New devlog post">
          <Plus size={10} />
        </button>
      </div>
      {expanded && (posts ?? []).map((p) => (
        <button
          key={p.path}
          onClick={() => { void useNotesStore.getState().openFile(p.path).then(onOpened) }}
          className="flex w-full items-center gap-2 px-3 py-0.5 text-left text-[11px] text-text-secondary hover:bg-surface-1 hover:text-text-primary"
        >
          <FileText size={9} className="flex-shrink-0 opacity-50" />
          <span className="truncate">{p.title}</span>
          {p.date && <span className="ml-auto flex-shrink-0 text-[9px] text-text-tertiary">{p.date.slice(0, 10)}</span>}
        </button>
      ))}
      {expanded && (posts ?? []).length === 0 && (
        <div className="px-3 pb-1 text-[10px] text-text-tertiary">No posts tagged project: {slug}</div>
      )}
    </div>
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
  const sessions = useAgentStore((s) => s.sessions)
  const activeSlug = useSpacesStore((s) => s.activeSlug)
  // Filter the board to one assignee's cards — how a fork (or you) views ITS
  // OWN queue rather than the whole master board. null = everyone.
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null)
  // Assign picker target (card ref) — replaces the raw @key text prompt.
  const [assignTarget, setAssignTarget] = useState<{ ref: CardRef; card: BoardCard } | null>(null)
  // Card detail modal — the roomy editing surface (title, details, assignee,
  // column, blocked, delete in one place).
  const [detailTarget, setDetailTarget] = useState<{ ref: CardRef; card: BoardCard } | null>(null)
  // Which column has an open new-card editor (one at a time).
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const addCardWithDetail = async (column: string, text: string, detail: string[]) => {
    await addCardTo(column, text)
    // The fresh card is the column's last — stamp its detail lines in.
    const board = useSpacesStore.getState().board
    const col = board?.columns.find((c) => c.title === column)
    if (col && detail.some((l) => l.trim())) {
      await editCard({ column, index: col.cards.length - 1 }, text, detail)
    }
  }

  if (boardError) return <div className="flex-1 grid place-items-center text-xs text-destructive">{boardError}</div>
  if (!board) return <div className="flex-1 grid place-items-center text-xs text-text-tertiary">Loading board…</div>

  const columnTitles = board.columns.map((c) => c.title)
  // Assignable = any non-folder role, forks included — labelled by the live
  // session's CURRENT name (renames land there) falling back to the role
  // title, never the raw @key; space-bound roles sort first.
  const liveByKey = new Map(sessions.filter((x) => x.status !== 'ended' && x.agentKey).map((x) => [x.agentKey!, x]))
  const inSpace = (r: (typeof roles)[number]) =>
    r.project === activeSlug || (r.areas ?? []).includes(activeSlug ?? '')
  const assignable = roles
    .filter((r) => !r.folder)
    .map((r) => ({
      key: r.key,
      label: (liveByKey.get(r.key)?.name || r.title).replace(/\s\(fork\)$/, ''),
      fork: !!r.fork,
      bound: inSpace(r),
      live: liveByKey.has(r.key),
    }))
    .sort((a, b) => Number(b.bound) - Number(a.bound) || Number(b.live) - Number(a.live) || a.label.localeCompare(b.label))
  const labelFor = (key: string) => assignable.find((a) => a.key === key)?.label ?? key
  const assignees = [...new Set(board.columns.flatMap((c) => c.cards.map((card) => card.agentKey)).filter(Boolean))] as string[]

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
              title={`@${key}`}
            >
              {labelFor(key)}
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
              onClick={() => setAddingTo(addingTo === col.title ? null : col.title)}
              className="text-text-tertiary hover:text-text-primary"
              title={`Add card to ${col.title}`}
            >
              <Plus size={10} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5">
            {addingTo === col.title && (
              <div className="rounded-sm border border-accent/50 bg-surface-0 px-2 py-1.5">
                <CardEditor
                  initial=""
                  placeholder={`New card in ${col.title}…`}
                  onCommit={(draft) => {
                    setAddingTo(null)
                    const [first, ...rest] = draft.split('\n')
                    if (first?.trim()) void addCardWithDetail(col.title, first.trim(), rest)
                  }}
                  onCancel={() => setAddingTo(null)}
                />
              </div>
            )}
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
                  onAssign={() => setAssignTarget({ ref: { column: col.title, index }, card })}
                  onToggleBlocked={() => void toggleBlocked({ column: col.title, index })}
                  onEdit={(text, detail) => void editCard({ column: col.title, index }, text, detail)}
                  onDelete={() => void deleteCard({ column: col.title, index })}
                  onOpen={() => setDetailTarget({ ref: { column: col.title, index }, card })}
                />
              ) : null
            ))}
          </div>
        </div>
      ))}
      </div>
      {detailTarget && (
        <CardDetailModal
          key={detailTarget.card.blockId ?? `${detailTarget.ref.column}:${detailTarget.ref.index}`}
          card={detailTarget.card}
          columnTitles={columnTitles}
          currentColumn={detailTarget.ref.column}
          assignable={assignable}
          onClose={() => setDetailTarget(null)}
          onEditContent={(text, detail) => void editCard(detailTarget.ref, text, detail)}
          onAssignKey={(key) => void assignCard(detailTarget.ref, key)}
          onToggleBlockedNow={() => void toggleBlocked(detailTarget.ref)}
          onMoveColumn={(to) => {
            const { ref } = detailTarget
            // moveCard appends to the destination column — track the new ref
            // so later instant-applies (assign/block/content) hit the right card.
            const destCol = board.columns.find((c) => c.title === to)
            const newIndex = destCol ? destCol.cards.length : 0
            setDetailTarget({ ...detailTarget, ref: { column: to, index: newIndex } })
            void moveCardTo(ref, to)
          }}
          onDelete={() => {
            const { ref } = detailTarget
            setDetailTarget(null)
            void deleteCard(ref)
          }}
        />
      )}
      {assignTarget && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[20vh]" onClick={(e) => { if (e.target === e.currentTarget) setAssignTarget(null) }}>
          <div className="mx-4 w-full max-w-xs overflow-hidden rounded-lg border border-border bg-surface-0 shadow-xl">
            <div className="border-b border-border px-3 py-1.5 text-xs text-text-secondary truncate">Assign: {assignTarget.card.text}</div>
            <div className="max-h-[45vh] overflow-y-auto py-1">
              {assignTarget.card.agentKey && (
                <button
                  onClick={() => { void assignCard(assignTarget.ref, null); setAssignTarget(null) }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-tertiary hover:bg-surface-1"
                >
                  <X size={11} className="flex-shrink-0" /> Unassign
                </button>
              )}
              {assignable.map((a, i) => (
                <button
                  key={a.key}
                  onClick={() => { void assignCard(assignTarget.ref, a.key); setAssignTarget(null) }}
                  className={clsx(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-1',
                    a.key === assignTarget.card.agentKey ? 'bg-surface-2 text-text-primary' : 'text-text-secondary',
                    // Divider where space-bound roles end
                    i > 0 && a.bound !== assignable[i - 1]!.bound && 'border-t border-border',
                  )}
                  title={`@${a.key}`}
                >
                  {a.fork
                    ? <GitBranch size={11} className="flex-shrink-0 opacity-60" />
                    : <Bot size={11} className="flex-shrink-0 opacity-60" />}
                  <span className="truncate">{a.label}</span>
                  {!a.live && <span className="ml-auto flex-shrink-0 text-[9px] text-text-tertiary">parked</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Linear-style issue view. Click a card → this opens. No Save button:
 *  properties (column, assignee, #blocked) are pills that apply INSTANTLY;
 *  title + description are borderless editors that autosave on blur/close.
 *  Esc / backdrop / X close (committing any pending text). */
function CardDetailModal({ card, columnTitles, currentColumn, assignable, onClose, onEditContent, onAssignKey, onToggleBlockedNow, onMoveColumn, onDelete }: {
  card: BoardCard
  columnTitles: string[]
  currentColumn: string
  assignable: Array<{ key: string; label: string; fork: boolean; bound: boolean; live: boolean }>
  onClose: () => void
  /** Persist title/description. Ref-stable (content changes don't move the card). */
  onEditContent: (text: string, detail: string[]) => void
  onAssignKey: (key: string | null) => void
  onToggleBlockedNow: () => void
  /** Moves the card; parent updates the tracked ref. */
  onMoveColumn: (to: string) => void
  onDelete: () => void
}) {
  const initialDetail = card.lines.slice(1).map((l) => l.trim()).filter(Boolean)
  const [text, setText] = useState(card.text)
  const [detail, setDetail] = useState(initialDetail.join('\n'))
  // Instant-apply property state (mirrors what we've already persisted).
  const [agentKey, setAgentKey] = useState<string | null>(card.agentKey)
  const [blocked, setBlocked] = useState(card.blocked)
  const [column, setColumn] = useState(currentColumn)
  const textRef = useRef(text)
  const detailStrRef = useRef(detail)
  textRef.current = text
  detailStrRef.current = detail
  const savedRef = useRef({ text: card.text, detail: initialDetail.join('\n') })

  const commitContent = () => {
    const t = textRef.current.trim()
    const d = detailStrRef.current
    if (!t) return
    if (t === savedRef.current.text && d === savedRef.current.detail) return
    savedRef.current = { text: t, detail: d }
    onEditContent(t, d.split('\n'))
  }
  const close = () => {
    dictation.stop()
    commitContent()
    onClose()
  }

  const dictation = useDictation({
    onText: (t, verbatim) => {
      const before = detailStrRef.current
      setDetail(before + dictationSeparator(before, t, verbatim) + t)
    },
  })

  // Description auto-grows; title is a single auto-wrapping textarea too
  // (Linear titles wrap, they don't scroll).
  const titleRows = Math.max(1, Math.ceil(text.length / 52))

  const pill = 'flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-text-secondary hover:border-text-tertiary transition-colors cursor-pointer'

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[8vh]"
      onClick={(e) => { if (e.target === e.currentTarget) close() }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } }}
    >
      <div className="mx-4 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-surface-0 shadow-2xl">
        {/* Property pills — instant apply, Linear-style header row */}
        <div className="flex flex-wrap items-center gap-1.5 px-5 pt-4">
          {/* Column pill (status) */}
          <label className={pill} title="Column">
            <Kanban size={10} className="text-text-tertiary" />
            <select
              value={column}
              onChange={(e) => { setColumn(e.target.value); onMoveColumn(e.target.value) }}
              className="cursor-pointer appearance-none bg-transparent outline-none"
            >
              {columnTitles.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          {/* Assignee pill */}
          <label className={pill} title="Assignee">
            <Bot size={10} className={agentKey ? 'text-violet-400' : 'text-text-tertiary'} />
            <select
              value={agentKey ?? ''}
              onChange={(e) => { const k = e.target.value || null; setAgentKey(k); onAssignKey(k) }}
              className="max-w-36 cursor-pointer appearance-none truncate bg-transparent outline-none"
            >
              <option value="">Unassigned</option>
              {assignable.map((a) => (
                <option key={a.key} value={a.key}>{a.label}{a.fork ? ' ⑂' : ''}{a.live ? '' : ' · parked'}</option>
              ))}
            </select>
          </label>
          {/* Blocked pill */}
          <button
            onClick={() => { setBlocked(!blocked); onToggleBlockedNow() }}
            className={clsx(pill, blocked && 'border-amber-500/50 bg-amber-500/10 text-amber-400')}
            title={blocked ? 'Unblock' : 'Mark blocked'}
          >
            ⊘ {blocked ? 'blocked' : 'block'}
          </button>
          {card.blockId && (
            <span className="rounded-full border border-transparent px-2 py-0.5 text-[11px] text-text-tertiary" title="Dispatch id — the agent's board line identity">
              ^{card.blockId}
            </span>
          )}
          <span className="flex-1" />
          <button
            onClick={() => { void showConfirm('Delete this card?', { title: 'Delete card', confirmLabel: 'Delete' }).then((ok) => { if (ok) { dictation.stop(); onDelete() } }) }}
            className="text-text-tertiary hover:text-destructive"
            title="Delete card"
          >
            <Trash2 size={13} />
          </button>
          <button onClick={close} className="text-text-tertiary hover:text-text-primary" title="Close">
            <X size={14} />
          </button>
        </div>

        {/* Title — borderless, wraps like Linear */}
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value.replace(/\n/g, ' '))}
          onBlur={commitContent}
          onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
          rows={titleRows}
          placeholder="Card title"
          className="w-full resize-none bg-transparent px-5 pt-3 pb-1 text-lg font-semibold leading-snug text-text-primary outline-none placeholder:text-text-tertiary"
        />

        {/* Description — borderless, fills the modal */}
        <div className="flex min-h-0 flex-1 flex-col px-5 pb-3">
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            onBlur={commitContent}
            placeholder="Add description…"
            className="min-h-40 w-full flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-text-secondary outline-none placeholder:text-text-tertiary"
          />
          {dictation.interim && <div className="text-[11px] italic text-text-tertiary">{dictation.interim}</div>}
        </div>

        {/* Footer — dictation + hint, quiet */}
        <div className="flex items-center justify-between border-t border-border px-5 py-2">
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => dictation.recording ? dictation.stop() : dictation.start()}
            className={clsx('flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[11px]', dictation.recording ? 'bg-surface-2 text-red-400' : 'text-text-tertiary hover:text-text-primary')}
          >
            <Mic size={11} className={dictation.recording ? 'animate-pulse' : ''} />
            {dictation.recording ? 'listening…' : 'Dictate'}
          </button>
          <span className="text-[10px] text-text-tertiary">Changes save automatically · esc to close</span>
        </div>
      </div>
    </div>
  )
}

/** Card content editor — one dictate-able textarea. There is no separate
 *  title/body: the card IS its first line (the board format is one `- [ ]`
 *  line), and any further lines become the indented detail. Dictation streams
 *  into the draft at the end; Enter commits, Shift+Enter breaks a line. */
function CardEditor({ initial, placeholder, onCommit, onCancel }: {
  initial: string
  placeholder: string
  onCommit: (draft: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const dictation = useDictation({
    onText: (text, verbatim) => {
      const before = draftRef.current
      setDraft(before + dictationSeparator(before, text, verbatim) + text)
    },
  })
  const commit = () => { dictation.stop(); onCommit(draftRef.current) }
  return (
    <div>
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dictation.stop(); onCancel() }
        }}
        onBlur={(e) => {
          // Clicking the mic must not commit-and-close the editor.
          if (e.relatedTarget instanceof HTMLElement && e.relatedTarget.dataset.cardMic) return
          commit()
        }}
        rows={Math.max(2, draft.split('\n').length + (dictation.interim ? 1 : 0))}
        className="w-full resize-none rounded-sm border border-accent bg-surface-1 px-1 py-0.5 text-xs text-text-primary outline-none"
        placeholder={placeholder}
      />
      {dictation.interim && <div className="px-1 text-[10px] italic text-text-tertiary">{dictation.interim}</div>}
      <div className="mt-0.5 flex items-center justify-between">
        <button
          data-card-mic="1"
          onMouseDown={(e) => e.preventDefault() /* keep textarea focus */}
          onClick={() => dictation.recording ? dictation.stop() : dictation.start()}
          className={clsx('flex items-center gap-1 rounded-sm px-1 py-0.5 text-[10px]', dictation.recording ? 'bg-surface-2 text-red-400' : 'text-text-tertiary hover:text-text-primary')}
          title={dictation.recording ? 'Stop dictation' : 'Dictate'}
        >
          <Mic size={10} className={dictation.recording ? 'animate-pulse' : ''} />
          {dictation.recording ? 'listening…' : 'dictate'}
        </button>
        <span className="text-[9px] text-text-tertiary">↵ save · ⇧↵ new line · esc cancel</span>
      </div>
    </div>
  )
}

function CardTile({ card, columnTitles, currentColumn, onMove, onAssign, onToggleBlocked, onEdit, onDelete, onOpen }: {
  card: BoardCard
  columnTitles: string[]
  currentColumn: string
  onMove: (to: string) => void
  onAssign: () => void
  onToggleBlocked: () => void
  onEdit: (text: string, detail: string[]) => void
  onDelete: () => void
  /** Open the roomy detail modal (dbl-click or the expand button). */
  onOpen: () => void
}) {
  const detail = card.lines.slice(1).map((l) => l.trim()).filter(Boolean)
  // Linear model: the card is a clean summary tile — click opens the issue
  // view where ALL editing happens. The footer keeps two zero-navigation
  // affordances (assignee chip → picker, quick column select); everything
  // else lives in the modal.
  void onToggleBlocked; void onEdit; void onDelete
  return (
    <div className={clsx(
      'group rounded-sm border bg-surface-0 px-2 py-1.5 transition-colors hover:border-text-tertiary/40',
      card.blocked ? 'border-amber-500/50' : 'border-border',
      card.checked && 'opacity-50',
    )}>
      <div onClick={onOpen} className="cursor-pointer" title="Open">
        <div className={clsx('text-xs text-text-primary', card.checked && 'line-through')}>{card.text}</div>
        {detail.length > 0 && <div className="mt-0.5 text-[10px] text-text-tertiary line-clamp-2">{detail.join(' · ')}</div>}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <button
          onClick={onAssign}
          className={clsx(
            'flex items-center gap-0.5 rounded-sm px-1 py-px text-[9px]',
            card.agentKey ? 'bg-violet-500/15 text-violet-400 hover:bg-violet-500/25' : 'text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-text-primary',
          )}
          title={card.agentKey ? `@${card.agentKey} — click to reassign` : 'Assign to agent'}
        >
          {card.agentKey ? <><Bot size={8} />{card.agentKey}</> : <UserPlus size={10} />}
        </button>
        {card.blocked && <span className="rounded-sm bg-amber-500/15 px-1 py-px text-[9px] text-amber-400">#blocked</span>}
        {card.blockId && <span className="text-[9px] text-text-tertiary" title="Dispatched">^{card.blockId}</span>}
        <select
          value={currentColumn}
          onChange={(e) => { if (e.target.value !== currentColumn) onMove(e.target.value) }}
          onClick={(e) => e.stopPropagation()}
          className="ml-auto max-w-24 cursor-pointer border-none bg-transparent text-[9px] text-text-tertiary opacity-0 outline-none transition-opacity group-hover:opacity-100"
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
