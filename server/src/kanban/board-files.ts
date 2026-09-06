// BoardFiles — the ONE way a board file is read-modified-written.
//
// Incident (astera board, 2026-09-06): while an agent fired four `move`s in a
// loop, the board went from ~300 KB / 112 Done cards to 65,706 bytes / 5 Done
// cards, its last line cut mid-word. Two halves combined: NoteStore.write was
// fs.writeFile (O_TRUNC + chunked writes, so a concurrent reader sees a
// prefix), and the BoardWatcher read the board OUTSIDE BoardOps' per-path
// lock, then wrote its stamp back over whatever prefix it had read. Syncthing
// versioning (5 slots, one remote) had rotated past the loss by the time it
// was noticed.
//
// This module closes every half at once:
//   • one per-path lock shared by BoardOps AND the watcher's write paths
//     (`locked()`), so a CLI mutation and a watcher stamp never interleave;
//   • size-verified reads — a read whose byte length differs from the file's
//     stat size caught a third-party write in flight and is retried, never
//     acted on (real boards end without a trailing newline, so "newline at
//     EOF" cannot be the discriminator);
//   • a shrink guard — a serialization under SHRINK_RATIO of the last-good
//     length is REFUSED, logged, and surfaced as a dashboard alert; a board
//     that legitimately shrank re-baselines once the smaller size has been
//     observed stable for REBASELINE_MS;
//   • a hub-side journal — every write first copies the current file to
//     ~/.config/console/board-journal/<slug>/<epoch>.md (last JOURNAL_KEEP per
//     board), the recovery path that would have saved the 106 cards;
//   • conditional writes — the write carries the read's mtime, so a file
//     changed underneath (SPA whole-file PUT, Syncthing) is a conflict the
//     caller retries with a fresh read, not a clobber.
// NoteStore.write itself is atomic (temp + rename) since the same fix, so a
// lock-free classification read can no longer see a prefix of OUR writes.

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { NoteConflictError, type NoteStore } from '../notes.js'

export const SHRINK_RATIO = 0.6
/** A smaller size must be seen unchanged across polls this long before it
 *  becomes the new baseline — a write in flight changes size poll to poll. */
export const REBASELINE_MS = 15_000
export const JOURNAL_KEEP = 100
const READ_RETRIES = 4
const READ_RETRY_MS = 40

export class BoardWriteRefused extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`refusing suspicious write to ${path}: ${reason}`)
    this.name = 'BoardWriteRefused'
  }
}

export interface BoardRead {
  content: string
  /** Byte length of `content` — equal to the stat size by construction. */
  bytes: number
  mtime: number
}

export interface BoardIO {
  /** Size-verified read of the board (retries a read that caught a write in
   *  flight; throws after READ_RETRIES). */
  read(): Promise<BoardRead>
  /** Journal the current file, run the shrink guard, then write `next`
   *  conditionally on the mtime of the last read(). Throws
   *  BoardWriteRefused (guard) or NoteConflictError (file changed since the
   *  read — re-read and retry). `allowShrink` is for the explicit restore
   *  verb only. */
  write(next: string, opts?: { allowShrink?: boolean }): Promise<void>
}

export interface Refusal { ts: number; path: string; message: string }

/** Per-path write queue — critical sections on the same board serialize. */
export class PathLocks {
  private chains = new Map<string, Promise<unknown>>()
  run<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(path) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    this.chains.set(path, next)
    // Drop the chain once idle so the map doesn't grow with every board ever seen.
    void next.catch(() => {}).finally(() => { if (this.chains.get(path) === next) this.chains.delete(path) })
    return next
  }
}

/** Last-good byte length per board + the shrink decision. Pure apart from the clock. */
export class BoardIntegrityGuard {
  private lastGood = new Map<string, number>()
  private shrinkSeen = new Map<string, { bytes: number; at: number }>()
  private refusalLog: Refusal[] = []

  constructor(private readonly now: () => number = Date.now) {}

  baseline(path: string): number | undefined { return this.lastGood.get(path) }

