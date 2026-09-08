// Board operations — the SOFTWARE mutation layer over kanban boards.
//
// Agents (and the CLI) should never hand-edit board markdown: one short
// command → parse, mutate, serialize, write. Atomic against concurrent
// callers via BoardFiles' per-board-path lock — SHARED with the BoardWatcher's
// stamp/reassign/reopen writes (index.ts passes one instance to both), so a
// CLI mutation and a watcher stamp serialize instead of interleaving (the
// 2026-09-06 astera truncation). Every mutation re-reads inside the lock,
// writes atomically + conditionally on that read's mtime, is journaled first,
// and is refused if it would shrink the board suspiciously. (The SPA still
// writes whole files via /notes/file/; the watcher's duplicate-fork guard
// covers that residual race.)

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { NoteStore } from '../notes.js'
import { BoardFiles, type JournalEntry } from './board-files.js'
import { boardDefaultOwner, setBoardDefaultOwner,
  isKanbanBoard, parseBoard, serializeBoard, moveCard, addCard, refreshCardLine,
  type KanbanBoard, type BoardCard, type CardRef,
} from './board.js'
import { REVIEW_COLUMN_RE, hasSummaryBullets, handbackWarning } from './dispatch.js'

/** Assets-relative dir for card attachments. Must stay OUT of the website's
 *  `publicAssetDirs` allow-list in the vault's .eleventy.js. */
export const CARD_ASSET_DIR = 'board'

/** Detail text → indented card continuation lines. A note may span several
 *  lines (a bulleted hand-back summary); pushing it as ONE line would put a
 *  raw newline inside a card line and the next parse would read the tail as
 *  a brand-new unindented card. */
export function detailLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `  ${l}`)
}

/** Resolve a project slug to its board path (same preference order as
 *  spaces.ts listSpaces): board.md / kanban.md by name, else the first
 *  kanban-flagged file in the folder. Accepts a vault-relative .md path too. */
export async function resolveBoardPath(store: NoteStore, project: string): Promise<string | null> {
  if (project.endsWith('.md')) {
    try { return isKanbanBoard(await store.read(project)) ? project : null } catch { return null }
  }
  const all = await store.list()
  const inProject = all.filter((f) => f.path.startsWith(`projects/${project}/`) && f.path.endsWith('.md'))
  for (const name of ['board.md', 'kanban.md']) {
    const hit = inProject.find((f) => f.path === `projects/${project}/${name}`)
    if (hit) return hit.path
  }
  for (const f of inProject) {
    try { if (isKanbanBoard(await store.read(f.path))) return f.path } catch { /* skip */ }
  }
  return null
}

/** Find a card by `^blockId` or by text — exact match first, then a UNIQUE
 *  case-insensitive substring. Ambiguity is an error, not a guess. */
export function findCardByQuery(board: KanbanBoard, query: string): { ref: CardRef; card: BoardCard } | { error: string } {
  if (query.startsWith('^')) {
    const id = query.slice(1)
    for (const col of board.columns) {
      const index = col.cards.findIndex((c) => c.blockId === id)
      if (index !== -1) return { ref: { column: col.title, index }, card: col.cards[index]! }
    }
    return { error: `no card with id ^${id}` }
  }
  const q = query.toLowerCase()
  const hits: Array<{ ref: CardRef; card: BoardCard }> = []
  for (const col of board.columns) {
    col.cards.forEach((card, index) => {
      if (card.text === query) hits.unshift({ ref: { column: col.title, index }, card })
      else if (card.text.toLowerCase().includes(q)) hits.push({ ref: { column: col.title, index }, card })
    })
  }
  const exact = hits.filter((h) => h.card.text === query)
  if (exact.length === 1) return exact[0]!
  if (hits.length === 1) return hits[0]!
  if (hits.length === 0) return { error: `no card matches "${query}"` }
  return { error: `"${query}" is ambiguous — ${hits.length} cards match: ${hits.slice(0, 5).map((h) => `"${h.card.text.slice(0, 40)}"${h.card.blockId ? ` ^${h.card.blockId}` : ''}`).join(', ')}. Use the ^id.` }
}

export interface ActorRecord {
  actor: string
  ts: number
  /** Which /board/* verb wrote this (absent on records from before ^shy-boar). */
  op?: 'move' | 'assign' | 'block' | 'model' | 'nofork' | 'inherit' | 'note'
  /** Target column of a `move`. */
  column?: string
}

