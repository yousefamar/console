// BoardWatcher — discovers kanban boards in the vault and drives dispatch.
//
// Poll-based (NoteStore.listSince), NOT fs.watch: the vault is written by
// Syncthing/Obsidian/agents from every direction, and mtime polling is the
// primitive the mobile notes sync already trusts. Every changed .md is
// re-classified (a file can become or stop being a board), then:
//   • dispatchable cards (assigned + unstamped + in a dispatch column) get a
//     ^blockid stamped INTO THE FILE and the onDispatch callback fires;
//   • stamped cards that land in review/done or turn #blocked fire onTransition;
//   • stamped cards sitting in a dispatch column too long fire onStale
//     (max twice — the board is human-visible, stale is not an error).
//
// The board file is the only durable state: a hub restart re-derives
// everything from re-reading boards (the ^id stamp marks "already
// dispatched", so nothing double-fires).

import type { NoteStore } from '../notes.js'
import { isKanbanBoard, boardDeployGate, parseBoard, serializeBoard, refreshCardLine, type BoardCard } from './board.js'
import { findDispatchable, inFlightCards, mintBlockId, type InFlightCard } from './dispatch.js'

export interface BoardDispatch {
  /** Vault-relative board path. */
  boardPath: string
  card: BoardCard
  column: string
  /** projects/<slug>/… boards carry the slug. */
  project: string | null
  /** Board frontmatter `deploy_gate: review` — see boardDeployGate(). */
  deployGate: 'review' | null
}

export interface BoardTransition extends InFlightCard {
  boardPath: string
  /** Board frontmatter `deploy_gate: review` — Done approval means "merge the
   *  branch now" on gated boards (merging deploys). */
  deployGate: 'review' | null
}

export interface BoardWatcherOpts {
  /** Wake the assignee. Return false if the agent could not be woken (the
   *  stamp stays — a wake failure is visible on the board, not retried in a
   *  loop). Return a STRING to reassign the card to that agentKey — the
   *  ticket-fork case: the fork (not the source role) now owns the card, so
   *  the stale watchdog / assignee filter / transition wake all follow IT. */
  onDispatch: (d: BoardDispatch) => boolean | string
  /** A stamped card landed in review/done or turned #blocked. */
  onTransition?: (t: BoardTransition) => void
  /** A stamped card has sat in a dispatch column past staleMs. */
  onStale?: (t: BoardTransition, nudgeCount: number) => void
  /** A board file changed on disk (any edit — agent, Obsidian, Syncthing).
   *  Fired AFTER stamp-writes so the content the client re-reads is final. */
  onBoardChanged?: (boardPath: string) => void
  log: (msg: string) => void
  pollMs?: number
  staleMs?: number
  now?: () => number
}

const DEFAULT_POLL_MS = 10_000
const DEFAULT_STALE_MS = 30 * 60_000
const MAX_NUDGES = 2

