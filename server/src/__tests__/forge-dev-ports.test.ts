// forge/dev-ports.ts — one dev-server port per live forge session.
// 9 Oct 2026: seven ports were each held by two or three live forks, because
// the table of ports in use was empty after every hub restart while restored
// sessions kept theirs, and nothing ever released one.
import { describe, it, expect } from 'vitest'
import { DevPorts, devPortChangedNote, DEV_PORT_BASE, DEV_PORT_TOP, RESERVATION_TTL_MS } from '../forge/dev-ports.js'

function ports(live: number[] = []) {
  const clock = { now: 1_000_000 }
  return { clock, live, p: new DevPorts(() => live, () => clock.now) }
}

describe('DevPorts', () => {
  it('hands out the lowest free port and the same one again for the same key', () => {
    const { p } = ports()
    expect(p.allocate('card-a')).toBe(DEV_PORT_BASE)
    expect(p.allocate('card-b')).toBe(DEV_PORT_BASE + 1)
    expect(p.allocate('card-a')).toBe(DEV_PORT_BASE)
    expect(p.get('card-b')).toBe(DEV_PORT_BASE + 1)
    expect(p.get('nobody')).toBe(null)
  })

  it('never hands out a port a live session carries — the table being empty after a restart is not "free"', () => {
    const { p } = ports([5180, 5181, 5183])
    expect(p.allocate('new-card')).toBe(5182)
    expect(p.allocate('another')).toBe(5184)
  })

  it('a restored session keeps its port; the second holder of the same number does not', () => {
    const { p, live } = ports()
    expect(p.reserve('restored:a', 5183)).toBe(true)
    live.push(5183)
    expect(p.reserve('restored:b', 5183)).toBe(false)
    expect(p.reserve('restored:a', 5183)).toBe(true)
    expect(p.allocate('restored:b')).toBe(5180)
    expect(p.allocate('restored:a')).toBe(5183)
  })

  it('a reserved port is not handed to anyone else, even before a session carries it', () => {
    const { p } = ports()
    p.reserve('restored:a', 5180)
    p.reserve('restored:b', 5181)
    expect(p.allocate('card')).toBe(5182)
  })

  it('a promise nobody took up lapses, and the port comes back', () => {
    const { p, clock } = ports()
    expect(p.allocate('prewarm')).toBe(5180)
    clock.now += RESERVATION_TTL_MS - 1
    expect(p.allocate('card')).toBe(5181)
    clock.now += RESERVATION_TTL_MS + 1
    // 'prewarm' is old and no session has 5180: gone. 'card' is old too.
    expect(p.allocate('next')).toBe(5180)
  })

  it('a port stays taken for as long as its session lives, however old the promise', () => {
    const { p, clock, live } = ports()
    expect(p.allocate('card')).toBe(5180)
    live.push(5180)
    clock.now += 100 * RESERVATION_TTL_MS
    expect(p.allocate('other')).toBe(5181)
    expect(p.allocate('card')).toBe(5180)
    // The session ends: its port is free again once the promise has aged out.
    live.length = 0
    clock.now += RESERVATION_TTL_MS + 1
    expect(p.allocate('third')).toBe(5180)
  })

  it('release frees a promise at once', () => {
    const { p } = ports()
    expect(p.allocate('warm-up')).toBe(5180)
    expect(p.release('warm-up')).toBe(5180)
    expect(p.release('warm-up')).toBe(null)
    expect(p.allocate('card')).toBe(5180)
  })

  it('says so when the range is full, instead of doubling up', () => {
    const all = Array.from({ length: DEV_PORT_TOP - DEV_PORT_BASE + 1 }, (_, i) => DEV_PORT_BASE + i)
    const { p } = ports(all)
    expect(p.allocate('one-too-many')).toBe(null)
  })

  it('the night it happened: nine sessions on five numbers end up on nine', () => {
    const { p } = ports()
    const manifest = [5183, 5190, 5184, 5183, 5184, 5190, 5183, 5184, 5180]
    const claims = p.claimAll(manifest.map((port, i) => ({ key: `s${i}`, port })))
    const got = manifest.map((_, i) => claims.get(`s${i}`)!)
    expect(new Set(got.map((c) => c.port)).size).toBe(manifest.length)
    // The first holder of each number keeps it, and is not told anything.
    expect(got.map((c) => (c.changed ? '*' : '') + c.port)).toEqual(['5183', '5190', '5184', '*5181', '*5182', '*5185', '*5186', '*5187', '5180'])
  })

  it('a session that has to move never lands on a number a LATER session rightly holds', () => {
    const { p } = ports()
    // One pass would give the second holder of 5183 the lowest free number,
    // 5180, and then move the innocent holder of 5180 further down.
    const claims = p.claimAll([{ key: 'a', port: 5183 }, { key: 'b', port: 5183 }, { key: 'c', port: 5180 }])
    expect(claims.get('c')).toEqual({ port: 5180, changed: false })
    expect(claims.get('b')).toEqual({ port: 5181, changed: true })
  })
})

describe('devPortChangedNote', () => {
  it('names both ports, the env var, and the check that may have hit the wrong server', () => {
    const note = devPortChangedNote(5183, 5198)
    expect(note).toContain('is now 5198, not 5183')
    expect(note).toContain('CONSOLE_DEV_PORT is already 5198')
    expect(note).toContain('http://localhost:5183')
    expect(note).not.toMatch(/[—–]/)
  })

  it('does not invent a port when the range was full', () => {
    const note = devPortChangedNote(5183, null)
    expect(note).toContain('no longer have a dev-server port')
    expect(note).toContain('do not start a dev server on 5183')
  })
})