export interface CardView {
  text: string
  column: string
  agentKey: string | null
  blockId: string | null
  blocked: boolean
  checked: boolean
  /** `#nofork` — dispatch wakes the role directly, no per-ticket fork. */
  nofork: boolean
  /** `#inherit` — the ticket-fork inherits the parent's transcript (default: fresh context + digest). */
  inherit: boolean
  /** `#model/<alias>` — ticket-fork model pin (haiku/sonnet/opus or id). */
  model: string | null
  detail: string[]
  /** Set on a move into Under Review when the card carries no `- ` summary
   *  bullets — the CLI surfaces it to the agent at hand-back time. */
  warning?: string
}

/** The CardView of one card as it now stands (post-mutation) in `column`. */
function cardView(card: BoardCard, column: string): CardView {
  return {
    text: card.text, column, agentKey: card.agentKey, blockId: card.blockId, blocked: card.blocked, checked: card.checked,
    nofork: card.nofork, inherit: card.inherit, model: card.model,
    detail: card.lines.slice(1).map((l) => l.trim()).filter(Boolean),
  }
}

function view(board: KanbanBoard): { defaultOwner: string | null; columns: Array<{ title: string; cards: CardView[] }> } {
  return {
    // Frontmatter default_owner — clients preselect this agent on open.
    // boardDefaultOwner takes raw content; the header holds the fence.
    defaultOwner: boardDefaultOwner(board.header.join('\n')),
    columns: board.columns.map((col) => ({
      title: col.title,
      cards: col.cards.map((c) => ({
        text: c.text, column: col.title, agentKey: c.agentKey, blockId: c.blockId,
        blocked: c.blocked, checked: c.checked, nofork: c.nofork, inherit: c.inherit, model: c.model,
        detail: c.lines.slice(1).map((l) => l.trim()).filter(Boolean),
      })),
    })),
  }
}

export class BoardOps {
  /** Lock + guard + journal shared with the BoardWatcher (see board-files.ts). */
  readonly files: BoardFiles

  /** Last actor per card — `"<boardPath>#<blockId>" → {actor, ts}`. Lets
   *  notifiers (e.g. the Astera board-change guard) skip echoing an agent's
   *  OWN edit back at it — the self-echo that confused winding-down forks.
   *  Persisted so guards in other processes can read it; pruned at 500. */
  private actors: Record<string, ActorRecord> = {}
  private readonly actorFile?: string

  constructor(private store: NoteStore, actorFile?: string, files?: BoardFiles) {
    this.files = files ?? new BoardFiles(store)
    this.actorFile = actorFile
    if (actorFile && existsSync(actorFile)) {
      try { this.actors = JSON.parse(readFileSync(actorFile, 'utf-8')) } catch { this.actors = {} }
    }
  }

  /** Who last mutated a card via /board/* (undefined = unknown/file edit —
   *  the SPA's whole-file writes leave no record, so a stale entry here can
   *  predate a human drag; callers must check `op`/`column`/`ts`, never the
   *  actor alone). */
  lastActor(path: string, blockId: string): ActorRecord | undefined {
    return this.actors[`${path}#${blockId}`]
  }

  private recordActor(path: string, blockId: string | null | undefined, actor: string | undefined, meta: { op: ActorRecord['op']; column?: string }): void {
    if (!actor || !blockId || !this.actorFile) return
    this.actors[`${path}#${blockId}`] = { actor, ts: Date.now(), op: meta.op, ...(meta.column ? { column: meta.column } : {}) }
    const keys = Object.keys(this.actors)
    if (keys.length > 500) {
      for (const k of keys.sort((a, b) => this.actors[a]!.ts - this.actors[b]!.ts).slice(0, keys.length - 500)) delete this.actors[k]
    }
    try {
      const tmp = `${this.actorFile}.tmp`
      writeFileSync(tmp, JSON.stringify(this.actors))
      renameSync(tmp, this.actorFile)
    } catch { /* best effort */ }
  }

  /** Run `fn` with exclusive access to the board (fresh parse inside the lock;
   *  `fn` may run twice if the file changed under the first attempt). */
  private async mutate<T>(project: string, fn: (board: KanbanBoard, path: string) => T | Promise<T>): Promise<T> {
    const path = await resolveBoardPath(this.store, project)
    if (!path) throw new Error(`no kanban board found for "${project}"`)
    return this.files.mutate(path, async (io) => {
      const board = parseBoard((await io.read()).content)
      const result = await fn(board, path)
      await io.write(serializeBoard(board))
      return result
    })
  }