  /** A complete (size-verified) read was observed. Grows and small shrinks
   *  move the baseline at once; a shrink below SHRINK_RATIO must hold steady
   *  for REBASELINE_MS first — a truncating write in flight changes size
   *  between observations, a legitimately halved board does not. */
  observe(path: string, bytes: number): 'ok' | 'shrink-candidate' | 'rebaselined' {
    const good = this.lastGood.get(path)
    if (good === undefined || bytes >= good * SHRINK_RATIO) {
      this.lastGood.set(path, bytes)
      this.shrinkSeen.delete(path)
      return 'ok'
    }
    const seen = this.shrinkSeen.get(path)
    const t = this.now()
    if (seen && seen.bytes === bytes && t - seen.at >= REBASELINE_MS) {
      this.lastGood.set(path, bytes)
      this.shrinkSeen.delete(path)
      return 'rebaselined'
    }
    if (!seen || seen.bytes !== bytes) this.shrinkSeen.set(path, { bytes, at: t })
    return 'shrink-candidate'
  }

  /** Would writing `nextBytes` be a suspicious shrink? */
  check(path: string, nextBytes: number): { ok: true } | { ok: false; reason: string } {
    const good = this.lastGood.get(path)
    if (good !== undefined && nextBytes < good * SHRINK_RATIO) {
      return { ok: false, reason: `${nextBytes} bytes is under ${Math.round(SHRINK_RATIO * 100)}% of the last good ${good} bytes` }
    }
    return { ok: true }
  }

  recordWrite(path: string, bytes: number): void {
    this.lastGood.set(path, bytes)
    this.shrinkSeen.delete(path)
  }

  recordRefusal(path: string, message: string): void {
    this.refusalLog.push({ ts: this.now(), path, message })
    if (this.refusalLog.length > 50) this.refusalLog.splice(0, this.refusalLog.length - 50)
  }

  refusals(sinceMs = 0): Refusal[] {
    return this.refusalLog.filter((r) => r.ts >= sinceMs)
  }
}

export interface JournalEntry { ts: number; bytes: number; file: string }

/** `projects/astera/board.md` → `projects__astera__board` — one dir per board. */
export function journalSlug(boardPath: string): string {
  return boardPath.replace(/\.md$/, '').replace(/\//g, '__')
}

/** Pre-write copies of every board, last JOURNAL_KEEP per board. */
export class BoardJournal {
  private lastHash = new Map<string, string>()
  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {}

  private dirFor(boardPath: string): string { return join(this.dir, journalSlug(boardPath)) }

  /** Copy `content` (the CURRENT file, about to be replaced) into the journal.
   *  Byte-identical to the newest entry → skipped (a stamp followed by its
   *  reassign write would otherwise journal the same bytes twice). */
  async record(boardPath: string, content: string): Promise<JournalEntry | null> {
    const hash = createHash('sha1').update(content).digest('hex')
    if (this.lastHash.get(boardPath) === hash) return null
    const dir = this.dirFor(boardPath)
    await mkdir(dir, { recursive: true })
    if (!this.lastHash.has(boardPath)) {
      const newest = (await this.list(boardPath))[0]
      if (newest) {
        const prev = await readFile(join(dir, newest.file), 'utf-8').catch(() => null)
        if (prev !== null && createHash('sha1').update(prev).digest('hex') === hash) {
          this.lastHash.set(boardPath, hash)
          return null
        }
      }
    }
    let ts = this.now()
    const existing = new Set((await readdir(dir).catch(() => [] as string[])))
    while (existing.has(`${ts}.md`)) ts++
    const file = `${ts}.md`
    const tmp = join(dir, `.${file}.${randomBytes(3).toString('hex')}.tmp`)
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, join(dir, file))
    this.lastHash.set(boardPath, hash)
    await this.rotate(dir)
    return { ts, bytes: Buffer.byteLength(content), file }
  }

  private async rotate(dir: string): Promise<void> {
    const entries = (await readdir(dir)).filter((f) => /^\d+\.md$/.test(f)).sort((a, b) => Number(b.slice(0, -3)) - Number(a.slice(0, -3)))
    for (const f of entries.slice(JOURNAL_KEEP)) await unlink(join(dir, f)).catch(() => {})
  }

  /** Newest first. */
  async list(boardPath: string): Promise<JournalEntry[]> {
    const dir = this.dirFor(boardPath)
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /^\d+\.md$/.test(f))
    const out: JournalEntry[] = []
    for (const file of files) {
      const st = await stat(join(dir, file)).catch(() => null)
      if (st) out.push({ ts: Number(file.slice(0, -3)), bytes: st.size, file })
    }
    return out.sort((a, b) => b.ts - a.ts)
  }

  async read(boardPath: string, ts: number): Promise<string> {
    return readFile(join(this.dirFor(boardPath), `${ts}.md`), 'utf-8')
  }
}

