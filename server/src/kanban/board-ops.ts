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
  isKanbanBoard, parseBoard, serializeBoard, moveCard, addCard, refreshCardLine, metaKey, metaValue, CREATED_BY,
  type KanbanBoard, type BoardCard, type CardRef,
} from './board.js'
import { boardRemote } from '../forge/config.js'
import { REVIEW_COLUMN_RE, hasSummaryBullets, handbackWarning } from './dispatch.js'

/** Assets-relative dir for card attachments. Must stay OUT of the website's
 *  `publicAssetDirs` allow-list in the vault's .eleventy.js. */
export const CARD_ASSET_DIR = 'board'

/** Attachment types `attach` accepts, by normalised extension. Videos are
 *  Playwright's webm and ffmpeg's mp4 — what hand-back clips actually are. */
export const ATTACH_IMAGE_EXTS = ['png', 'jpg', 'gif', 'webp'] as const
export const ATTACH_VIDEO_EXTS = ['webm', 'mp4'] as const
/** Same ceiling as the transcript media bridge (agents/local-file.ts). */
export const MAX_ATTACH_BYTES = 20 * 1024 * 1024

/** Detail text → indented card continuation lines. A note may span several
 *  lines (a bulleted hand-back summary); pushing it as ONE line would put a
 *  raw newline inside a card line and the next parse would read the tail as
 *  a brand-new unindented card. */
export function detailLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `  ${l}`)
}

/** Card text may arrive with newlines — a card dictated on the phone with a
 *  paragraph break (^loud-pony). The first non-blank line is the card, every
 *  later non-blank line is a detail line; blank lines collapse. Written raw,
 *  the tail became a bare unindented line the next parse read as a new card. */
export function splitHeadAndDetail(text: string): { head: string; detail: string[] } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return { head: lines[0] ?? '', detail: lines.slice(1) }
}

/** Resolve a project slug to its board path (same preference order as
 *  spaces.ts listSpaces): board.md / kanban.md by name, else the first
 *  kanban-flagged file in the folder. Accepts a vault-relative .md path too.
 *
 *  Reads the two conventional names directly — every /board/* request runs
 *  this, and the old `store.list()` walked and stat-ed the whole vault
 *  (~2,500 files, 0.3–0.6 s idle, far worse under fork start-up disk load)
 *  to answer a question one open() settles. The vault walk is now only the
 *  fallback for boards with an unconventional filename. */
export async function resolveBoardPath(store: NoteStore, project: string): Promise<string | null> {
  if (project.endsWith('.md')) {
    try { return isKanbanBoard(await store.read(project)) ? project : null } catch { return null }
  }
  for (const name of ['board.md', 'kanban.md']) {
    const path = `projects/${project}/${name}`
    try { await store.read(path); return path } catch { /* not there */ }
  }
  const all = await store.list()
  const inProject = all.filter((f) => f.path.startsWith(`projects/${project}/`) && f.path.endsWith('.md'))
  for (const f of inProject) {
    try { if (isKanbanBoard(await store.read(f.path))) return f.path } catch { /* skip */ }
  }
  return null
}

/** The `^id` grammar mintBlockId produces: `<adjective>-<noun>`, words ≤6
 *  letters, with a numeric suffix after a collision. */
const ID_SHAPED = /^[a-z]{2,6}-[a-z]{2,6}(?:-\d+)?$/

function textHits(board: KanbanBoard, query: string): Array<{ ref: CardRef; card: BoardCard }> {
  const q = query.toLowerCase()
  const hits: Array<{ ref: CardRef; card: BoardCard }> = []
  for (const col of board.columns) {
    col.cards.forEach((card, index) => {
      if (card.text.toLowerCase().includes(q)) hits.push({ ref: { column: col.title, index }, card })
    })
  }
  return hits
}

const describeCard = (h: { card: BoardCard }): string =>
  `"${h.card.text.slice(0, 40)}"${h.card.blockId ? ` ^${h.card.blockId}` : ''}`

/** Find a card by `^blockId` or by text.
 *
 *  An ID ALWAYS WINS, with or without the caret, and an id-SHAPED argument
 *  that matches no id is an error rather than a text search: on 2026-10-07 an
 *  astera fork ran `note glad-wolf` and the hub appended its whole hand-back
 *  to ^brisk-boar — a DIFFERENT card, whose own text reads "CONTINUE
 *  ^glad-wolf after the fleet kill" — and answered `success: true`. The real
 *  ^glad-wolf never matched by text at all, because the parser strips the
 *  stamp out of `card.text`, so the mention was the only hit and a unique hit
 *  used to be taken as the answer.
 *
 *  Text addressing (for everything that is not id-shaped) is an exact match
 *  first, then a UNIQUE case-insensitive substring. Ambiguity is an error,
 *  never a guess. */