  /** Pre-write journal copies of the board, newest first (`con board <p> history`). */
  async history(project: string): Promise<{ path: string; entries: JournalEntry[] }> {
    const path = await resolveBoardPath(this.store, project)
    if (!path) throw new Error(`no kanban board found for "${project}"`)
    if (!this.files.journal) return { path, entries: [] }
    return { path, entries: await this.files.journal.list(path) }
  }

  /** HUMAN-ONLY: overwrite the board with a journal entry. The current file is
   *  journaled first (so a restore is itself reversible) and the shrink guard
   *  is bypassed — restoring is the one deliberate shrink. */
  async restore(project: string, ts: number): Promise<{ path: string; restored: number; bytes: number }> {
    const path = await resolveBoardPath(this.store, project)
    if (!path) throw new Error(`no kanban board found for "${project}"`)
    if (!this.files.journal) throw new Error('board journal is not configured on this hub')
    const content = await this.files.journal.read(path, ts).catch(() => null)
    if (content === null) throw new Error(`no journal entry ${ts} for ${path} — see \`history\``)
    return this.files.locked(path, async (io) => {
      await io.read()
      await io.write(content, { allowShrink: true })
      return { path, restored: ts, bytes: Buffer.byteLength(content) }
    })
  }

  async show(project: string): Promise<{ path: string } & ReturnType<typeof view>> {
    const path = await resolveBoardPath(this.store, project)
    if (!path) throw new Error(`no kanban board found for "${project}"`)
    const board = parseBoard(await this.store.read(path))
    return { path, ...view(board) }
  }

  /** Read-only card lookup (same ^id/unique-substring addressing as the
   *  mutations) — vault-relative board path + the card's stamp, if any. */
  async resolveCard(project: string, query: string): Promise<{ path: string; blockId: string | null; text: string }> {
    const path = await resolveBoardPath(this.store, project)
    if (!path) throw new Error(`no kanban board found for "${project}"`)
    const board = parseBoard(await this.store.read(path))
    const hit = findCardByQuery(board, query)
    if ('error' in hit) throw new Error(hit.error)
    return { path, blockId: hit.card.blockId, text: hit.card.text }
  }

  add(project: string, text: string, opts: { column?: string; agentKey?: string; detail?: string[]; top?: boolean }): Promise<CardView> {
    return this.mutate(project, (board, path) => {
      const column = opts.column ?? board.columns[0]?.title
      if (!column) throw new Error('board has no columns')
      const card = addCard(board, column, text, {
        ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
        position: opts.top === false ? 'bottom' : 'top',
      })
      if (!card) throw new Error(`no column "${column}" on this board`)
      if (opts.detail?.length) card.lines.push(...opts.detail.flatMap(detailLines))
      return { text: card.text, column, agentKey: card.agentKey, blockId: card.blockId, blocked: card.blocked, checked: card.checked, nofork: card.nofork, inherit: card.inherit, model: card.model, detail: opts.detail ?? [] }
    })
  }

