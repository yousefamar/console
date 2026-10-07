import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendFailover, DEFAULT_HOLD_MS, RETURN_SLACK_MS, RETURN_RETRY_MS, normaliseResetsAt, MAX_HOLD_MS } from '../backend-failover.js'
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

describe('per-model windows step down on the subscription (Yousef 3 Oct: Fable on Max, never spill for a Fable-only limit)', () => {
  function modelHarness() {
    const dir = mkdtempSync(join(tmpdir(), 'failover-model-'))
    const path = join(dir, 'backend-failover.json')
    const now = { t: T0 }
    const switches: AuthBackend[] = []
    const events: Array<{ topic: string; data: Record<string, unknown> }> = []
    const chain = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5']
    const st = { model: chain[0]! }
    const restores: string[] = []
    const make = () => new BackendFailover(path, {
      switchTo: (b) => { switches.push(b) },
      activeBackend: () => 'first_party',
      log: () => {},
      emit: (topic, data) => events.push({ topic, data }),
      now: () => now.t,
      stepDownFrom: (family) => {
        if (!st.model.includes(family)) return null
        const to = chain.find((m) => !m.includes(family))
        if (!to) return null
        const from = st.model; st.model = to
        return { from, to }
      },
      restoreModel: (model, steppedTo) => { if (st.model === steppedTo) { st.model = model; restores.push(model) } },
    })
    return { dir, path, now, switches, events, st, restores, make }
  }

  it('modelFamilyOf: seven_day_<family> is per-model; plan-wide windows are not', async () => {
    const { modelFamilyOf } = await import('../backend-failover.js')
    expect(modelFamilyOf('seven_day_opus')).toBe('opus')
    expect(modelFamilyOf('seven_day_fable')).toBe('fable')
    expect(modelFamilyOf('seven_day_overage_included')).toBeNull()
    expect(modelFamilyOf('five_hour')).toBeNull()
    expect(modelFamilyOf('seven_day')).toBeNull()
    expect(modelFamilyOf(undefined)).toBeNull()
  })

  it('a Fable-only rejection steps the hub model to Opus on Max, does NOT spill, and steps back at the reset', () => {
    const m = modelHarness()
    try {
      const f = m.make()
      f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 7200, rateLimitType: 'seven_day_fable' as never }, 'Astera general')
      expect(m.switches).toEqual([])
      expect(m.st.model).toBe('claude-opus-5-5')
      const s = f.getState()
      expect(s.active).toBeNull()
      expect(s.modelHold).toMatchObject({ family: 'fable', from: 'claude-fable-5-1', to: 'claude-opus-5-5', returnAt: T0 + 7_200_000 + RETURN_SLACK_MS })
      expect(s.modelHistory).toHaveLength(1)
      expect(m.events.map((e) => e.topic)).toEqual(['console.backend.model_stepdown'])
      f.fireModelTimerForTest()
      expect(m.st.model).toBe('claude-fable-5-1')
      expect(f.getState().modelHold).toBeNull()
      expect(f.getState().modelHistory).toHaveLength(1)
    } finally { rmSync(m.dir, { recursive: true, force: true }) }
  })

  it('the reset does not undo a model a human picked meanwhile', () => {
    const m = modelHarness()
    try {
      const f = m.make()
      f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600, rateLimitType: 'seven_day_fable' as never }, 'x')
      m.st.model = 'claude-sonnet-5'
      f.fireModelTimerForTest()
      expect(m.st.model).toBe('claude-sonnet-5')
      expect(m.restores).toEqual([])
    } finally { rmSync(m.dir, { recursive: true, force: true }) }
  })

  it('a per-model limit on a model the hub is not using is recorded but changes nothing', () => {
    const m = modelHarness()
    try {
      const f = m.make()
      f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600, rateLimitType: 'seven_day_sonnet' }, 'pinned fork')
      expect(m.st.model).toBe('claude-fable-5-1')
      expect(m.switches).toEqual([])
      expect(f.getState().modelHold).toBeNull()
      expect(f.getState().modelHistory).toHaveLength(1)
    } finally { rmSync(m.dir, { recursive: true, force: true }) }
  })

  it('plan-wide windows still spill to Bedrock', () => {
    const m = modelHarness()
    try {
      const f = m.make()
      f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600, rateLimitType: 'five_hour' }, 'x')
      expect(m.switches).toEqual(['bedrock'])
      expect(f.getState().modelHold).toBeNull()
    } finally { rmSync(m.dir, { recursive: true, force: true }) }
  })

  it('a hold survives a hub restart and is restored on boot once its reset has passed', () => {
    const m = modelHarness()
    try {
      m.make().onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 600, rateLimitType: 'seven_day_fable' as never }, 'x')
      expect(JSON.parse(readFileSync(m.path, 'utf8')).modelHold.family).toBe('fable')
      m.now.t = T0 + 3_600_000
      const f2 = m.make()
      f2.boot()
      expect(m.st.model).toBe('claude-fable-5-1')
      expect(f2.getState().modelHold).toBeNull()
    } finally { rmSync(m.dir, { recursive: true, force: true }) }
  })
})

