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
import { isKanbanBoard, boardDeployGate, boardDefaultOwner, boardMaxForks, boardForkContext, parseBoard, serializeBoard, refreshCardLine, findCardByBlockId, getCard, type BoardCard, type KanbanBoard } from './board.js'
import { findDispatchable, inFlightCards, mintBlockId, DISPATCH_COLUMN_RE, DEFAULT_MAX_RUNNING_FORKS, type DispatchableCard, type InFlightCard, type ReviewCardRef } from './dispatch.js'
import { BoardFiles } from './board-files.js'

export interface BoardDispatch {
  /** Vault-relative board path. */
  boardPath: string
  card: BoardCard
  column: string
  /** projects/<slug>/… boards carry the slug. */
  project: string | null
  /** Board frontmatter `deploy_gate: review` — see boardDeployGate(). */
  deployGate: 'review' | null
  /** Cards with a live worker after this dispatch, and the cap in force — the
   *  envelope tells a fork starting under load to serialise its heavy steps. */
  load: { running: number; cap: number }
  /** Card `#inherit` or board `fork_context: inherit` — the ticket-fork
   *  inherits the parent's transcript instead of fresh context + digest. */
  inherit: boolean
}

/** A card sitting in a dispatch column that the cap has held back: unstamped,
 *  un-assigned-by-us, so it stays an ordinary board card. */
export interface QueuedCard {
  boardPath: string
  text: string
  /** When the watcher FIRST saw it dispatchable — the FIFO key, so cards go in
   *  the order Yousef moved them, not the order files happen to be polled. */
  seenAt: number
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
  /** Hub-wide concurrency cap (prefs `boards.maxRunningForks`), read per
   *  decision so a live config change applies without a restart. */
  maxRunningForks?: () => number
  /** Is this card's worker still alive? A card whose fork has ended (or was
   *  never spawned) must not hold a slot. Absent = treat every in-flight card
   *  as running (the pessimistic default, and what the tests assert). */
  isWorkerAlive?: (agentKey: string) => boolean
  /** Is this card's worker WAITING ON YOUSEF — an AskUserQuestion/plan-approval
   *  pending in its session? Such a card is not stalled, it is blocked on the
   *  human: the stale watchdog skips it WITHOUT burning a nudge AND restarts
   *  its clock, so the first nudge comes staleMs after the answer — not the
   *  instant he answers (^red-loon: both nudges landed 10 s apart at 04:17
   *  while Coach was mid-question, the clock having run for 6 h). */
  isWorkerWaitingOnUser?: (agentKey: string) => boolean
  /** Is this ^id already in use OUTSIDE the boards? The hub answers from its
   *  session list: a fork whose key ends `-<id>-fork` or whose title is the
   *  id's `forkTitle` — including ended/hibernated ones whose card has since
   *  been deleted from a board. Consulted at mint time on top of every id the
   *  watcher has seen on any board. */
  isIdTaken?: (id: string) => boolean
  /** The lock/guard/journal shared with BoardOps. MUST be the same instance
   *  the CLI's BoardOps uses, or a stamp and a `move` can interleave on the
   *  same file (the 2026-09-06 astera truncation). Absent = a private one
   *  (tests without a BoardOps). */
  files?: BoardFiles
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

const pendKey = (boardPath: string, text: string) => `${boardPath}\u0000${text}`

export class BoardWatcher {
  /** Vault-relative paths currently classified as boards. */
  private boards = new Set<string>()
  /** blockId → last-seen state, for transition diffing. */
  private inFlight = new Map<string, BoardTransition>()
  /** Every ^id seen on ANY board this run — never pruned. `inFlight` is not
   *  enough as the mint-time clash set: it is filled board-by-board AFTER each
   *  board's own stamp step, so at boot a board's Done ids and every board
   *  later in list order were invisible to the check (astera re-minted its
   *  own ^gray-stag and memo's ^spry-kite on the 2026-09-09 restart), and a
   *  card deleted from a board drops out of the ledger on the next restart
   *  while its fork session may still carry the id. */
  private usedIds = new Set<string>()
  /** blockId → dispatch/boot timestamp + nudges sent. */
  private staleTrack = new Map<string, { since: number; nudges: number }>()
  /** `boardPath\0text` → queued card the cap held back. Keyed by TEXT because
   *  a queued card has no ^id yet (stamping it would mark it dispatched). */
  private pending = new Map<string, QueuedCard>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPoll = 0
  private scanning = false
  private draining = false
  private readonly files: BoardFiles