export function findCardByQuery(board: KanbanBoard, query: string): { ref: CardRef; card: BoardCard; matched: 'id' | 'text' } | { error: string } {
  const bare = query.startsWith('^') ? query.slice(1) : query
  const id = bare.toLowerCase()
  for (const col of board.columns) {
    const index = col.cards.findIndex((c) => c.blockId?.toLowerCase() === id)
    if (index !== -1) return { ref: { column: col.title, index }, card: col.cards[index]!, matched: 'id' }
  }
  if (query.startsWith('^') || ID_SHAPED.test(id)) {
    const mentions = textHits(board, bare)
    const also = mentions.length
      ? ` ${mentions.length} card(s) MENTION it in their own text, which is not the same card: ${mentions.slice(0, 5).map(describeCard).join(', ')} — address one of those by its OWN ^id.`
      : ''
    return { error: `no card with id ^${bare} on this board.${also} (An id-shaped argument is never text-matched; to search card text, pass a longer phrase.)` }
  }
  const hits = textHits(board, query)
  const exact = hits.filter((h) => h.card.text === query)
  if (exact.length === 1) return { ...exact[0]!, matched: 'text' }
  if (hits.length === 1) return { ...hits[0]!, matched: 'text' }
  if (hits.length === 0) return { error: `no card matches "${query}"` }
  return { error: `"${query}" is ambiguous — ${hits.length} cards match: ${hits.slice(0, 5).map(describeCard).join(', ')}. Use the ^id.` }
}

/** A write that landed on a card addressed by TEXT names what it hit, so a
 *  caller that meant an id sees its mistake in the response (see the
 *  ^glad-wolf/^brisk-boar note above). */
function textMatchWarning(card: BoardCard, undoHint = false): string {
  const target = card.blockId ? `^${card.blockId}` : 'an unstamped card'
  return `resolved by TEXT, not by id: this wrote to ${target} "${card.text.slice(0, 60)}". If you meant a card id, pass "^id".${undoHint ? ` \`note "${target}" --undo\` takes the note back.` : ''}`
}

export interface ActorRecord {
  actor: string
  ts: number
  /** Which /board/* verb wrote this (absent on records from before ^shy-boar). */
  op?: 'move' | 'assign' | 'block' | 'model' | 'effort' | 'nofork' | 'inherit' | 'remote' | 'note' | 'tag'
  /** Target column of a `move`. */
  column?: string
  /** How many detail lines the last `note` appended — what `note --undo`
   *  removes. 0 once undone, so a second undo cannot eat the note before it. */
  noteLines?: number
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
  /** `#model/<alias>` (or bare `#haiku`/`#sonnet`/`#opus`/`#fable`) — ticket-fork model pin. */
  model: string | null
  /** `#effort/<level>` — ticket-fork `--effort` pin. */
  effort: string | null
  /** `#forge` / `#local` — where this card's ticket-fork runs. null = the
   *  board's `remote:` frontmatter decides, and its absence means local. */
  remote: 'forge' | 'local' | null
  /** `#key/value` metadata tags — `created-by` on every card the hub created,
   *  plus whatever else was tagged (`requested-by`, …). */
  meta: Record<string, string>
  detail: string[]
  /** Something the write got away with but the caller should see: a move into
   *  Under Review with no `- ` summary bullets, or a card addressed by text
   *  rather than by `^id`. The CLI surfaces it to the agent. */
  warning?: string
}

/** The CardView of one card as it now stands (post-mutation) in `column`. */
function cardView(card: BoardCard, column: string): CardView {
  return {
    text: card.text, column, agentKey: card.agentKey, blockId: card.blockId, blocked: card.blocked, checked: card.checked,
    nofork: card.nofork, inherit: card.inherit, model: card.model, effort: card.effort, remote: card.remote, meta: card.meta,
    detail: card.lines.slice(1).map((l) => l.trim()).filter(Boolean),
  }
}

