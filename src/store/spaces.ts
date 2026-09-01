// Spaces — project-first nav state. A space is a project (folder under
// projects/) or an area (registry tag). Backed by /blog/spaces. Board READS
// come via /notes/file/ (plain vault markdown); board MUTATIONS go through
// POST /board/:project/* (BoardOps) — the hub's per-board lock serializes
// concurrent writers, so a stale SPA copy can never wipe fresh ^id stamps
// the way whole-file writes could. Local mutations still apply optimistically
// for instant UI; the API result is canonical and errors trigger a re-read.

import { create } from 'zustand'
import { hubFetch } from '@/hub'
import { parseBoard, boardDefaultOwner, moveCard, addCard, refreshCardLine, findCard, type KanbanBoard, type CardRef } from '@/kanban/board'
import { VAULT_SLUG, UNASSIGNED_SLUG, VAULT_SPACE, UNASSIGNED_SPACE, spaceScopePrefixes, pathInScope, pickSpaceView } from '@/spaces/scope'
import { useNotesStore } from '@/store/notes'
import { useBlogStore } from '@/store/blog'

export interface SpaceSummary {
  kind: 'project' | 'area'
  slug: string
  title: string
  notePath: string | null
  boardPath: string | null
  status: 'active' | 'dormant' | 'complete' | null
  fileCount: number
  /** Under-Review card count on the project board (optional: an older hub
   *  payload omits it — always read with ?? fallbacks). */
  reviewCount?: number
  /** agentKeys assigned to those review cards. */
  reviewAgentKeys?: string[]
  /** agentKeys assigned to ANY card on the board — card-owned forks are
   *  reachable via their card, so the rail suppresses their badge/rows
   *  (^lean-ibis). Optional: older hub payloads omit it. */
  cardAgentKeys?: string[]
  /** Board frontmatter `default_owner:` — unassigned cards dragged into In
   *  Progress auto-assign to this agent. Optional: older hub payloads omit it. */
  defaultOwner?: string | null
}

interface SpacesState {
  spaces: SpaceSummary[]
  loading: boolean
  activeSlug: string | null
  /** Centre-pane tab within the active space. Docs IS the vault editor
   *  (absorbing the Notes tab); the file list lives in the drilled rail. */
  activeView: 'board' | 'docs'
  /** Parsed board for the active space (null = no board / not loaded). */
  board: KanbanBoard | null
  boardPath: string | null
  boardMtime: number | null
  boardError: string | null
  /** A local mutation's write is in flight — the boards/changed event it
   *  triggers must not re-read over the (newer) in-memory copy. */
  saving: boolean

  refreshSpaces: () => Promise<void>
  selectSpace: (slug: string | null) => void
  setActiveView: (v: 'board' | 'docs') => void
  loadBoard: () => Promise<void>
  /** POST one mutation to /board/:project/:verb (BoardOps serializes writers).
   *  Body's `card` addresses by ^id or unique text. Errors surface in
   *  boardError + trigger a re-read (the server copy is canonical). */
  boardApi: (verb: string, body: Record<string, unknown>) => Promise<boolean>
  moveCardTo: (ref: CardRef, toColumn: string) => Promise<void>
  addCardTo: (column: string, text: string, agentKey?: string) => Promise<void>
  assignCard: (ref: CardRef, agentKey: string | null) => Promise<void>
  /** Flip the `#blocked` tag on a card (a property, not a column move). */
  toggleBlocked: (ref: CardRef) => Promise<void>
  /** Flip the `#nofork` tag — dispatch wakes the role directly, no fork. */
  toggleNofork: (ref: CardRef) => Promise<void>
  setCardModel: (ref: CardRef, model: string | null) => Promise<void>
  /** Set/clear a PROJECT board's `default_owner:` frontmatter (the agent that
   *  unassigned In-Progress cards auto-assign to). Takes a slug, not the active
   *  space — the session context menu reaches sessions from any rail. */
  setDefaultOwner: (slug: string, agentKey: string | null) => Promise<void>
  /** Rewrite a card's text and detail (indented continuation lines). Tokens
   *  (@key/^id/#blocked) survive — only the human-readable content changes. */
  editCard: (ref: CardRef, text: string, detail: string[]) => Promise<void>
  /** Remove a card entirely (a human judgment — agents never delete cards). */
  deleteCard: (ref: CardRef) => Promise<void>
  /** "/" command bar — jump to any space/agent/file. */
  switcherOpen: boolean
  openSwitcher: () => void
  closeSwitcher: () => void
  /** Create projects/<slug>/board.md with the standard columns and open it. */
  createBoard: (slug: string) => Promise<void>
}

