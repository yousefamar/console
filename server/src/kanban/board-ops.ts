// Board operations — the SOFTWARE mutation layer over kanban boards.
//
// Agents (and the CLI) should never hand-edit board markdown: one short
// command → parse, mutate, serialize, write. Atomic against concurrent
// callers via a per-board-path promise queue — every mutation re-reads the
// file inside the lock, so two agents moving cards "at the same time" get
// serialized read-modify-write cycles, never lost updates. (The SPA still
// writes whole files via /notes/file/; the watcher's duplicate-fork guard
// covers that residual race.)

import type { NoteStore } from '../notes.js'
import {
  isKanbanBoard, parseBoard, serializeBoard, moveCard, addCard, refreshCardLine,
  type KanbanBoard, type BoardCard, type CardRef,
} from './board.js'

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

export interface CardView {
  text: string
  column: string
  agentKey: string | null
  blockId: string | null
  blocked: boolean
  checked: boolean
  detail: string[]
}

function view(board: KanbanBoard): { columns: Array<{ title: string; cards: CardView[] }> } {
  return {
    columns: board.columns.map((col) => ({
      title: col.title,
      cards: col.cards.map((c) => ({
        text: c.text, column: col.title, agentKey: c.agentKey, blockId: c.blockId,
        blocked: c.blocked, checked: c.checked,
        detail: c.lines.slice(1).map((l) => l.trim()).filter(Boolean),
      })),
    })),
  }
}

export class BoardOps {
  /** Per-board-path write queue — mutations on the same board serialize. */
  private locks = new Map<string, Promise<unknown>>()

  constructor(private store: NoteStore) {}

  /** Run `fn` with exclusive access to the board (fresh parse inside the lock). */
  private async mutate<T>(project: string, fn: (board: KanbanBoard, path: string) => T | Promise<T>): Promise<T> {
    const path = await resolveBoardPath(this.store, project)
    if (!path) throw new Error(`no kanban board found for "${project}"`)
    const prev = this.locks.get(path) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(async () => {
      const board = parseBoard(await this.store.read(path))
      const result = await fn(board, path)
      await this.store.write(path, serializeBoard(board))
      return result
    })
    this.locks.set(path, run)
    return run
  }

  async show(project: string): Promise<{ path: string; columns: Array<{ title: string; cards: CardView[] }> }> {
    const path = await resolveBoardPath(this.store, project)
    if (!path) throw new Error(`no kanban board found for "${project}"`)
    const board = parseBoard(await this.store.read(path))
    return { path, ...view(board) }
  }

  add(project: string, text: string, opts: { column?: string; agentKey?: string; detail?: string[]; top?: boolean }): Promise<CardView> {
    return this.mutate(project, (board) => {
      const column = opts.column ?? board.columns[0]?.title
      if (!column) throw new Error('board has no columns')
      const card = addCard(board, column, text, {
        ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
        position: opts.top === false ? 'bottom' : 'top',
      })
      if (!card) throw new Error(`no column "${column}" on this board`)
      if (opts.detail?.length) card.lines.push(...opts.detail.map((l) => `  ${l.trim()}`))
      return { text: card.text, column, agentKey: card.agentKey, blockId: card.blockId, blocked: card.blocked, checked: card.checked, detail: opts.detail ?? [] }
    })
  }

  move(project: string, query: string, toColumn: string): Promise<CardView> {
    return this.mutate(project, (board) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      // Column matched case-insensitively — "done" means "## Done".
      const target = board.columns.find((c) => c.title.toLowerCase() === toColumn.toLowerCase())
      if (!target) throw new Error(`no column "${toColumn}" (have: ${board.columns.map((c) => c.title).join(', ')})`)
      if (!moveCard(board, hit.ref, target.title)) throw new Error('move failed')
      const card = target.cards[target.cards.length - 1]!
      return { text: card.text, column: target.title, agentKey: card.agentKey, blockId: card.blockId, blocked: card.blocked, checked: card.checked, detail: card.lines.slice(1).map((l) => l.trim()).filter(Boolean) }
    })
  }

  assign(project: string, query: string, agentKey: string | null): Promise<CardView> {
    return this.mutate(project, (board) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      hit.card.agentKey = agentKey
      refreshCardLine(hit.card)
      return { text: hit.card.text, column: hit.ref.column, agentKey, blockId: hit.card.blockId, blocked: hit.card.blocked, checked: hit.card.checked, detail: hit.card.lines.slice(1).map((l) => l.trim()).filter(Boolean) }
    })
  }

  setBlocked(project: string, query: string, blocked: boolean, note?: string): Promise<CardView> {
    return this.mutate(project, (board) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      hit.card.blocked = blocked
      refreshCardLine(hit.card)
      if (blocked && note?.trim()) hit.card.lines.push(`  ${note.trim()}`)
      return { text: hit.card.text, column: hit.ref.column, agentKey: hit.card.agentKey, blockId: hit.card.blockId, blocked, checked: hit.card.checked, detail: hit.card.lines.slice(1).map((l) => l.trim()).filter(Boolean) }
    })
  }

  setNofork(project: string, query: string, nofork: boolean): Promise<CardView> {
    return this.mutate(project, (board) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      hit.card.nofork = nofork
      refreshCardLine(hit.card)
      return { text: hit.card.text, column: hit.ref.column, agentKey: hit.card.agentKey, blockId: hit.card.blockId, blocked: hit.card.blocked, checked: hit.card.checked, detail: hit.card.lines.slice(1).map((l) => l.trim()).filter(Boolean) }
    })
  }

  note(project: string, query: string, note: string): Promise<CardView> {
    return this.mutate(project, (board) => {
      const hit = findCardByQuery(board, query)
      if ('error' in hit) throw new Error(hit.error)
      hit.card.lines.push(`  ${note.trim()}`)
      return { text: hit.card.text, column: hit.ref.column, agentKey: hit.card.agentKey, blockId: hit.card.blockId, blocked: hit.card.blocked, checked: hit.card.checked, detail: hit.card.lines.slice(1).map((l) => l.trim()).filter(Boolean) }
    })
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
        hit.card.lines = [hit.card.lines[0]!, ...updates.detail.map((l) => l.trim()).filter(Boolean).map((l) => `  ${l}`)]
      }
      return { text: hit.card.text, column: hit.ref.column, agentKey: hit.card.agentKey, blockId: hit.card.blockId, blocked: hit.card.blocked, checked: hit.card.checked, detail: hit.card.lines.slice(1).map((l) => l.trim()).filter(Boolean) }
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