export function projectForBoardPath(path: string): string | null {
  const m = path.match(/^projects\/([^/]+)\//)
  return m ? m[1]! : null
}

export class BoardWatcher {
  /** Vault-relative paths currently classified as boards. */
  private boards = new Set<string>()
  /** blockId → last-seen state, for transition diffing. */
  private inFlight = new Map<string, BoardTransition>()
  /** blockId → dispatch/boot timestamp + nudges sent. */
  private staleTrack = new Map<string, { since: number; nudges: number }>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPoll = 0
  private scanning = false

  constructor(private store: NoteStore, private opts: BoardWatcherOpts) {}

  async start(): Promise<void> {
    const now = this.now()
    const all = await this.store.list()
    for (const f of all) {
      if (!f.path.endsWith('.md')) continue
      await this.classify(f.path, { boot: true })
    }
    this.lastPoll = now
    this.opts.log(`[boards] watching ${this.boards.size} board(s), ${this.inFlight.size} card(s) in flight`)
    this.timer = setInterval(() => { void this.poll() }, this.opts.pollMs ?? DEFAULT_POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  boardPaths(): string[] {
    return [...this.boards].sort()
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  async poll(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const since = this.lastPoll
      this.lastPoll = this.now()
      const { files, deleted } = await this.store.listSince(since)
      for (const path of deleted) this.dropBoard(path)
      for (const f of files) {
        if (!f.path.endsWith('.md')) continue
        await this.classify(f.path, { boot: false })
      }
      this.checkStale()
    } catch (e) {
      this.opts.log(`[boards] poll: ${(e as Error).message}`)
    } finally {
      this.scanning = false
    }
  }

  private dropBoard(path: string): void {
    if (!this.boards.delete(path)) return
    for (const [id, t] of this.inFlight) {
      if (t.boardPath === path) { this.inFlight.delete(id); this.staleTrack.delete(id) }
    }
  }

  /** (Re)read one file: classify as board or not, stamp+dispatch, diff transitions. */
  private async classify(path: string, { boot }: { boot: boolean }): Promise<void> {
    let content: string
    try {
      content = await this.store.read(path)
    } catch {
      this.dropBoard(path)
      return
    }
    if (!isKanbanBoard(content)) {
      this.dropBoard(path)
      return
    }
    this.boards.add(path)

    const board = parseBoard(content)
    const project = projectForBoardPath(path)

    // Stamp + dispatch new assignments (skipped on boot only in the sense
    // that boot finds none un-stamped that were stamped before — the stamp
    // is durable, so boot dispatches genuinely-new cards too, which is what
    // you want after a hub outage during which someone assigned work).
    const todo = findDispatchable(board)
    if (todo.length) {
      // DUPLICATE-FORK GUARD: a stale whole-file write (the SPA saving an old
      // in-memory copy between two of the user's drags) can wipe a fresh
      // stamp — the card comes back "unstamped" and would re-dispatch,
      // spawning a SECOND fork for the same work (observed live 2026-08-20:
      // 5 rapid card moves produced duplicate forks). If an OPEN in-flight
      // card on this board has the same text, this is stamp-LOSS, not new
      // work: restore its id + assignee and do NOT dispatch again.
      const dispatchNow: typeof todo = []
      for (const d of todo) {
        const prior = [...this.inFlight.values()].find((t) => t.boardPath === path && !t.done && t.text === d.card.text)
        if (prior) {
          d.card.blockId = prior.blockId
          if (prior.agentKey) d.card.agentKey = prior.agentKey
          refreshCardLine(d.card)
          this.opts.log(`[boards] re-stamped ^${prior.blockId} on ${path} (stale write wiped it) — no re-dispatch`)
          continue
        }
        d.card.blockId = mintBlockId()
        refreshCardLine(d.card)
        dispatchNow.push(d)
      }
      try {
        await this.store.write(path, serializeBoard(board))
      } catch (e) {
        this.opts.log(`[boards] stamp write failed for ${path}: ${(e as Error).message}`)
        return
      }
      let reassigned = false
      for (const d of dispatchNow) {
        const res = this.opts.onDispatch({ boardPath: path, card: d.card, column: d.column, project, deployGate: boardDeployGate(content) })
        // A string result = the worker is a ticket-FORK with its own @key —
        // rewrite the card's assignee so everything downstream (stale nudges,
        // transition wakes, the assignee filter) targets the fork, not the
        // source role that stayed free for conversation.
        if (typeof res === 'string' && res !== d.card.agentKey) {
          d.card.agentKey = res
          refreshCardLine(d.card)
          reassigned = true
        }
        this.opts.log(`[boards] dispatch ${path} ^${d.card.blockId} → @${d.card.agentKey}${res === false ? ' (wake FAILED)' : ''}`)
        this.staleTrack.set(d.card.blockId!, { since: this.now(), nudges: 0 })
      }
      if (reassigned) {
        try {
          await this.store.write(path, serializeBoard(board))
        } catch (e) {
          this.opts.log(`[boards] reassign write failed for ${path}: ${(e as Error).message}`)
        }
      }
    }

    // Diff in-flight state for transitions.
    const gate = boardDeployGate(content)
    for (const card of inFlightCards(board)) {
      const t: BoardTransition = { ...card, boardPath: path, deployGate: gate }
      const prev = this.inFlight.get(card.blockId)
      this.inFlight.set(card.blockId, t)
      if (card.review || card.done || card.blocked) {
        this.staleTrack.delete(card.blockId)
        const wasOpen = prev ? !prev.review && !prev.done && !prev.blocked : false
        if (!boot && wasOpen && this.opts.onTransition) this.opts.onTransition(t)
      } else if (!prev && boot) {
        // Restored in-flight card after a restart — watchdog resumes from now.
        this.staleTrack.set(card.blockId, { since: this.now(), nudges: 0 })
      }
    }

    // Tell live clients the board changed (post-stamp, so a re-read is final).
    // Boot is skipped — nothing is connected-and-stale at boot.
    if (!boot && this.opts.onBoardChanged) this.opts.onBoardChanged(path)
  }

  private checkStale(): void {
    const staleMs = this.opts.staleMs ?? DEFAULT_STALE_MS
    const now = this.now()
    for (const [id, track] of this.staleTrack) {
      if (track.nudges >= MAX_NUDGES) continue
      if (now - track.since < staleMs * (track.nudges + 1)) continue
      const t = this.inFlight.get(id)
      if (!t || t.review || t.done || t.blocked) { this.staleTrack.delete(id); continue }
      track.nudges++
      if (this.opts.onStale) this.opts.onStale(t, track.nudges)
    }
  }
}