function view(board: KanbanBoard): { defaultOwner: string | null; remote: 'forge' | 'local' | null; columns: Array<{ title: string; cards: CardView[] }> } {
  return {
    // Frontmatter default_owner — clients preselect this agent on open.
    // boardDefaultOwner takes raw content; the header holds the fence.
    defaultOwner: boardDefaultOwner(board.header.join('\n')),
    // Frontmatter `remote:` — what an untagged card follows (the APK's
    // placement pill labels its default from this).
    remote: boardRemote(board.header.join('\n')),
    columns: board.columns.map((col) => ({
      title: col.title,
      cards: col.cards.map((c) => cardView(c, col.title)),
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

  private recordActor(path: string, blockId: string | null | undefined, actor: string | undefined, meta: { op: ActorRecord['op']; column?: string; noteLines?: number }): void {
    if (!actor || !blockId || !this.actorFile) return
    this.actors[`${path}#${blockId}`] = {
      actor, ts: Date.now(), op: meta.op,
      ...(meta.column ? { column: meta.column } : {}),
      ...(meta.noteLines === undefined ? {} : { noteLines: meta.noteLines }),
    }
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

  /** `createdBy` is mandatory: who or what made the card (`ui`, `ring`, an
   *  agent key). Nothing reaches a board through the hub unattributed. */
  add(project: string, text: string, opts: { createdBy: string; meta?: Record<string, string>; column?: string; agentKey?: string; detail?: string[]; top?: boolean }): Promise<CardView> {
    if (!opts.createdBy?.trim()) return Promise.reject(new Error('a card needs a creator: pass createdBy (CLI: --by <your name>)'))
    return this.mutate(project, (board) => {
      const column = opts.column ?? board.columns[0]?.title
      if (!column) throw new Error('board has no columns')
      const { head, detail: tail } = splitHeadAndDetail(text)
      const card = addCard(board, column, head, {
        createdBy: opts.createdBy,
        ...(opts.meta ? { meta: opts.meta } : {}),
        ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
        position: opts.top === false ? 'bottom' : 'top',
      })
      if (!card) throw new Error(`no column "${column}" on this board`)
      const detail = [...tail, ...(opts.detail ?? [])]
      if (detail.length) card.lines.push(...detail.flatMap(detailLines))
      return cardView(card, column)
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
      return { ...cardView(card, target.title), ...(warning ? { warning } : {}) }
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

  setEffort(project: string, query: string, effort: string | null, actor?: string): Promise<CardView> {
    return this.mutate(project, (board, path) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      hit.card.effort = effort
      refreshCardLine(hit.card)
      this.recordActor(path, hit.card.blockId, actor, { op: 'effort' })
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

  /** `#forge` / `#local` / clear — WHERE this card's ticket-fork runs.
   *  `local` is the per-card opt-OUT for a board that opted in with
   *  `remote: forge`; `forge` opts one card in on a board that did not; null
   *  clears the tag and defers to the board. */
  setRemote(project: string, query: string, remote: 'forge' | 'local' | null, actor?: string): Promise<CardView> {
    return this.mutate(project, (board, path) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      hit.card.remote = remote
      refreshCardLine(hit.card)
      this.recordActor(path, hit.card.blockId, actor, { op: 'remote' })
      return cardView(hit.card, hit.ref.column)
    })
  }

  /** Set (`value`) or clear (`null`) one `#key/value` metadata tag. `created-by`
   *  is written once: it can be filled in on a card that has none (one made
   *  before the tag existed, or by a hand edit) and never changed or removed. */
  setMeta(project: string, query: string, rawKey: string, value: string | null, actor?: string): Promise<CardView> {
    return this.mutate(project, (board, path) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      const key = metaKey(rawKey)
      if (key === CREATED_BY && hit.card.meta[key]) throw new Error(`${CREATED_BY} is set when the card is made and cannot be changed (it says "${hit.card.meta[key]}")`)
      if (value === null) delete hit.card.meta[key]
      else hit.card.meta[key] = metaValue(value)
      refreshCardLine(hit.card)
      this.recordActor(path, hit.card.blockId, actor, { op: 'tag' })
      const warning = hit.matched === 'text' ? textMatchWarning(hit.card) : undefined
      return { ...cardView(hit.card, hit.ref.column), ...(warning ? { warning } : {}) }
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
      const added = detailLines(note)
      hit.card.lines.push(...added)
      this.recordActor(path, hit.card.blockId, actor, { op: 'note', noteLines: added.length })
      const warning = hit.matched === 'text' ? textMatchWarning(hit.card, true) : undefined
      return { ...cardView(hit.card, hit.ref.column), ...(warning ? { warning } : {}) }
    })
  }

  /** Take a note back off a card — the repair path for one that landed on the
   *  wrong card (before ^glad-wolf there was none, so repairing it meant
   *  re-passing every surviving bullet through `edit --detail`, by hand).
   *  `count` is explicit (`--remove-last N`) or, with none, the line count of
   *  the last note this hub recorded for the card (`--undo`). An attachment's
   *  bytes stay in assets/; only its detail line goes. */
  unnote(project: string, query: string, opts: { count?: number }, actor?: string): Promise<CardView & { removed: string[] }> {
    return this.mutate(project, (board, path) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      const card = hit.card
      const where = card.blockId ? `^${card.blockId}` : `"${card.text.slice(0, 40)}"`
      const detail = card.lines.length - 1
      const record = card.blockId ? this.actors[`${path}#${card.blockId}`] : undefined
      const recorded = record?.op === 'note' ? record.noteLines : undefined
      const count = opts.count ?? recorded
      if (count === undefined) {
        throw new Error(`nothing recorded to undo on ${where}: this hub has no note of its own to take back (a hub restart, a direct file edit or the SPA clears that). Pass --remove-last <n> — the card has ${detail} detail line(s); \`con board ${project} show --json\` lists them.`)
      }
      if (count <= 0) throw new Error(`nothing to undo on ${where}: its last note was already taken back. Pass --remove-last <n> to drop more.`)
      if (count > detail) throw new Error(`cannot remove ${count} line(s) from ${where}: it has ${detail}`)
      const removed = card.lines.splice(card.lines.length - count, count).map((l) => l.trim())
      this.recordActor(path, card.blockId, actor, { op: 'note', noteLines: 0 })
      return { ...cardView(card, hit.ref.column), removed }
    })
  }

  /** Attach a hand-back screenshot or clip to a card: the bytes land in the
   *  vault's sibling assets dir under `board/` (same convention as the SPA's
   *  paste-upload), and the card gains a `![caption](board/…)` detail line —
   *  rendered as a thumbnail (images) or a playable tile (webm/mp4) by the
   *  board UI. Images are also delivered as real image attachments on any
   *  later dispatch of the card; clips can't be (no video input), so the
   *  envelope names their path instead.
   *
   *  `board/` and NOT `images/`: the website publishes assets/ by a dir
   *  allow-list, so an unlisted dir is private by construction. Card
   *  screenshots written into images/ went live on yousefamar.com (opsec rem
   *  #65, 2026-09-04); the site now also excludes `images/card-*` by name,
   *  but a dir nobody lists is the survivable location. */
  async attach(project: string, query: string, image: { data: Buffer; ext: string; caption?: string }, actor?: string): Promise<CardView & { asset: string }> {
    const ext = image.ext.replace(/^\./, '').toLowerCase().replace('jpeg', 'jpg')
    const isVideo = (ATTACH_VIDEO_EXTS as readonly string[]).includes(ext)
    if (!isVideo && !(ATTACH_IMAGE_EXTS as readonly string[]).includes(ext)) {
      throw new Error(`unsupported attachment type "${image.ext}" (${ATTACH_IMAGE_EXTS.join('/')} images, ${ATTACH_VIDEO_EXTS.join('/')} clips)`)
    }
    if (image.data.length > MAX_ATTACH_BYTES) {
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1)
      throw new Error(`attachment too large: ${mb(image.data.length)} MB (cap ${mb(MAX_ATTACH_BYTES)} MB)${isVideo ? ' — trim or compress the clip' : ''}`)
    }
    // Resolve first so a bad card query doesn't leave an orphan asset behind.
    const hit = await this.resolveCard(project, query)
    const asset = `${CARD_ASSET_DIR}/card-${Date.now()}-${hit.blockId ?? 'card'}.${ext}`
    await this.store.writeAsset(asset, image.data)
    const caption = image.caption?.trim().replace(/[\[\]]/g, '') || (isVideo ? 'clip' : 'screenshot')
    const view = await this.note(project, query, `![${caption}](${asset})`, actor)
    return { ...view, asset }
  }

  edit(project: string, query: string, updates: { text?: string; detail?: string[] }): Promise<CardView> {
    return this.mutate(project, (board) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      const { head, detail: tail } = splitHeadAndDetail(updates.text ?? '')
      if (head) {
        hit.card.text = head
        refreshCardLine(hit.card)
      }
      if (updates.detail) {
        hit.card.lines = [hit.card.lines[0]!, ...[...tail, ...updates.detail].flatMap(detailLines)]
      } else if (tail.length) {
        hit.card.lines.push(...tail.flatMap(detailLines))
      }
      const warning = hit.matched === 'text' ? textMatchWarning(hit.card) : undefined
      return { ...cardView(hit.card, hit.ref.column), ...(warning ? { warning } : {}) }
    })
  }

  remove(project: string, query: string): Promise<{ removed: string; warning?: string }> {
    return this.mutate(project, (board) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      const col = board.columns.find((c) => c.title === hit.ref.column)!
      col.cards.splice(hit.ref.index, 1)
      for (const x of col.interstitials) {
        if (x.afterCard >= hit.ref.index) x.afterCard = Math.max(-1, x.afterCard - 1)
      }
      const warning = hit.matched === 'text' ? textMatchWarning(hit.card) : undefined
      return { removed: hit.card.text, ...(warning ? { warning } : {}) }
    })
  }
}
