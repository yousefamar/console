import { describe, it, expect } from 'vitest'
import { paginate, wrapLine, TeleprompterController, PAGE_MAX_BYTES } from '../glasses/teleprompter.js'
import type { GlassesNavAck, GlassesTouchFrame } from '../glasses-hub.js'

// The glasses hold ONE 512-byte text buffer (docs/g1-protocol.md §20) — the hub
// owns the script, pages it, and drives touchbar next/prev.

describe('wrapLine', () => {
  it('greedy word-wraps at the width and hard-cuts words longer than it', () => {
    expect(wrapLine('the quick brown fox jumps over the lazy dog', 10)).toEqual(['the quick', 'brown fox', 'jumps over', 'the lazy', 'dog'])
    expect(wrapLine('supercalifragilistic', 8)).toEqual(['supercal', 'ifragili', 'stic'])
    expect(wrapLine('   ', 8)).toEqual([''])
  })
})

describe('paginate', () => {
  it('cuts into 5-row pages, keeps paragraph breaks as blank rows but never starts a page with one', () => {
    const text = 'a1\na2\na3\na4\na5\na6\n\n\n\nb1\nb2'
    expect(paginate(text)).toEqual(['a1\na2\na3\na4\na5', 'a6\n\nb1\nb2'])
  })

  it('wraps long source lines before paging and drops trailing blanks', () => {
    const pages = paginate('one two three four five six seven eight nine ten\n\n\n', 2, 9)
    expect(pages).toEqual(['one two\nthree', 'four five\nsix seven', 'eight\nnine ten'])
  })

  it('never lets a page exceed the firmware text buffer', () => {
    const row = '漢'.repeat(38) // 114 bytes/row → 5 rows = 570 B > 512
    const pages = paginate(Array(5).fill(row).join('\n'))
    expect(pages.length).toBe(2)
    for (const p of pages) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(PAGE_MAX_BYTES)
  })

  it('returns no pages for whitespace-only input', () => {
    expect(paginate('  \n\n \n')).toEqual([])
  })
})