  move(project: string, query: string, toColumn: string, actor?: string): Promise<CardView> {
    return this.mutate(project, (board, path) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      // Column matched case-insensitively — "done" means "## Done".
      const target = board.columns.find((c) => c.title.toLowerCase() === toColumn.toLowerCase())
      if (!target) throw new Error(`no column "${toColumn}" (have: ${board.columns.map((c) => c.title).join(', ')})`)
      if (!moveCard(board, hit.ref, target.title)) throw new Error('move failed')
      const card = target.cards[target.cards.length - 1]!
      this.recordActor(path, card.blockId, actor, { op: 'move', column: target.title })
      const detail = card.lines.slice(1).map((l) => l.trim()).filter(Boolean)
      const warning = REVIEW_COLUMN_RE.test(target.title) && !hasSummaryBullets(detail) ? handbackWarning(project, card.blockId) : undefined
      return { text: card.text, column: target.title, agentKey: card.agentKey, blockId: card.blockId, blocked: card.blocked, checked: card.checked, nofork: card.nofork, inherit: card.inherit, model: card.model, detail, ...(warning ? { warning } : {}) }
    })
  }

  assign(project: string, query: string, agentKey: string | null, actor?: string): Promise<CardView> {
    return this.mutate(project, (board, path) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      hit.card.agentKey = agentKey
      refreshCardLine(hit.card)
      this.recordActor(path, hit.card.blockId, actor, { op: 'assign' })
      return cardView(hit.card, hit.ref.column)
    })
  }

  setBlocked(project: string, query: string, blocked: boolean, note?: string, actor?: string): Promise<CardView> {
    return this.mutate(project, (board, path) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      hit.card.blocked = blocked
      refreshCardLine(hit.card)
      if (blocked && note?.trim()) hit.card.lines.push(...detailLines(note))
      this.recordActor(path, hit.card.blockId, actor, { op: 'block' })
      return cardView(hit.card, hit.ref.column)
    })
  }

  setModel(project: string, query: string, model: string | null, actor?: string): Promise<CardView> {
    return this.mutate(project, (board, path) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      hit.card.model = model
      refreshCardLine(hit.card)
      this.recordActor(path, hit.card.blockId, actor, { op: 'model' })
      return cardView(hit.card, hit.ref.column)
    })
  }

  setNofork(project: string, query: string, nofork: boolean, actor?: string): Promise<CardView> {
    return this.mutate(project, (board, path) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      hit.card.nofork = nofork
      refreshCardLine(hit.card)
      this.recordActor(path, hit.card.blockId, actor, { op: 'nofork' })
      return cardView(hit.card, hit.ref.column)
    })
  }

  /** `#inherit` on/off — whether this card's ticket-fork inherits the parent's transcript. */
  setInherit(project: string, query: string, inherit: boolean, actor?: string): Promise<CardView> {
    return this.mutate(project, (board, path) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      hit.card.inherit = inherit
      refreshCardLine(hit.card)
      this.recordActor(path, hit.card.blockId, actor, { op: 'inherit' })
      return cardView(hit.card, hit.ref.column)
    })
  }

  /** Board-level: set/clear the frontmatter `default_owner:` — the agent that
   *  unassigned cards dragged into In Progress auto-assign to. */
  setDefaultOwner(project: string, agentKey: string | null): Promise<{ path: string; defaultOwner: string | null }> {
    return this.mutate(project, (board, path) => {
      setBoardDefaultOwner(board, agentKey)
      return { path, defaultOwner: boardDefaultOwner(board.header.join('\n')) }
    })
  }

  note(project: string, query: string, note: string, actor?: string): Promise<CardView> {
    return this.mutate(project, (board, path) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      hit.card.lines.push(...detailLines(note))
      this.recordActor(path, hit.card.blockId, actor, { op: 'note' })
      return cardView(hit.card, hit.ref.column)
    })
  }

  /** Attach an image (a hand-back screenshot) to a card: the bytes land in
   *  the vault's sibling assets dir under `board/` (same convention as the
   *  SPA's paste-upload), and the card gains a `![caption](board/…)` detail
   *  line — rendered as a thumbnail by the board UI and delivered as a real
   *  image attachment on any later dispatch of the card.
   *
   *  `board/` and NOT `images/`: the website publishes assets/ by a dir
   *  allow-list, so an unlisted dir is private by construction. Card
   *  screenshots written into images/ went live on yousefamar.com (opsec rem
   *  #65, 2026-09-04); the site now also excludes `images/card-*` by name,
   *  but a dir nobody lists is the survivable location. */
  async attach(project: string, query: string, image: { data: Buffer; ext: string; caption?: string }, actor?: string): Promise<CardView & { asset: string }> {
    const ext = image.ext.replace(/^\./, '').toLowerCase().replace('jpeg', 'jpg')
    if (!/^(png|jpg|gif|webp)$/.test(ext)) throw new Error(`unsupported image type "${image.ext}" (png/jpg/gif/webp)`)
    // Resolve first so a bad card query doesn't leave an orphan asset behind.
    const hit = await this.resolveCard(project, query)
    const asset = `${CARD_ASSET_DIR}/card-${Date.now()}-${hit.blockId ?? 'card'}.${ext}`
    await this.store.writeAsset(asset, image.data)
    const caption = image.caption?.trim().replace(/[\[\]]/g, '') || 'screenshot'
    const view = await this.note(project, query, `![${caption}](${asset})`, actor)
    return { ...view, asset }
  }

  edit(project: string, query: string, updates: { text?: string; detail?: string[] }): Promise<CardView> {
    return this.mutate(project, (board) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      if (updates.text?.trim()) {
        hit.card.text = updates.text.trim()
        refreshCardLine(hit.card)
      }
      if (updates.detail) {
        hit.card.lines = [hit.card.lines[0]!, ...updates.detail.flatMap(detailLines)]
      }
      return cardView(hit.card, hit.ref.column)
    })
  }

  remove(project: string, query: string): Promise<{ removed: string }> {
    return this.mutate(project, (board) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      const col = board.columns.find((c) => c.title === hit.ref.column)!
      col.cards.splice(hit.ref.index, 1)
      for (const x of col.interstitials) {
        if (x.afterCard >= hit.ref.index) x.afterCard = Math.max(-1, x.afterCard - 1)
      }
      return { removed: hit.card.text }
    })
  }
}