const BOARD_TEMPLATE = `---

kanban-plugin: board

---

## Backlog


## In Progress


## Under Review


## Done


`

const ACTIVE_SLUG_KEY = 'console:spaces:active'
// Last centre view the user was on, per space (^dry-fawn): only consulted
// when a space has BOTH a board and open docs — one-sided spaces land on
// whichever side has content (pickSpaceView).
const VIEW_KEY_PREFIX = 'console:spaces:view:'

function rememberedViewFor(slug: string): 'board' | 'docs' | null {
  const v = localStorage.getItem(VIEW_KEY_PREFIX + slug)
  return v === 'board' || v === 'docs' ? v : null
}

/** Does this space have an open doc? Mirrors ScopedNotesEditor's scope:
 *  static prefixes + published posts / frontmatter-claimed drafts, which
 *  carry no slug in their path. */
function hasOpenDocFor(space: SpaceSummary): boolean {
  const open = Object.keys(useNotesStore.getState().openFiles)
  if (open.length === 0) return false
  const prefixes = spaceScopePrefixes(space)
  const blog = useBlogStore.getState()
  const extra = space.kind === 'project'
    ? [
        ...(blog.postsByProject[space.slug] ?? []).map((p) => p.path),
        ...blog.drafts.filter((d) => d.project === space.slug).map((d) => d.path),
      ]
    : (blog.postsByArea[space.slug] ?? []).map((p) => p.path)
  return open.some((p) => pathInScope(p, prefixes) || extra.includes(p))
}

/** Opening a project focuses its default agent (the "general purpose" one)
 *  in the agent panel — same picking order as the server's unassigned-card
 *  auto-assign (resolveDefaultOwner): single bound session → it; several →
 *  the `-general`-suffixed one; else first by key. Board frontmatter
 *  `default_owner:` wins when the board is loaded. A session already active
 *  in this space is left alone. */
async function selectDefaultAgent(slug: string): Promise<void> {
  if (slug.startsWith('~')) return
  const { useAgentStore } = await import('@/store/agent')
  const agent = useAgentStore.getState()
  const inSpace = (x: { project?: string; areas?: string[] }) => x.project === slug || (x.areas ?? []).includes(slug)
  const bound = agent.sessions.filter((x) => x.status !== 'ended' && x.agentKey && !x.parentClaudeSessionId && inSpace(x))
  if (bound.length === 0) return
  // Keep the current selection if it already belongs to this space.
  const cur = agent.sessions.find((x) => x.id === agent.activeSessionId && x.status !== 'ended')
  if (cur && inSpace(cur)) return
  // Board frontmatter default_owner (if the board happens to be loaded for
  // this slug) → picking order fallback.
  const st = useSpacesStore.getState()
  const fmOwner = st.activeSlug === slug && st.board
    ? boardDefaultOwner(st.board.header.join('\n'))
    : null
  const pick = (fmOwner && bound.find((x) => x.agentKey === fmOwner))
    ?? (bound.length === 1 ? bound[0] : undefined)
    ?? bound.find((x) => x.agentKey!.endsWith('general') || /\bgeneral$/i.test(x.name ?? ''))
    ?? [...bound].sort((a, b) => a.agentKey!.localeCompare(b.agentKey!))[0]
  if (!pick) return
  agent.selectSession(pick.id)
}

/** Jump to an agent session, landing on Spaces with its owning space selected
 *  (Spaces is the only pane hosting sessions — the Agents tab is gone).
 *  Unbound sessions land in ~unassigned. Safe against selectDefaultAgent:
 *  its keep-current-selection guard sees the session we select here. */
export async function focusSessionInSpaces(sessionId: string): Promise<void> {
  const [{ useAgentStore }, { useUiStore }] = await Promise.all([
    import('@/store/agent'),
    import('@/store/ui'),
  ])
  const agent = useAgentStore.getState()
  const sess = agent.sessions.find((x) => x.id === sessionId)
  const slug = sess?.project ?? sess?.areas?.[0] ?? (sess && !sess.isAl ? UNASSIGNED_SLUG : null)
  useUiStore.getState().setActivePane('spaces')
  if (slug) useSpacesStore.getState().selectSpace(slug)
  agent.selectSession(sessionId)
}

/** Address a card for the /board/* API: `^id` when stamped (unambiguous),
 *  else its exact text — BoardOps errors on ambiguity rather than guessing,
 *  which surfaces as boardError + a re-read. */
function cardQuery(board: KanbanBoard, ref: CardRef): string | null {
  const card = board.columns.find((c) => c.title === ref.column)?.cards[ref.index]
  if (!card) return null
  return card.blockId ? `^${card.blockId}` : card.text
}

