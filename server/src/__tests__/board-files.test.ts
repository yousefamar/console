// ^lean-toad — the astera truncation (2026-09-06): a watcher stamp wrote back a
// 64 KiB prefix of the board it had read mid-`move`. These tests pin every
// half of the fix: atomic NoteStore writes, the lock shared by BoardOps and
// the watcher, size-verified reads, the shrink guard, and the journal.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, utimesSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoteStore, NoteConflictError } from '../notes.js'
import { BoardOps } from '../kanban/board-ops.js'
import { BoardWatcher } from '../kanban/watcher.js'
import { BoardFiles, BoardIntegrityGuard, BoardJournal, BoardWriteRefused, PathLocks, REBASELINE_MS, JOURNAL_KEEP, journalSlug } from '../kanban/board-files.js'

const HEAD = '---\nkanban-plugin: board\n---\n\n## Backlog\n\n## In Progress\n\n'
const TAIL = '\n\n## Under Review\n\n## Done\n\n'

/** A board whose Done column is `n` cards deep — the "big" fixture. */
function bigBoard(n: number, inProgress = ''): string {
  const done = Array.from({ length: n }, (_, i) => `- [x] Done card number ${i} with a fairly long tail so the file has real bulk @eng ^d${i}\n  detail line one for ${i}\n  detail line two for ${i}`).join('\n')
  return `${HEAD}${inProgress}${TAIL}${done}`
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-files-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('NoteStore atomic writes (FIX 1)', () => {
  it('a concurrent reader sees the old file or the new one, never a prefix (2 MB)', async () => {
    const store = new NoteStore(dir)
    const a = 'A'.repeat(2 * 1024 * 1024)
    const b = 'B'.repeat(2 * 1024 * 1024)
    await store.write('big.md', a)
    const abs = join(dir, 'big.md')
    const writing = store.write('big.md', b)
    const seen: string[] = []
    for (let i = 0; i < 12; i++) {
      const c = await readFile(abs, 'utf-8')
      seen.push(c.length === a.length && (c[0] === 'A' || c[0] === 'B') && c[c.length - 1] === c[0] ? c[0]! : `PREFIX(${c.length})`)
    }
    await writing
    expect(seen.every((s) => s === 'A' || s === 'B')).toBe(true)
    expect(await readFile(abs, 'utf-8')).toBe(b)
    // No temp file left behind.
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('writeConditional is atomic too and still returns the new mtime / still 409s', async () => {
    const store = new NoteStore(dir)
    await store.write('n.md', 'v1')
    const { mtime } = await store.readWithMeta('n.md')
    const r = await store.writeConditional('n.md', 'v2', mtime)
    expect(r.mtime).toBeGreaterThanOrEqual(mtime)
    expect(readFileSync(join(dir, 'n.md'), 'utf-8')).toBe('v2')
    await expect(store.writeConditional('n.md', 'v3', mtime - 5000)).rejects.toBeInstanceOf(NoteConflictError)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('readWithMeta reports the stat size so a prefix read is detectable', async () => {
    const store = new NoteStore(dir)
    await store.write('s.md', 'héllo')
    const r = await store.readWithMeta('s.md')
    expect(r.size).toBe(Buffer.byteLength('héllo'))
    expect(Buffer.byteLength(r.content)).toBe(r.size)
  })
})

describe('PathLocks', () => {
  it('serializes sections on the same path and runs different paths independently', async () => {
    const locks = new PathLocks()
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const first = locks.run('a', async () => { order.push('a1-start'); await held; order.push('a1-end') })
    const second = locks.run('a', async () => { order.push('a2') })
    const other = locks.run('b', async () => { order.push('b') })
    await other
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['a1-start', 'b'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['a1-start', 'b', 'a1-end', 'a2'])
  })
})

describe('BoardIntegrityGuard (FIX 3)', () => {
  it('refuses a serialization under 60% of the last good length', () => {
    const g = new BoardIntegrityGuard(() => 0)
    g.observe('p', 1000)
    expect(g.check('p', 500)).toEqual({ ok: false, reason: expect.stringContaining('under 60%') })
    expect(g.check('p', 700).ok).toBe(true)
    expect(g.check('p', 5000).ok).toBe(true)
  })

  it('a legitimate shrink re-baselines only after holding steady across REBASELINE_MS', () => {
    let t = 0
    const g = new BoardIntegrityGuard(() => t)
    g.observe('p', 1000)
    expect(g.observe('p', 100)).toBe('shrink-candidate')
    t += REBASELINE_MS - 1
    expect(g.observe('p', 100)).toBe('shrink-candidate')
    expect(g.check('p', 100).ok).toBe(false)
    t += 2
    expect(g.observe('p', 100)).toBe('rebaselined')
    expect(g.check('p', 100).ok).toBe(true)
    // A size that keeps changing (a write in flight) never re-baselines.
    g.observe('p', 1000)
    expect(g.observe('p', 300)).toBe('shrink-candidate')
    t += REBASELINE_MS * 2
    expect(g.observe('p', 301)).toBe('shrink-candidate')
    expect(g.check('p', 300).ok).toBe(false)
  })

  it('records refusals for the dashboard alerts feed', () => {
    const g = new BoardIntegrityGuard(() => 42)
    g.recordRefusal('p', 'why')
    expect(g.refusals(0)).toEqual([{ ts: 42, path: 'p', message: 'why' }])
    expect(g.refusals(43)).toEqual([])
  })
})

describe('BoardFiles.locked / mutate', () => {
  it('a serialization 50% shorter than last-good is REFUSED, the file untouched, the refusal logged', async () => {
    const store = new NoteStore(dir)
    const logs: string[] = []
    const files = new BoardFiles(store, { log: (m) => logs.push(m) })
    const full = bigBoard(100)
    await store.write('b.md', full)
    await files.readVerified('b.md')
    await expect(files.locked('b.md', async (io) => {
      await io.read()
      await io.write(bigBoard(50))
    })).rejects.toBeInstanceOf(BoardWriteRefused)
    expect(readFileSync(join(dir, 'b.md'), 'utf-8')).toBe(full)
    expect(logs.some((l) => l.startsWith('[boards] refusing suspicious write to b.md'))).toBe(true)
    expect(files.guard.refusals(0)).toHaveLength(1)
    // The explicit restore path may shrink.
    await files.locked('b.md', async (io) => { await io.read(); await io.write(bigBoard(50), { allowShrink: true }) })
    expect(readFileSync(join(dir, 'b.md'), 'utf-8')).toBe(bigBoard(50))
  })

  it('a read that caught a write in flight (stat size ≠ bytes read) is retried, never acted on', async () => {
    const store = new NoteStore(dir)
    const files = new BoardFiles(store)
    const full = bigBoard(20)
    writeFileSync(join(dir, 'b.md'), full)
    // Simulate a non-atomic third-party writer: the first two reads return a
    // prefix while stat already reports the full size.
    let calls = 0
    const orig = store.readWithMeta.bind(store)
    store.readWithMeta = async (p: string) => {
      calls++
      const r = await orig(p)
      return calls <= 2 ? { ...r, content: r.content.slice(0, 1000) } : r
    }
    const r = await files.readVerified('b.md')
    expect(calls).toBe(3)
    expect(r.content).toBe(full)
  })

  it('a write that conflicts with a change since the read is retried once against a fresh read', async () => {
    const store = new NoteStore(dir)
    const files = new BoardFiles(store)
    await store.write('b.md', 'v1')
    let attempt = 0
    await files.mutate('b.md', async (io) => {
      const { content } = await io.read()
      attempt++
      if (attempt === 1) {
        // Someone else writes outside the lock between our read and write.
        await new Promise((r) => setTimeout(r, 5))
        writeFileSync(join(dir, 'b.md'), 'v1-external')
        const d = new Date(Date.now() + 5000)
        utimesSync(join(dir, 'b.md'), d, d)
      }
      await io.write(content + '+mine')
    })
    expect(attempt).toBe(2)
    expect(readFileSync(join(dir, 'b.md'), 'utf-8')).toBe('v1-external+mine')
  })
})

describe('BoardJournal (FIX 4)', () => {
  it('journals the pre-write copy, dedups identical content, keeps the newest JOURNAL_KEEP', async () => {
    let t = 1_000_000
    const j = new BoardJournal(join(dir, 'journal'), () => t++)
    expect(journalSlug('projects/astera/board.md')).toBe('projects__astera__board')
    expect(await j.record('projects/astera/board.md', 'same')).toMatchObject({ bytes: 4 })
    expect(await j.record('projects/astera/board.md', 'same')).toBeNull()
    for (let i = 0; i < JOURNAL_KEEP + 5; i++) await j.record('projects/astera/board.md', `v${i}`)
    const entries = await j.list('projects/astera/board.md')
    expect(entries).toHaveLength(JOURNAL_KEEP)
    expect(entries[0]!.ts).toBeGreaterThan(entries[entries.length - 1]!.ts)
    expect(await j.read('projects/astera/board.md', entries[0]!.ts)).toBe(`v${JOURNAL_KEEP + 4}`)
    expect(readdirSync(join(dir, 'journal', 'projects__astera__board')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a fresh process dedups against the newest entry already on disk', async () => {
    const root = join(dir, 'journal')
    const j1 = new BoardJournal(root, () => 5)
    await j1.record('x.md', 'content')
    const j2 = new BoardJournal(root, () => 6)
    expect(await j2.record('x.md', 'content')).toBeNull()
    expect(await j2.record('x.md', 'changed')).toMatchObject({ ts: 6 })
  })
})

describe('BoardOps + BoardWatcher share one lock (FIX 2)', () => {
  const boardPath = 'projects/demo/board.md'

  function setup(inProgress: string) {
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    writeFileSync(join(dir, boardPath), bigBoard(30, inProgress))
    const store = new NoteStore(dir)
    const files = new BoardFiles(store, { journalDir: join(dir, 'journal') })
    const ops = new BoardOps(store, undefined, files)
    return { store, files, ops }
  }

  it('a watcher stamp waits while a CLI mutation holds the lock, and both land', async () => {
    const { store, files, ops } = setup('- [ ] Ship it @eng\n')
    const events: string[] = []
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    // BoardOps.mutate holds the lock: read done, fn parked before the write.
    const cli = files.locked(boardPath, async (io) => {
      const { content } = await io.read()
      events.push('cli-read')
      await held
      await io.write(content.replace('## Backlog\n', '## Backlog\n\n- [ ] Added by CLI\n'))
      events.push('cli-write')
    })
    await new Promise((r) => setTimeout(r, 10))
    const watcher = new BoardWatcher(store, { log: () => {}, files, pollMs: 999_999, onDispatch: () => { events.push('dispatch'); return true } })
    const boot = watcher.start()
    await new Promise((r) => setTimeout(r, 30))
    // The watcher classified (lock-free) but its stamp is queued behind the CLI.
    expect(events).toEqual(['cli-read'])
    expect(readFileSync(join(dir, boardPath), 'utf-8')).not.toMatch(/Ship it @eng \^/)
    release()
    await Promise.all([cli, boot])
    watcher.stop()
    expect(events).toEqual(['cli-read', 'cli-write', 'dispatch'])
    const final = readFileSync(join(dir, boardPath), 'utf-8')
    expect(final).toContain('- [ ] Added by CLI')          // CLI write survived
    expect(final).toMatch(/- \[ \] Ship it @eng \^[a-z0-9-]+/)   // stamp landed on top of it
    expect(final.split('- [x] Done card').length - 1).toBe(30)   // nothing lost
    // The journal holds the pre-write copies.
    expect((await ops.history('demo')).entries.length).toBeGreaterThanOrEqual(1)
  })

  it('the watcher refuses to stamp a board whose fresh read would shrink it (the incident shape)', async () => {
    const { store, files } = setup('- [ ] Ship it @eng\n')
    const logs: string[] = []
    const watcher = new BoardWatcher(store, { log: (m) => logs.push(m), files, pollMs: 999_999, onDispatch: () => true })
    // Baseline from a first boot on the full board — then reconstruct the
    // watcher over a truncated on-disk copy (a stalled third-party writer).
    await watcher.start()
    watcher.stop()
    const full = readFileSync(join(dir, boardPath), 'utf-8')
    const truncated = full.slice(0, Math.floor(full.length * 0.2)).replace(/\^[a-z0-9-]+/g, '')
    writeFileSync(join(dir, boardPath), truncated)
    const w2 = new BoardWatcher(store, { log: (m) => logs.push(m), files, pollMs: 999_999, onDispatch: () => true })
    await w2.start()
    w2.stop()
    expect(readFileSync(join(dir, boardPath), 'utf-8')).toBe(truncated)   // never written back with a stamp
    expect(logs.some((l) => l.includes('refusing suspicious write'))).toBe(true)
  })

  it('restore overwrites from the journal, journaling the current file first', async () => {
    const { ops } = setup('')
    const before = readFileSync(join(dir, boardPath), 'utf-8')
    await ops.add('demo', 'New card', { column: 'Backlog' })
    const hist = await ops.history('demo')
    expect(hist.entries).toHaveLength(1)
    const r = await ops.restore('demo', hist.entries[0]!.ts)
    expect(r.bytes).toBe(Buffer.byteLength(before))
    expect(readFileSync(join(dir, boardPath), 'utf-8')).toBe(before)
    // The restore itself was journaled (the version with "New card").
    const after = await ops.history('demo')
    expect(after.entries).toHaveLength(2)
    expect(await readFile(join(dir, 'journal', journalSlug(boardPath), `${after.entries[0]!.ts}.md`), 'utf-8')).toContain('New card')
    await expect(ops.restore('demo', 1)).rejects.toThrow(/no journal entry/)
  })
})
