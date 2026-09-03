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
import { isKanbanBoard, boardDeployGate, boardDefaultOwner, parseBoard, serializeBoard, refreshCardLine, findCardByBlockId, getCard, type BoardCard, type KanbanBoard } from './board.js'
import { findDispatchable, inFlightCards, mintBlockId, DISPATCH_COLUMN_RE, type InFlightCard, type ReviewCardRef } from './dispatch.js'

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
  /** Board frontmatter `default_owner:` — the reopen re-dispatch fallback
   *  when the card's assignee is dead and no source role is derivable. */
  defaultOwner: string | null
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
  /** A stamped card moved BACK to a dispatch column from review/done/blocked
   *  (Yousef bouncing work, or a human rescuing a card whose fork died) — the
   *  ^id stamp means findDispatchable never re-fires, so without this the
   *  move does nothing (astera ^dry-wolf, stranded forever). Wake the
   *  assignee if live; if its session is gone, re-dispatch (return a string
   *  to reassign the card to the new worker's key, exactly like onDispatch). */
  onReopen?: (t: BoardTransition) => boolean | string
  /** A stamped card has sat in a dispatch column past staleMs. */
  onStale?: (t: BoardTransition, nudgeCount: number) => void
  /** An OPEN in-flight card's CONTENT changed (text/detail edits, not column
   *  moves) — instructions get added after dispatch, and the working session
   *  won't re-read its card unprompted. Not fired on boot or transitions. */
  onCardEdited?: (t: BoardTransition) => void
  /** A board file changed on disk (any edit — agent, Obsidian, Syncthing).
   *  Fired AFTER stamp-writes so the content the client re-reads is final. */
  onBoardChanged?: (boardPath: string) => void
  /** ANY vault .md changed on disk since the last poll (board or not). This
   *  poll is the vault's only change feed, so it doubles as the signal for
   *  "a file changed under an open doc editor" — writes the agent_edit
   *  broadcast can't see (Bash, `con notes write`, other devices). Not fired
   *  at boot. */
  onFileChanged?: (path: string, mtime: number) => void
  /** Resolve the default owner for UNASSIGNED cards dragged into a dispatch
   *  column (frontmatter `default_owner:` wins before this is consulted).
   *  Null = leave the card unassigned and undispatched. */
  resolveOwner?: (project: string | null, boardPath: string) => string | null
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

  /** Cards this agent owns that sit in Under Review (not Done) — the set a
   *  human message should carry a "feedback re-opens the card" reminder for. */
  reviewCardsFor(agentKey: string): ReviewCardRef[] {
    const out: ReviewCardRef[] = []
    for (const t of this.inFlight.values()) {
      if (t.agentKey === agentKey && t.review && !t.done) {
        out.push({ blockId: t.blockId, text: t.text, boardPath: t.boardPath, project: projectForBoardPath(t.boardPath) })
      }
    }
    return out
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
        this.opts.onFileChanged?.(f.path, f.mtime)
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
      const fmOwner = boardDefaultOwner(content)
      // Word-pair ids collide far sooner than 36^6 — take everything in
      // flight PLUS ids minted earlier in this very loop.
      const taken = new Set(this.inFlight.keys())
      for (const d of todo) {
        // Unassigned card in a dispatch column → the project's default owner
        // ("* general" convention / frontmatter default_owner). Unresolvable
        // → leave it be (unstamped, unassigned): stamping would mark it
        // dispatched-to-nobody.
        if (!d.card.agentKey) {
          const owner = fmOwner ?? this.opts.resolveOwner?.(project, path) ?? null
          if (!owner) continue
          d.card.agentKey = owner
          this.opts.log(`[boards] auto-assigned "${d.card.text.slice(0, 40)}" → @${owner} (default owner, ${path})`)
        }
        const prior = [...this.inFlight.values()].find((t) => t.boardPath === path && !t.done && t.text === d.card.text)
        if (prior) {
          d.card.blockId = prior.blockId
          if (prior.agentKey) d.card.agentKey = prior.agentKey
          refreshCardLine(d.card)
          this.opts.log(`[boards] re-stamped ^${prior.blockId} on ${path} (stale write wiped it) — no re-dispatch`)
          continue
        }
        d.card.blockId = mintBlockId({ taken })
        taken.add(d.card.blockId)
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
    const fmOwner2 = boardDefaultOwner(content)
    const reopened: BoardTransition[] = []
    for (const card of inFlightCards(board)) {
      const t: BoardTransition = { ...card, boardPath: path, deployGate: gate, defaultOwner: fmOwner2 }
      const prev = this.inFlight.get(card.blockId)
      this.inFlight.set(card.blockId, t)
      if (card.review || card.done || card.blocked) {
        this.staleTrack.delete(card.blockId)
        // Fire on any STATE CHANGE, not just open→closed: the normal approval
        // path is review→done and must fire the Done wind-down (the old
        // wasOpen gate silently swallowed it — a card could only ever fire
        // ONE transition in its life).
        const stateOf = (x: { review: boolean; done: boolean; blocked: boolean }) =>
          x.done ? 'done' : x.review ? 'review' : x.blocked ? 'blocked' : 'open'
        const changed = prev ? stateOf(prev) !== stateOf(t) : false
        if (!boot && changed && this.opts.onTransition) this.opts.onTransition(t)
      } else if (!prev && boot) {
        // Restored in-flight card after a restart — watchdog resumes from now.
        this.staleTrack.set(card.blockId, { since: this.now(), nudges: 0 })
      } else if (!boot && prev && DISPATCH_COLUMN_RE.test(card.column)
          && (prev.review || prev.done || prev.blocked || !DISPATCH_COLUMN_RE.test(prev.column))) {
        // REOPEN: a stamped card ENTERED a dispatch column — from review/done
        // (Yousef bouncing work), from #blocked (unblocked in place), or from
        // a non-dispatch column like Backlog. The ^id stamp blocks
        // findDispatchable, so this is the only path that acts. Re-arm the
        // watchdog fresh either way.
        this.staleTrack.set(card.blockId, { since: this.now(), nudges: 0 })
        if (this.opts.onReopen) reopened.push(t)
      } else if (!boot && prev && !prev.review && !prev.done && !prev.blocked
          && prev.content !== card.content) {
        // Content edit on a still-OPEN card (instructions added after
        // dispatch) → tell the assignee to re-read.
        this.opts.onCardEdited?.(t)
      }
    }
    // Reopens fire after the in-flight ledger is current; a string result
    // reassigns the card (fresh ticket-fork owns it now, same as onDispatch).
    if (reopened.length) await this.applyReopens(board, path, reopened)

    // Tell live clients the board changed (post-stamp, so a re-read is final).
    // Boot is skipped — nothing is connected-and-stale at boot.
    if (!boot && this.opts.onBoardChanged) this.opts.onBoardChanged(path)
  }

  /** Run the onReopen handler for each reopened card; a string result
   *  reassigns the board line to that key (the fresh ticket-fork), mirroring
   *  onDispatch's reassign-and-rewrite. */
  private async applyReopens(board: KanbanBoard, path: string, reopened: BoardTransition[]): Promise<void> {
    let rewrite = false
    for (const t of reopened) {
      const res = this.opts.onReopen!(t)
      if (typeof res === 'string' && res !== t.agentKey) {
        const ref = findCardByBlockId(board, t.blockId)
        const card = ref ? getCard(board, ref) : null
        if (card) {
          card.agentKey = res
          refreshCardLine(card)
          rewrite = true
        }
        this.inFlight.set(t.blockId, { ...t, agentKey: res })
      }
      this.opts.log(`[boards] reopen ${path} ^${t.blockId} → @${typeof res === 'string' ? res : t.agentKey}${res === false ? ' (wake FAILED)' : ''}`)
    }
    if (rewrite) {
      try {
        await this.store.write(path, serializeBoard(board))
      } catch (e) {
        this.opts.log(`[boards] reopen reassign write failed for ${path}: ${(e as Error).message}`)
      }
    }
  }

  /** Manual re-dispatch (`con board <p> redispatch <card>`): treat a stamped
   *  card as freshly reopened regardless of column diffing — the escape hatch
   *  when a wake was missed or a fork died without any column move. */
  async redispatch(boardPath: string, blockId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.opts.onReopen) return { ok: false, error: 'no reopen handler wired' }
    let content: string
    try {
      content = await this.store.read(boardPath)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    if (!isKanbanBoard(content)) return { ok: false, error: `${boardPath} is not a kanban board` }
    const board = parseBoard(content)
    const flight = inFlightCards(board).find((c) => c.blockId === blockId)
    if (!flight) return { ok: false, error: `no stamped card ^${blockId} on ${boardPath}` }
    if (flight.done) return { ok: false, error: `^${blockId} is Done — move it to a dispatch column first` }
    const t: BoardTransition = { ...flight, boardPath, deployGate: boardDeployGate(content), defaultOwner: boardDefaultOwner(content) }
    this.staleTrack.set(blockId, { since: this.now(), nudges: 0 })
    this.inFlight.set(blockId, t)
    await this.applyReopens(board, boardPath, [t])
    return { ok: true }
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