export const useSpacesStore = create<SpacesState>((set, get) => ({
  spaces: [],
  loading: false,
  activeSlug: localStorage.getItem(ACTIVE_SLUG_KEY),
  activeView: 'board',
  board: null,
  boardPath: null,
  boardMtime: null,
  boardError: null,
  saving: false,
  switcherOpen: false,
  openSwitcher: () => set({ switcherOpen: true }),
  closeSwitcher: () => set({ switcherOpen: false }),

  refreshSpaces: async () => {
    set({ loading: true })
    try {
      const { spaces } = await hubFetch<{ spaces: SpaceSummary[] }>('/blog/spaces', { timeoutMs: 15000 })
      set({ spaces, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  selectSpace: (slug) => {
    if (slug) localStorage.setItem(ACTIVE_SLUG_KEY, slug)
    else localStorage.removeItem(ACTIVE_SLUG_KEY)
    set({ activeSlug: slug, board: null, boardPath: null, boardMtime: null, boardError: null })
    if (slug) {
      // Land on the side that has content: board-only → board, docs-only →
      // docs, both → the remembered view for this space (^dry-fawn).
      const space = get().spaces.find((s) => s.slug === slug)
        ?? (slug === VAULT_SLUG ? VAULT_SPACE : slug === UNASSIGNED_SLUG ? UNASSIGNED_SPACE : null)
      if (space) {
        set({
          activeView: pickSpaceView({
            hasBoard: !!space.boardPath,
            hasOpenDoc: hasOpenDocFor(space),
            remembered: rememberedViewFor(slug),
          }),
        })
      }
      // Default-agent pick runs AFTER the board loads so frontmatter
      // `default_owner:` is actually readable at pick time.
      void get().loadBoard().then(() => selectDefaultAgent(slug))
    }
  },

  setActiveView: (v) => {
    const slug = get().activeSlug
    // Only an explicit choice on a two-sided space is worth remembering —
    // a forced landing (no board / no docs) says nothing about preference.
    if (slug) localStorage.setItem(VIEW_KEY_PREFIX + slug, v)
    set({ activeView: v })
  },

  loadBoard: async () => {
    const { spaces, activeSlug } = get()
    const space = spaces.find((s) => s.slug === activeSlug)
    if (!space?.boardPath) { set({ board: null, boardPath: null }); return }
    try {
      const { content } = await hubFetch<{ content: string }>(`/notes/file/${encodeURIComponent(space.boardPath)}`, { timeoutMs: 10000 })
      set({ board: parseBoard(content), boardPath: space.boardPath, boardError: null })
    } catch (e) {
      set({ boardError: (e as Error).message })
    }
  },

  boardApi: async (verb, body) => {
    const { activeSlug } = get()
    if (!activeSlug || activeSlug.startsWith('~')) return false
    set({ saving: true })
    try {
      await hubFetch(`/board/${encodeURIComponent(activeSlug)}/${verb}`, {
        method: 'POST',
        body: JSON.stringify(body),
        timeoutMs: 10000,
      })
      return true
    } catch (e) {
      // Rollback FIRST (loadBoard clears boardError on success), THEN set the
      // error — otherwise the banner flashed for the split second before the
      // re-read wiped it, which read as an unexplained blink.
      await get().loadBoard().catch(() => {})
      set({ boardError: (e as Error).message })
      return false
    } finally {
      // Cover only the POST itself (no linger): BoardOps edits surgically, so
      // the watcher's boards/changed echo re-reads identical-or-newer content
      // — and staying subscribed keeps the SPA current with ^id stamps (the
      // stale-copy wipe that whole-file writes suffered can't happen at all).
      set({ saving: false })
    }
  },

  moveCardTo: async (ref, toColumn) => {
    const { board } = get()
    if (!board) return
    const q = cardQuery(board, ref)
    if (!moveCard(board, ref, toColumn)) return
    set({ board: { ...board } })
    if (q) await get().boardApi('move', { card: q, to: toColumn })
  },

  addCardTo: async (column, text, agentKey) => {
    const { board } = get()
    if (!board) return
    // UI-added cards land on TOP — newest-first is how the backlog reads.
    if (!addCard(board, column, text, { ...(agentKey ? { agentKey } : {}), position: 'top' })) return
    set({ board: { ...board } })
    const body = { text, column, ...(agentKey ? { assign: agentKey } : {}) }
    if (await get().boardApi('cards', body)) return
    // A failed ADD just rolled back the optimistic row — which was the ONLY
    // copy of what the user typed (a transient 502 ate a dictated card,
    // 2026-08-21). Retry once; if that also fails, put the text in the error
    // banner so it's at least recoverable by hand.
    await new Promise((r) => setTimeout(r, 1000))
    if (await get().boardApi('cards', body)) {
      set({ boardError: null })
      await get().loadBoard().catch(() => {})
    } else {
      set({ boardError: `${get().boardError ?? 'add failed'} — unsaved card text: "${text}"` })
    }
  },

  editCard: async (ref, text, detail) => {
    const { board } = get()
    if (!board) return
    const col = board.columns.find((c) => c.title === ref.column)
    const card = col?.cards[ref.index]
    if (!card || !text.trim()) return
    const q = cardQuery(board, ref) // BEFORE the text changes — it's the address
    card.text = text.trim()
    refreshCardLine(card)
    // Detail lines are the indented continuations under the first line.
    card.lines = [card.lines[0]!, ...detail.map((l) => l.trim()).filter(Boolean).map((l) => `  ${l}`)]
    set({ board: { ...board } })
    if (q) await get().boardApi('edit', { card: q, text: text.trim(), detail: detail.map((l) => l.trim()).filter(Boolean) })
  },

  deleteCard: async (ref) => {
    const { board } = get()
    if (!board) return
    const col = board.columns.find((c) => c.title === ref.column)
    if (!col || !col.cards[ref.index]) return
    const q = cardQuery(board, ref)
    col.cards.splice(ref.index, 1)
    for (const x of col.interstitials) {
      if (x.afterCard >= ref.index) x.afterCard = Math.max(-1, x.afterCard - 1)
    }
    set({ board: { ...board } })
    if (q) await get().boardApi('remove', { card: q })
  },

  assignCard: async (ref, agentKey) => {
    const { board } = get()
    if (!board) return
    const col = board.columns.find((c) => c.title === ref.column)
    const card = col?.cards[ref.index]
    if (!card) return
    const q = cardQuery(board, ref)
    card.agentKey = agentKey
    refreshCardLine(card)
    set({ board: { ...board } })
    if (q) await get().boardApi('assign', { card: q, agent: agentKey })
  },

  createBoard: async (slug) => {
    const path = `projects/${slug}/board.md`
    await hubFetch(`/notes/file/${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: JSON.stringify({ content: BOARD_TEMPLATE }),
      timeoutMs: 10000,
    })
    // Stamp boardPath locally so the Board tab appears immediately (the next
    // refreshSpaces re-derives it from the hub anyway).
    set((s) => ({ spaces: s.spaces.map((sp) => (sp.slug === slug ? { ...sp, boardPath: path } : sp)) }))
    if (get().activeSlug === slug) {
      set({ activeView: 'board' })
      await get().loadBoard()
    }
  },

  toggleBlocked: async (ref) => {
    const { board } = get()
    if (!board) return
    const col = board.columns.find((c) => c.title === ref.column)
    const card = col?.cards[ref.index]
    if (!card) return
    const q = cardQuery(board, ref)
    const nowBlocked = !card.blocked
    card.blocked = nowBlocked
    refreshCardLine(card)
    set({ board: { ...board } })
    if (q) await get().boardApi('block', { card: q, blocked: nowBlocked })
  },

  toggleNofork: async (ref) => {
    const { board } = get()
    if (!board) return
    const col = board.columns.find((c) => c.title === ref.column)
    const card = col?.cards[ref.index]
    if (!card) return
    const q = cardQuery(board, ref)
    const now = !card.nofork
    card.nofork = now
    refreshCardLine(card)
    set({ board: { ...board } })
    if (q) await get().boardApi('nofork', { card: q, nofork: now })
  },

  setDefaultOwner: async (slug, agentKey) => {
    if (slug.startsWith('~')) return
    try {
      await hubFetch(`/board/${encodeURIComponent(slug)}/owner`, {
        method: 'POST',
        body: JSON.stringify({ agent: agentKey }),
        timeoutMs: 10000,
      })
    } catch (e) {
      set({ boardError: (e as Error).message })
      return
    }
    await get().refreshSpaces()
    if (get().activeSlug === slug) await get().loadBoard().catch(() => {})
  },

  setCardModel: async (ref, model) => {
    const { board } = get()
    if (!board) return
    const col = board.columns.find((c) => c.title === ref.column)
    const card = col?.cards[ref.index]
    if (!card) return
    const q = cardQuery(board, ref)
    card.model = model
    refreshCardLine(card)
    set({ board: { ...board } })
    if (q) await get().boardApi('model', { card: q, model })
  },

}))

export { findCard }