describe('out of credits is a MODEL problem, not a plan one (2026-10-06)', () => {
  function creditHarness(opts: { active?: string; chain?: string[] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'failover-credits-'))
    const path = join(dir, 'f.json')
    const now = { t: T0 }
    const switches: AuthBackend[] = []
    const chain = opts.chain ?? ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5']
    const st = { model: opts.active ?? chain[0]! }
    const logs: string[] = []
    const make = () => new BackendFailover(path, {
      switchTo: (b) => { switches.push(b) },
      activeBackend: () => 'first_party',
      log: (m) => logs.push(m),
      now: () => now.t,
      activeModel: () => st.model,
      stepDownFrom: (family) => {
        if (!st.model.toLowerCase().includes(family)) return null
        const to = chain.find((m) => !m.toLowerCase().includes(family))
        if (!to) return null
        const from = st.model; st.model = to
        return { from, to }
      },
      restoreModel: (model, steppedTo) => { if (st.model === steppedTo) st.model = model },
    })
    return { dir, now, switches, st, logs, make }
  }

  it('steps the fleet off the metered model instead of spilling to Bedrock', () => {
    const h = creditHarness()
    try {
      const f = h.make()
      f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600, rateLimitType: 'seven_day_overage_included' }, 'Gray deer (fork)')
      expect(h.switches).toEqual([])                       // the whole point: no spill
      expect(h.st.model).toBe('claude-opus-5-5')           // stepped past Fable, still on Max
      expect(f.getState().active).toBeNull()
      expect(f.getState().modelHold).toMatchObject({ family: 'fable', to: 'claude-opus-5-5' })
    } finally { rmSync(h.dir, { recursive: true, force: true }) }
  })

  it('a PINNED session hitting its own credit wall never moves the fleet', () => {
    // hub model is flat-rate; some fork pinned to Fable tripped the limit
    const h = creditHarness({ active: 'claude-opus-5-5' })
    try {
      const f = h.make()
      f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600, rateLimitType: 'overage' }, 'Prim hare (fork)')
      expect(h.switches).toEqual([])
      expect(h.st.model).toBe('claude-opus-5-5')
      expect(f.getState().active).toBeNull()
      expect(h.logs.some((l) => l.includes('NOT spilling'))).toBe(true)
    } finally { rmSync(h.dir, { recursive: true, force: true }) }
  })

  it('spills only when the subscription has nothing left to step to', () => {
    const h = creditHarness({ chain: ['claude-fable-5-1'] })
    try {
      const f = h.make()
      f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600, rateLimitType: 'seven_day_overage_included' }, 'x')
      expect(h.switches).toEqual(['bedrock'])
      expect(f.getState().active).not.toBeNull()
    } finally { rmSync(h.dir, { recursive: true, force: true }) }
  })

  it('isOutOfCredits/modelFamilyToken: metered is an explicit list, not a guess', async () => {
    const { isOutOfCredits, modelFamilyToken } = await import('../backend-failover.js')
    expect(isOutOfCredits('overage')).toBe(true)
    expect(isOutOfCredits('seven_day_overage_included')).toBe(true)
    expect(isOutOfCredits('five_hour')).toBe(false)
    expect(isOutOfCredits('seven_day')).toBe(false)
    expect(modelFamilyToken('claude-fable-5-1')).toBe('fable')
    expect(modelFamilyToken('us.anthropic.claude-fable-5')).toBe('fable')
    expect(modelFamilyToken('claude-opus-5-5')).toBeNull()
    expect(modelFamilyToken('claude-haiku-4-5-20251001')).toBeNull()
  })
})

// 7 Oct 2026: the return onto the subscription respawned every session onto a
// dead OAuth login and they all died. The return now waits for a login check.
describe('BackendFailover return waits for the login check', () => {
  function gated(check: () => Promise<{ ok: boolean; detail?: string }>) {
    const dir = mkdtempSync(join(tmpdir(), 'failover-gate-'))
    const now = { t: T0 }
    const switches: AuthBackend[] = []
    const events: string[] = []
    const logs: string[] = []
    let active: AuthBackend = 'first_party'
    const f = new BackendFailover(join(dir, 'f.json'), {
      switchTo: (b) => { switches.push(b); active = b },
      activeBackend: () => active,
      log: (m) => logs.push(m),
      emit: (topic) => events.push(topic),
      now: () => now.t,
      canReturn: check,
    })
    f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600, rateLimitType: 'five_hour' }, 'a')
    now.t = T0 + 3_700_000
    return { dir, now, f, switches, events, logs }
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('a passing check returns the fleet as before', async () => {
    const g = gated(async () => ({ ok: true }))
    g.f.fireTimerForTest()
    await flush()
    expect(g.switches).toEqual(['bedrock', 'first_party'])
    expect(g.f.getState().active).toBeNull()
    rmSync(g.dir, { recursive: true, force: true })
  })

  it('a failing check keeps the fleet on Bedrock, leaves the episode open and re-arms', async () => {
    const g = gated(async () => ({ ok: false, detail: 'Failed to authenticate: OAuth session expired' }))
    g.f.fireTimerForTest()
    await flush()
    expect(g.switches).toEqual(['bedrock'])
    const ep = g.f.getState().active!
    expect(ep).not.toBeNull()
    expect(ep.returnAt).toBe(g.now.t + RETURN_RETRY_MS)
    expect(g.events).toContain('console.backend.return_blocked')
    expect(g.logs.some((l) => l.includes('NOT returning') && l.includes('OAuth session expired'))).toBe(true)
    rmSync(g.dir, { recursive: true, force: true })
  })

  it('a check that throws is a refusal, not a return', async () => {
    const g = gated(async () => { throw new Error('spawn ENOENT') })
    g.f.fireTimerForTest()
    await flush()
    expect(g.switches).toEqual(['bedrock'])
    expect(g.f.getState().active).not.toBeNull()
    rmSync(g.dir, { recursive: true, force: true })
  })
})