function fakeHub() {
  const calls: Array<{ text: string; init: boolean; multipart: boolean }> = []
  let exits = 0
  const subs = new Set<(f: GlassesTouchFrame) => void>()
  let nextAck: GlassesNavAck = { ok: true, status: 0 }
  return {
    calls,
    exits: () => exits,
    setAck: (a: GlassesNavAck) => { nextAck = a },
    tap: (arm: 'left' | 'right', subcmd: number) => { for (const s of subs) s({ arm, subcmd }) },
    hub: {
      async teleprompterShow(text: string, init: boolean, multipart = false) { calls.push({ text, init, multipart }); return nextAck },
      async teleprompterExit() { exits++; return { ok: true } as GlassesNavAck },
      onTouch(fn: (f: GlassesTouchFrame) => void) { subs.add(fn); return () => subs.delete(fn) },
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('TeleprompterController', () => {
  it('start shows page 1 as INIT, taps page with TEXT, edges clamp, exit sends one exit frame', async () => {
    const f = fakeHub()
    const c = new TeleprompterController(f.hub, { log: () => {}, linesPerPage: 1 })
    const started = await c.start('p1\np2\np3', { title: 't' })
    expect(started).toMatchObject({ active: true, page: 1, pages: 3, title: 't' })
    expect(f.calls).toEqual([{ text: 'p1', init: true, multipart: false }])

    f.tap('right', 0x01); await flush()
    expect(f.calls.at(-1)).toEqual({ text: 'p2', init: false, multipart: false })
    expect(c.status().page).toBe(2)

    f.tap('left', 0x01); await flush()
    expect(f.calls.at(-1)!.text).toBe('p1')
    f.tap('left', 0x01); await flush()          // already at the first page — nothing sent
    expect(f.calls.length).toBe(3)

    await c.goto(99)
    expect(c.status().page).toBe(3)              // clamped
    expect((await c.next()).page).toBe(3)

    const stopped = await c.stop()
    expect(stopped.active).toBe(false)
    expect(f.exits()).toBe(1)
    expect((await c.stop()).ack).toBeNull()      // idempotent, no second frame
    c.dispose()
  })

  it('a refused ack leaves the page pointer where it was and start stays inactive', async () => {
    const f = fakeHub()
    const c = new TeleprompterController(f.hub, { log: () => {}, linesPerPage: 1 })
    f.setAck({ ok: false, status: 1 })
    expect((await c.start('a\nb')).active).toBe(false)
    expect(c.isActive()).toBe(false)
    await expect(c.next()).rejects.toThrow(/no teleprompter session/)
    f.setAck({ ok: true, status: 0 })
    await c.start('a\nb')
    f.setAck({ ok: false, status: 1 })
    expect((await c.next()).page).toBe(1)
    c.dispose()
  })

  it('a double-tap means the glasses left the feature — the session ends without another write', async () => {
    const f = fakeHub()
    const c = new TeleprompterController(f.hub, { log: () => {}, linesPerPage: 1 })
    await c.start('a\nb')
    f.tap('right', 0x00); await flush()
    expect(c.isActive()).toBe(false)
    expect(f.exits()).toBe(0)
    f.tap('right', 0x01); await flush()
    expect(f.calls.length).toBe(1)               // taps are ignored once inactive
    c.dispose()
  })

  it('ignores taps that are not single or double taps and passes multipart through', async () => {
    const f = fakeHub()
    const c = new TeleprompterController(f.hub, { log: () => {}, linesPerPage: 1 })
    await c.start('a\nb', { multipart: true })
    f.tap('right', 0x02); f.tap('right', 0x1e); await flush()
    expect(f.calls.length).toBe(1)
    await c.next()
    expect(f.calls.at(-1)).toEqual({ text: 'b', init: false, multipart: true })
    c.dispose()
  })

  it('refuses an empty script', async () => {
    const f = fakeHub()
    const c = new TeleprompterController(f.hub, { log: () => {} })
    await expect(c.start('\n \n')).rejects.toThrow(/empty/)
    c.dispose()
  })
})

// --- routes ----------------------------------------------------------------

import { handleGlassesRoutes } from '../routes/glasses.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

function fakeRes() {
  const out: { code?: number; body?: string } = {}
  const res = {
    writeHead(code: number) { out.code = code; return res },
    end(body?: string) { out.body = body; res.done?.() },
    done: undefined as undefined | (() => void),
  }
  return { res: res as unknown as ServerResponse, out, wait: () => new Promise<void>((r) => { if (out.body !== undefined) r(); else res.done = r }) }
}

async function call(method: 'GET' | 'POST', path: string, body: unknown, hub: Record<string, unknown>, ctl: TeleprompterController | null) {
  const { res, out, wait } = fakeRes()
  const req = { method, url: path } as IncomingMessage
  const handled = handleGlassesRoutes(req, res, path, hub as never, async () => JSON.stringify(body), { get: () => ({}) } as never, ctl)
  if (handled) await wait()
  return { handled, ...out, json: out.body ? JSON.parse(out.body) : undefined }
}

describe('/glasses/teleprompt routes', () => {
  it('GET status needs no APK and reports idle when nothing is wired', async () => {
    const r = await call('GET', '/glasses/teleprompt', undefined, { hasClient: () => false }, null)
    expect(r.code).toBe(200)
    expect(r.json).toEqual({ active: false, page: 0, pages: 0, title: null })
  })

  it('start 503s without an APK, 400s an empty script, else pages and relays the ack', async () => {
    const f = fakeHub()
    const ctl = new TeleprompterController(f.hub, { log: () => {}, linesPerPage: 1 })
    expect((await call('POST', '/glasses/teleprompt/start', { text: 'a' }, { hasClient: () => false }, ctl)).code).toBe(503)
    expect((await call('POST', '/glasses/teleprompt/start', { text: '  ' }, { hasClient: () => true }, ctl)).code).toBe(400)
    const r = await call('POST', '/glasses/teleprompt/start', { text: 'a\nb\nc', title: 'talk' }, { hasClient: () => true }, ctl)
    expect(r.code).toBe(200)
    expect(r.json).toMatchObject({ active: true, page: 1, pages: 3, title: 'talk', ack: { ok: true } })
    expect(f.calls[0]).toEqual({ text: 'a', init: true, multipart: false })
    const n = await call('POST', '/glasses/teleprompt/next', undefined, { hasClient: () => true }, ctl)
    expect(n.json.page).toBe(2)
    const g = await call('POST', '/glasses/teleprompt/goto', { page: 3 }, { hasClient: () => true }, ctl)
    expect(g.json.page).toBe(3)
    expect((await call('POST', '/glasses/teleprompt/goto', { page: 0 }, { hasClient: () => true }, ctl)).code).toBe(422)
    // exit works even with the APK gone from the hub's point of view (the controller decides what to write)
    const x = await call('POST', '/glasses/teleprompt/exit', undefined, { hasClient: () => true }, ctl)
    expect(x.json.active).toBe(false)
    expect(f.exits()).toBe(1)
    ctl.dispose()
  })

  it('502s when the phone RPC throws and ignores unknown verbs', async () => {
    const ctl = new TeleprompterController({
      async teleprompterShow() { throw new Error('rpc teleprompterShow timed out after 10000ms') },
      async teleprompterExit() { return { ok: true } },
      onTouch() { return () => {} },
    }, { log: () => {} })
    const r = await call('POST', '/glasses/teleprompt/start', { text: 'a' }, { hasClient: () => true }, ctl)
    expect(r.code).toBe(502)
    expect(r.json.error).toMatch(/timed out/)
    expect((await call('POST', '/glasses/teleprompt/bogus', {}, { hasClient: () => true }, ctl)).handled).toBe(false)
    ctl.dispose()
  })
})
