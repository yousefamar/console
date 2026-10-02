import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendFailover, DEFAULT_HOLD_MS, RETURN_SLACK_MS, normaliseResetsAt, MAX_HOLD_MS } from '../backend-failover.js'
import type { AuthBackend } from '../auth-backend.js'

const T0 = 1_800_000_000_000

function harness(opts: { preferredOnDisk?: AuthBackend; now?: { t: number } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'failover-'))
  const path = join(dir, 'backend-failover.json')
  const now = opts.now ?? { t: T0 }
  const switches: Array<{ backend: AuthBackend; reason: string }> = []
  const events: Array<{ topic: string; data: Record<string, unknown> }> = []
  const logs: string[] = []
  let active: AuthBackend = opts.preferredOnDisk ?? 'first_party'
  const make = () => new BackendFailover(path, {
    switchTo: (b, reason) => { switches.push({ backend: b, reason }); active = b },
    activeBackend: () => active,
    log: (m) => logs.push(m),
    emit: (topic, data) => events.push({ topic, data }),
    now: () => now.t,
  })
  return { dir, path, now, switches, events, logs, make, get active() { return active }, set active(v: AuthBackend) { active = v } }
}

describe('normaliseResetsAt', () => {
  it('accepts epoch seconds and ms, rejects junk and far-future', () => {
    expect(normaliseResetsAt(T0 / 1000 + 100, T0)).toBe(T0 + 100_000)
    expect(normaliseResetsAt(T0 + 100_000, T0)).toBe(T0 + 100_000)
    expect(normaliseResetsAt(undefined, T0)).toBeNull()
    expect(normaliseResetsAt('soon', T0)).toBeNull()
    expect(normaliseResetsAt(0, T0)).toBeNull()
    expect(normaliseResetsAt((T0 + MAX_HOLD_MS + 1) / 1000, T0)).toBeNull()
  })
})

describe('BackendFailover', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => { h = harness() })
  afterEach(() => { rmSync(h.dir, { recursive: true, force: true }) })

  it('first boot adopts the on-disk backend as the standing preference', () => {
    const b = harness({ preferredOnDisk: 'bedrock' })
    try {
      const f = b.make()
      expect(f.getState().preferred).toBe('bedrock')
      // Bedrock by choice: a rejection (impossible there anyway) is a no-op.
      f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600 }, 'x')
      expect(b.switches).toEqual([])
      expect(f.getState().active).toBeNull()
    } finally { rmSync(b.dir, { recursive: true, force: true }) }
  })

  it('a rejected rate limit spills to Bedrock and records the episode', () => {
    const f = h.make()
    f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600, rateLimitType: 'five_hour' }, 'console-general')
    expect(h.switches).toEqual([{ backend: 'bedrock', reason: expect.stringContaining('five_hour') }])
    const st = f.getState()
    expect(st.active).toMatchObject({ hitAt: T0, resetsAt: T0 + 3_600_000, returnAt: T0 + 3_600_000 + RETURN_SLACK_MS, rateLimitType: 'five_hour', trippedBy: 'console-general' })
    expect(h.events[0]).toMatchObject({ topic: 'console.backend.failover', data: { to: 'bedrock', rateLimitType: 'five_hour' } })
    // Persisted
    expect(JSON.parse(readFileSync(h.path, 'utf-8')).active.trippedBy).toBe('console-general')
  })

  it('a second rejection while spilled only extends the hold, never switches again', () => {
    const f = h.make()
    f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600, rateLimitType: 'five_hour' }, 'a')
    f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 600, rateLimitType: 'five_hour' }, 'b') // earlier — ignored
    expect(f.getState().active!.returnAt).toBe(T0 + 3_600_000 + RETURN_SLACK_MS)
    f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 86_400, rateLimitType: 'seven_day' }, 'c') // later — extends
    expect(f.getState().active!.returnAt).toBe(T0 + 86_400_000 + RETURN_SLACK_MS)
    expect(f.getState().active!.rateLimitType).toBe('seven_day')
    expect(h.switches).toHaveLength(1)
    expect(h.events).toHaveLength(1)
  })

  it('no resetsAt → default hold', () => {
    const f = h.make()
    f.onRateLimit({ status: 'rejected' }, 'a', 'API Error: usage limit reached')
    expect(f.getState().active!.returnAt).toBe(T0 + DEFAULT_HOLD_MS + RETURN_SLACK_MS)
    expect(h.switches[0]!.reason).toContain('usage limit reached')
  })

  it('the timer returns the fleet to the subscription and closes the episode', () => {
    const f = h.make()
    f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600, rateLimitType: 'five_hour' }, 'a')
    h.now.t = T0 + 3_700_000
    f.fireTimerForTest()
    expect(h.switches.map((s) => s.backend)).toEqual(['bedrock', 'first_party'])
    const st = f.getState()
    expect(st.active).toBeNull()
    expect(st.history).toHaveLength(1)
    expect(st.history[0]).toMatchObject({ closedBy: 'reset', returnedAt: T0 + 3_700_000 })
    expect(h.events[1]).toMatchObject({ topic: 'console.backend.restored', data: { to: 'first_party', onBedrockMs: 3_700_000 } })
  })

  it('warnings are recorded, never switch', () => {
    const f = h.make()
    f.onRateLimit({ status: 'allowed_warning', utilization: 0.9, rateLimitType: 'five_hour', resetsAt: T0 / 1000 + 100 }, 'a')
    f.onRateLimit({ status: 'allowed' }, 'a')
    expect(h.switches).toEqual([])
    expect(f.getState().lastWarning).toMatchObject({ utilization: 0.9, rateLimitType: 'five_hour' })
  })

  it('a manual choice closes an open spill and disarms the return', () => {
    const f = h.make()
    f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600 }, 'a')
    f.setPreferred('bedrock')
    const st = f.getState()
    expect(st.preferred).toBe('bedrock')
    expect(st.active).toBeNull()
    expect(st.history[0]!.closedBy).toBe('manual')
    f.fireTimerForTest() // nothing armed
    expect(h.switches).toHaveLength(1) // only the spill itself; the manual set is applied by the caller
  })

  it('boot re-arms a persisted episode, or returns at once when the reset is past', () => {
    const f = h.make()
    f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600 }, 'a')
    // Hub restart before the reset: re-armed, still on Bedrock.
    const f2 = h.make()
    f2.boot()
    expect(f2.getState().active).not.toBeNull()
    expect(h.switches).toHaveLength(1)
    // Hub restart after the reset: return immediately.
    h.now.t = T0 + 4 * 3_600_000
    const f3 = h.make()
    f3.boot()
    expect(h.switches.map((s) => s.backend)).toEqual(['bedrock', 'first_party'])
    expect(f3.getState().active).toBeNull()
    expect(existsSync(h.path)).toBe(true)
  })

  it('does not call switchTo when settings.json is already on the target', () => {
    const f = h.make()
    h.active = 'bedrock' // someone already flipped the file
    f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600 }, 'a')
    expect(h.switches).toEqual([])
    expect(f.getState().active).not.toBeNull() // the episode is still tracked
  })
})
