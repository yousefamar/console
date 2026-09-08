import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCacheTtl, CacheTtlLedger } from '../agents/cache-ttl.js'

const MIN = 60_000
const base = { recentMs: 30 * MIN, now: 1_000_000 * MIN }

describe('resolveCacheTtl', () => {
  it('a pin wins over everything, including a hibernation wake', () => {
    expect(resolveCacheTtl({ ...base, pin: '1h', wake: true })).toEqual({ ttl: '1h', reason: 'pinned' })
    expect(resolveCacheTtl({ ...base, pin: '5m', midTurn: true })).toEqual({ ttl: '5m', reason: 'pinned' })
  })

  it('a hibernation wake is 5m even though sendMessage already stamped activity + midTurn', () => {
    expect(resolveCacheTtl({ ...base, wake: true, midTurn: true, everActive: true, lastActivityAt: base.now })).toEqual({ ttl: '5m', reason: 'woken' })
  })

  it('an unfinished turn (restart resume of a wasRunning session, live midTurn, running) is 1h', () => {
    expect(resolveCacheTtl({ ...base, midTurn: true })).toEqual({ ttl: '1h', reason: 'mid-turn' })
  })

  it('a brand-new session is 5m — no history to justify the 2× write rate', () => {
    expect(resolveCacheTtl({ ...base, everActive: false, lastActivityAt: base.now })).toEqual({ ttl: '5m', reason: 'fresh' })
  })

  it('a respawn of a recently-active session keeps 1h; idle longer than N minutes drops to 5m', () => {
    expect(resolveCacheTtl({ ...base, everActive: true, lastActivityAt: base.now - 10 * MIN })).toEqual({ ttl: '1h', reason: 'recent' })
    expect(resolveCacheTtl({ ...base, everActive: true, lastActivityAt: base.now - 31 * MIN })).toEqual({ ttl: '5m', reason: 'idle' })
  })

  it('N is a knob: recentMs = 0 means only pins / mid-turn ever get 1h', () => {
    expect(resolveCacheTtl({ ...base, recentMs: 0, everActive: true, lastActivityAt: base.now })).toEqual({ ttl: '5m', reason: 'idle' })
  })
})

describe('CacheTtlLedger', () => {
  const at = (iso: string) => () => Date.parse(iso)

  it('splits writes by TTL class from the CLI usage and counts spawns per day', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ttl-ledger-'))
    const ledger = new CacheTtlLedger(join(dir, 'l.json'), at('2026-09-08T12:00:00Z'))
    ledger.recordSpawn('1h'); ledger.recordSpawn('5m'); ledger.recordSpawn('5m')
    ledger.recordUsage({ cache_creation_input_tokens: 500, cache_read_input_tokens: 40, cache_creation: { ephemeral_1h_input_tokens: 300, ephemeral_5m_input_tokens: 200 } })
    // Older CLI: no split → all 5m.
    ledger.recordUsage({ cache_creation_input_tokens: 100, cache_read_input_tokens: 10 })
    const s = ledger.summary(2)
    expect(s.days[0]).toEqual({ day: '2026-09-08', written1h: 300, written5m: 300, read: 50, spawns1h: 1, spawns5m: 2 })
    expect(s.days[1]).toEqual({ day: '2026-09-07', written1h: 0, written5m: 0, read: 0, spawns1h: 0, spawns5m: 0 })
    expect(s.totals).toEqual({ written1h: 300, written5m: 300, read: 50, spawns1h: 1, spawns5m: 2 })
  })

  it('persists atomically and reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ttl-ledger-'))
    const file = join(dir, 'l.json')
    const a = new CacheTtlLedger(file, at('2026-09-08T12:00:00Z'))
    a.recordSpawn('1h')
    a.flush()
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf-8')).days['2026-09-08'].spawns1h).toBe(1)
    const b = new CacheTtlLedger(file, at('2026-09-08T18:00:00Z'))
    b.recordSpawn('1h')
    expect(b.summary(1).totals.spawns1h).toBe(2)
  })

  it('a corrupt file starts an empty ledger instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ttl-ledger-'))
    const file = join(dir, 'l.json')
    writeFileSync(file, '{not json')
    const l = new CacheTtlLedger(file, at('2026-09-08T12:00:00Z'))
    expect(l.summary(1).totals.spawns1h).toBe(0)
  })
})