  constructor(private store: NoteStore, private opts: BoardWatcherOpts) {
    this.files = opts.files ?? new BoardFiles(store, { log: opts.log, now: opts.now })
  }

  async start(): Promise<void> {
    const now = this.now()
    const all = await this.store.list()
    // Two passes. First find every board and record every ^id it carries, so
    // the clash set is complete BEFORE any board gets to stamp — a boot-time
    // stamp otherwise checks only the boards classified ahead of it.
    const boards: string[] = []
    for (const f of all) {
      if (!f.path.endsWith('.md')) continue
      let content: string
      try {
        content = (await this.files.readVerified(f.path)).content
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.opts.log(`[boards] boot: skipping ${f.path}: ${(e as Error).message}`)
        continue
      }
      if (!isKanbanBoard(content)) continue
      boards.push(f.path)
      this.recordIds(parseBoard(content))
    }
    for (const path of boards) await this.classify(path, { boot: true })
    this.lastPoll = now
    await this.drainQueue()
    this.opts.log(`[boards] watching ${this.boards.size} board(s), ${this.inFlight.size} card(s) in flight, ${this.runningForks()} running (cap ${this.cap()})`)
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

  private recordIds(board: KanbanBoard): void {
    for (const col of board.columns) for (const c of col.cards) if (c.blockId) this.usedIds.add(c.blockId)
  }

  /** The mint-time clash predicate: every id ever seen on a board this run,
   *  every id in the in-flight ledger, and whatever the hub knows (fork
   *  sessions, live or ended). */
  private idTaken(id: string): boolean {
    return this.usedIds.has(id) || this.inFlight.has(id) || (this.opts.isIdTaken?.(id) ?? false)
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
      // Every classify above refreshed the in-flight ledger, so capacity now
      // reflects cards that just left In Progress — the poll IS the re-scan
      // trigger for "a slot freed up".
      await this.drainQueue()
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
    for (const [k, q] of this.pending) if (q.boardPath === path) this.pending.delete(k)
  }

  /** Cards held back by the cap, oldest first. Surfaced per board in the
   *  Spaces rail so a card sitting in In Progress with no @fork is legible. */
  queuedCards(): QueuedCard[] {
    return [...this.pending.values()].sort((a, b) => a.seenAt - b.seenAt)
  }

  /** In-flight cards that currently occupy a concurrency slot: stamped, in a
   *  dispatch column, not review/done/blocked, worker still alive. */
  runningForks(): number {
    let n = 0
    for (const t of this.inFlight.values()) {
      if (t.review || t.done || t.blocked) continue
      if (!DISPATCH_COLUMN_RE.test(t.column)) continue
      if (t.agentKey && this.opts.isWorkerAlive && !this.opts.isWorkerAlive(t.agentKey)) continue
      n++
    }
    return n
  }

  private cap(boardContent?: string): number {
    const global = this.opts.maxRunningForks?.() ?? DEFAULT_MAX_RUNNING_FORKS
    const perBoard = boardContent ? boardMaxForks(boardContent) : null
    return perBoard ?? global
  }

  /** A worker session ended — its card may still sit in In Progress (the fork
   *  died, or Yousef killed it), so a slot just freed. Called by the hub on
   *  session end; the poll would find it anyway, up to 10 s later. */
  onWorkerEnded(): Promise<void> {
    return this.drainQueue()
  }

  /** Dispatch queued cards while capacity allows, oldest-first across ALL
   *  boards. Selection is global FIFO; the actual stamping is grouped per
   *  board so each file is read and written once (and the stamp lands BEFORE
   *  onDispatch, keeping the "a stamp means dispatched" crash contract). */
  private async drainQueue(): Promise<void> {
    if (this.draining || this.pending.size === 0) return
    this.draining = true
    try {
      let running = this.runningForks()
      const contents = new Map<string, string>()
      const chosen = new Map<string, QueuedCard[]>()
      for (const q of this.queuedCards()) {
        let content = contents.get(q.boardPath)
        if (content === undefined) {
          try {
            content = (await this.files.readVerified(q.boardPath)).content
          } catch {
            this.pending.delete(pendKey(q.boardPath, q.text))
            continue
          }
          contents.set(q.boardPath, content)
        }
        if (running >= this.cap(content)) continue
        running++
        chosen.set(q.boardPath, [...(chosen.get(q.boardPath) ?? []), q])
      }
      for (const [path, queued] of chosen) {
        const content = contents.get(path)!
        if (!isKanbanBoard(content)) { for (const q of queued) this.pending.delete(pendKey(path, q.text)); continue }
        const board = parseBoard(content)
        const texts = new Set(queued.map((q) => q.text))
        const todo = findDispatchable(board).filter((d) => texts.has(d.card.text))
        for (const q of queued) this.pending.delete(pendKey(path, q.text))
        if (todo.length) await this.stampAndDispatch(path, todo.map((d) => d.card.text))
        // The stamp + assignee are new on disk — let live clients re-read.
        if (this.opts.onBoardChanged) this.opts.onBoardChanged(path)
      }
    } catch (e) {
      this.opts.log(`[boards] drain: ${(e as Error).message}`)
    } finally {
      this.draining = false
    }
  }

  /** (Re)read one file: classify as board or not, stamp+dispatch, diff transitions. */
  private async classify(path: string, { boot }: { boot: boolean }): Promise<void> {
    let content: string
    try {
      // Size-verified: a read that caught a third-party write mid-flight is
      // retried, never classified — acting on a prefix is how a board loses
      // its tail. Only a MISSING file drops the board.
      content = (await this.files.readVerified(path)).content
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { this.dropBoard(path); return }
      this.opts.log(`[boards] skipping ${path} this poll: ${(e as Error).message}`)
      return
    }
    if (!isKanbanBoard(content)) {
      this.dropBoard(path)
      return
    }
    this.boards.add(path)

    let board = parseBoard(content)
    this.recordIds(board)
    const project = projectForBoardPath(path)

    // Stamp + dispatch new assignments (skipped on boot only in the sense
    // that boot finds none un-stamped that were stamped before — the stamp
    // is durable, so boot dispatches genuinely-new cards too, which is what
    // you want after a hub outage during which someone assigned work).
    // CONCURRENCY CAP: only as many cards as the cap allows get stamped now;
    // the rest stay ordinary unstamped cards and are recorded as queued, to be
    // dispatched oldest-first by drainQueue when a slot frees. Repairs (below)
    // never consume a slot — they restore a stamp that already existed.
    const todo = findDispatchable(board)
    if (todo.length) {
      const capacity = Math.max(0, this.cap(content) - this.runningForks())
      const go: DispatchableCard[] = []
      let claimed = 0
      for (const d of todo) {
        // A repair re-stamps an id that already existed, so it neither needs
        // nor consumes a slot.
        if (this.priorFor(path, d.card.text)) { go.push(d); continue }
        if (claimed < capacity) { claimed++; go.push(d); continue }
        const key = pendKey(path, d.card.text)
        if (!this.pending.has(key)) {
          this.pending.set(key, { boardPath: path, text: d.card.text, seenAt: this.now() })
          this.opts.log(`[boards] queued "${d.card.text.slice(0, 50)}" on ${path} (cap ${this.cap(content)} reached)`)
        }
      }
      // A card that got a slot is no longer queued (it may have been queued on
      // an earlier poll and drained here instead of by drainQueue).
      for (const d of go) this.pending.delete(pendKey(path, d.card.text))
      if (go.length) {
        // The stamp happened against a FRESH read inside the lock — continue
        // the diff below from that state, not the pre-stamp parse.
        const fresh = await this.stampAndDispatch(path, go.map((d) => d.card.text))
        if (fresh) { content = fresh.content; board = fresh.board }
      }
    }

    // Diff in-flight state for transitions.
    const gate = boardDeployGate(content)
    const fmOwner2 = boardDefaultOwner(content)
    const reopened: BoardTransition[] = []
    for (const card of inFlightCards(board, { boardInherit: boardForkContext(content) === 'inherit' })) {
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
    if (reopened.length) await this.applyReopens(path, reopened)

    // Tell live clients the board changed (post-stamp, so a re-read is final).
    // Boot is skipped — nothing is connected-and-stale at boot.
    if (!boot && this.opts.onBoardChanged) this.opts.onBoardChanged(path)
  }

  /** An OPEN in-flight card on this board with the same text — evidence that a
   *  stale whole-file write wiped a stamp rather than someone adding new work. */
  private priorFor(path: string, text: string): BoardTransition | undefined {
    return [...this.inFlight.values()].find((t) => t.boardPath === path && !t.done && t.text === text)
  }

  /** Stamp the selected cards, write the file, then fire onDispatch for each.
   *  The stamp lands BEFORE the wake so a crash mid-dispatch leaves the card
   *  marked dispatched (visible on the board) rather than silently re-firing.
   *
   *  DUPLICATE-FORK GUARD: a stale whole-file write (the SPA saving an old
   *  in-memory copy between two of the user's drags) can wipe a fresh stamp —
   *  the card comes back "unstamped" and would re-dispatch, spawning a SECOND
   *  fork for the same work (observed live 2026-08-20: 5 rapid card moves
   *  produced duplicate forks). Same text as an open in-flight card =
   *  stamp-LOSS: restore its id + assignee and do NOT dispatch again. */
  private async stampAndDispatch(path: string, texts: string[]): Promise<{ content: string; board: KanbanBoard } | null> {
    const project = projectForBoardPath(path)
    const wanted = new Set(texts)
    const reassign = new Map<string, string>()
    // `as` keeps the declared union: assigned inside the mutate() closure, so
    // control-flow analysis would otherwise narrow the initial `null` to `never`.
    let after = null as { content: string; board: KanbanBoard } | null
    // Cards whose stamp landed in this write — woken AFTER the lock is released
    // (below), so the lock section is pure file I/O and a CLI `move` queued on
    // the same board proceeds the moment the write lands, not after N fork
    // spawns. The stamp still precedes every wake (crash contract), and a
    // conflict retry re-runs only the closure, never a wake.
    let dispatchNow: DispatchableCard[] = []
    let stamped = ''
    try {
      // The whole read-modify-write runs INSIDE the lock shared with BoardOps,
      // against a FRESH read — the classification read that chose these cards
      // was lock-free and may be stale by now (a `move` could have landed).
      // A card no longer dispatchable in the fresh read is simply skipped.
      await this.files.mutate(path, async (io) => {
        dispatchNow = []
        const { content } = await io.read()
        const board = parseBoard(content)
        // The fresh read is the truth for this board's own ids (the ledger
        // lags it by a poll, and at boot has not seen this board at all).
        this.recordIds(board)
        const todo = findDispatchable(board).filter((d) => wanted.has(d.card.text))
        if (!todo.length) return
        const fmOwner = boardDefaultOwner(content)
        // Word-pair ids collide far sooner than 36^6 — check every id known
        // anywhere (boards, ledger, sessions) PLUS ids minted earlier in this
        // very loop (recordIds is fed as we go via usedIds).
        const taken = (id: string) => this.idTaken(id)
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
          const prior = this.priorFor(path, d.card.text)
          if (prior) {
            d.card.blockId = prior.blockId
            if (prior.agentKey) d.card.agentKey = prior.agentKey
            refreshCardLine(d.card)
            this.opts.log(`[boards] re-stamped ^${prior.blockId} on ${path} (stale write wiped it) — no re-dispatch`)
            continue
          }
          d.card.blockId = mintBlockId({ taken })
          this.usedIds.add(d.card.blockId)
          refreshCardLine(d.card)
          dispatchNow.push(d)
        }
        // The stamp lands BEFORE the wake (crash contract, see above). An
        // unchanged serialization (every card skipped) is not written — that
        // would bump the mtime and re-trigger this poll forever.
        const next = serializeBoard(board)
        if (next !== content) await io.write(next)
        after = { content: next, board }
        stamped = content
      })
    } catch (e) {
      this.opts.log(`[boards] stamp write failed for ${path}: ${(e as Error).message}`)
      return null
    }
    // Lock released; the stamps are on disk. Now wake the workers.
    if (dispatchNow.length) {
      const cap = this.cap(stamped)
      const deployGate = boardDeployGate(stamped)
      const boardInherit = boardForkContext(stamped) === 'inherit'
      let running = this.runningForks()
      for (const d of dispatchNow) {
        running++
        const res = this.opts.onDispatch({ boardPath: path, card: d.card, column: d.column, project, deployGate, load: { running, cap }, inherit: d.card.inherit || boardInherit })
        // A string result = the worker is a ticket-FORK with its own @key —
        // rewrite the card's assignee so everything downstream (stale nudges,
        // transition wakes, the assignee filter) targets the fork, not the
        // source role that stayed free for conversation.
        if (typeof res === 'string' && res !== d.card.agentKey) reassign.set(d.card.blockId!, res)
        // A wake that never happened holds no slot.
        if (res === false) running--
        this.opts.log(`[boards] dispatch ${path} ^${d.card.blockId} → @${typeof res === 'string' ? res : d.card.agentKey}${res === false ? ' (wake FAILED)' : ''} [${running}/${cap}]`)
        this.staleTrack.set(d.card.blockId!, { since: this.now(), nudges: 0 })
      }
    }
    // The reassign is its OWN locked section: the fork's @key only exists once
    // the wake has run, and wakes happen outside the stamp lock.
    if (reassign.size && after) {
      const board = after.board
      for (const [blockId, key] of reassign) {
        const ref = findCardByBlockId(board, blockId)
        const card = ref ? getCard(board, ref) : null
        if (card) { card.agentKey = key; refreshCardLine(card) }
      }
      after = { content: serializeBoard(board), board }
      await this.reassignCards(path, reassign, 'reassign')
    }
    return after
  }

  /** Rewrite the assignee of stamped cards (blockId → @key) under the lock,
   *  against a fresh read. */
  private async reassignCards(path: string, reassign: Map<string, string>, what: string): Promise<void> {
    try {
      await this.files.mutate(path, async (io) => {
        const board = parseBoard((await io.read()).content)
        let rewrite = false
        for (const [blockId, key] of reassign) {
          const ref = findCardByBlockId(board, blockId)
          const card = ref ? getCard(board, ref) : null
          if (card && card.agentKey !== key) {
            card.agentKey = key
            refreshCardLine(card)
            rewrite = true
          }
        }
        if (rewrite) await io.write(serializeBoard(board))
      })
    } catch (e) {
      this.opts.log(`[boards] ${what} write failed for ${path}: ${(e as Error).message}`)
    }
  }

  /** Run the onReopen handler for each reopened card; a string result
   *  reassigns the board line to that key (the fresh ticket-fork), mirroring
   *  onDispatch's reassign-and-rewrite. The rewrite re-reads inside the lock. */
  private async applyReopens(path: string, reopened: BoardTransition[]): Promise<void> {
    const reassign = new Map<string, string>()
    for (const t of reopened) {
      const res = this.opts.onReopen!(t)
      if (typeof res === 'string' && res !== t.agentKey) {
        reassign.set(t.blockId, res)
        this.inFlight.set(t.blockId, { ...t, agentKey: res })
      }
      this.opts.log(`[boards] reopen ${path} ^${t.blockId} → @${typeof res === 'string' ? res : t.agentKey}${res === false ? ' (wake FAILED)' : ''}`)
    }
    if (reassign.size) await this.reassignCards(path, reassign, 'reopen reassign')
  }

  /** Manual re-dispatch (`con board <p> redispatch <card>`): treat a stamped
   *  card as freshly reopened regardless of column diffing — the escape hatch
   *  when a wake was missed or a fork died without any column move. */
  async redispatch(boardPath: string, blockId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.opts.onReopen) return { ok: false, error: 'no reopen handler wired' }
    let content: string
    try {
      content = (await this.files.readVerified(boardPath)).content
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    if (!isKanbanBoard(content)) return { ok: false, error: `${boardPath} is not a kanban board` }
    const board = parseBoard(content)
    const flight = inFlightCards(board, { boardInherit: boardForkContext(content) === 'inherit' }).find((c) => c.blockId === blockId)
    if (!flight) return { ok: false, error: `no stamped card ^${blockId} on ${boardPath}` }
    if (flight.done) return { ok: false, error: `^${blockId} is Done — move it to a dispatch column first` }
    const t: BoardTransition = { ...flight, boardPath, deployGate: boardDeployGate(content), defaultOwner: boardDefaultOwner(content) }
    this.staleTrack.set(blockId, { since: this.now(), nudges: 0 })
    this.inFlight.set(blockId, t)
    await this.applyReopens(boardPath, [t])
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
      // Waiting on an AskUserQuestion/plan approval = waiting on Yousef, not
      // stalled. Restart the clock (his answer is activity) so the nudge
      // fires only if the card STILL sits there staleMs after he answers.
      if (t.agentKey && this.opts.isWorkerWaitingOnUser?.(t.agentKey)) { track.since = now; continue }
      track.nudges++
      if (this.opts.onStale) this.opts.onStale(t, track.nudges)
    }
  }
}