export interface BoardFilesOpts {
  /** Journal root (`~/.config/console/board-journal`). Absent = no journal (tests). */
  journalDir?: string
  log?: (msg: string) => void
  now?: () => number
}

export class BoardFiles {
  readonly locks = new PathLocks()
  readonly guard: BoardIntegrityGuard
  readonly journal: BoardJournal | null
  private readonly log: (msg: string) => void

  constructor(private readonly store: NoteStore, opts: BoardFilesOpts = {}) {
    const now = opts.now ?? Date.now
    this.guard = new BoardIntegrityGuard(now)
    this.journal = opts.journalDir ? new BoardJournal(opts.journalDir, now) : null
    this.log = opts.log ?? (() => {})
  }

  /** Size-verified read, lock-free — for classification. Also feeds the
   *  shrink baseline. Throws if the file never settles (a writer mid-flight
   *  across every retry). */
  async readVerified(path: string): Promise<BoardRead> {
    let last: { content: string; size: number } | null = null
    for (let i = 0; i < READ_RETRIES; i++) {
      const r = await this.store.readWithMeta(path)
      const bytes = Buffer.byteLength(r.content)
      if (bytes === r.size) {
        const verdict = this.guard.observe(path, bytes)
        if (verdict !== 'ok') this.log(`[boards] ${path} is ${bytes} bytes, under ${Math.round(SHRINK_RATIO * 100)}% of the last good ${this.guard.baseline(path)} (${verdict})`)
        return { content: r.content, bytes, mtime: r.mtime }
      }
      last = { content: r.content, size: r.size }
      await new Promise((res) => setTimeout(res, READ_RETRY_MS))
    }
    throw new Error(`${path}: read ${Buffer.byteLength(last!.content)} bytes but the file is ${last!.size} — a write is in flight`)
  }

  /** Exclusive read-modify-write section for one board. */
  locked<T>(path: string, fn: (io: BoardIO) => Promise<T>): Promise<T> {
    return this.locks.run(path, async () => {
      let base: BoardRead | null = null
      const io: BoardIO = {
        read: async () => { base = await this.readVerified(path); return base },
        write: async (next, opts) => {
          if (!base) throw new Error('BoardIO.write before read')
          const nextBytes = Buffer.byteLength(next)
          if (!opts?.allowShrink) {
            const v = this.guard.check(path, nextBytes)
            if (!v.ok) {
              this.guard.recordRefusal(path, v.reason)
              this.log(`[boards] refusing suspicious write to ${path}: ${v.reason}`)
              throw new BoardWriteRefused(path, v.reason)
            }
          }
          if (this.journal) {
            try { await this.journal.record(path, base.content) } catch (e) { this.log(`[boards] journal failed for ${path}: ${(e as Error).message}`) }
          }
          const { mtime } = await this.store.writeConditional(path, next, base.mtime)
          this.guard.recordWrite(path, nextBytes)
          base = { content: next, bytes: nextBytes, mtime }
        },
      }
      return fn(io)
    })
  }

  /** `locked()` plus one automatic retry when the file changed between the
   *  read and the write (another writer outside the lock — SPA whole-file
   *  save, Syncthing). `fn` must be re-runnable against a fresh parse. */
  async mutate<T>(path: string, fn: (io: BoardIO) => Promise<T>): Promise<T> {
    try {
      return await this.locked(path, fn)
    } catch (e) {
      if (!(e instanceof NoteConflictError)) throw e
      this.log(`[boards] ${path} changed under a mutation — retrying with a fresh read`)
      return this.locked(path, fn)
    }
  }
}
