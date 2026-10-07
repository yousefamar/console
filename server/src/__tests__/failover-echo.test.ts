import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendFailover, DEFAULT_HOLD_MS, RETURN_SLACK_MS, ECHO_WINDOW_MS } from '../backend-failover.js'
import { usageLimitTypeOf } from '../transient-errors.js'
import type { AuthBackend } from '../auth-backend.js'

// session.ts's text fallback emits a typeless `rejected` for an API-error
// message that trails the structured rate_limit_event of the same turn. On 3
// and 5 Oct 2026 that echo stretched three five_hour spills from the real
// reset to the 5 h default hold (7.5 extra fleet-hours on Bedrock), and since
// 06c13c16 it would spill the fleet for a Fable-pinned session's credit wall.

const T0 = 1_800_000_000_000
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function harness(model = 'claude-opus-5-5') {
  const dir = mkdtempSync(join(tmpdir(), 'failover-echo-'))
  dirs.push(dir)
  const now = { t: T0 }
  const switches: AuthBackend[] = []
  const logs: string[] = []
  let active: AuthBackend = 'first_party'
  const st = { model }
  const f = new BackendFailover(join(dir, 'f.json'), {
    switchTo: (b) => { switches.push(b); active = b },
    activeBackend: () => active,
    log: (m) => logs.push(m),
    now: () => now.t,
    activeModel: () => st.model,
    stepDownFrom: (family) => {
      if (!st.model.toLowerCase().includes(family)) return null
      const from = st.model; st.model = 'claude-opus-5-5'
      return { from, to: st.model }
    },
  })
  return { f, now, switches, logs, st }
}

describe('untyped rejection echoes', () => {
  it('an echo right after a five_hour spill keeps the real reset, not the 5 h default', () => {
    const h = harness()
    h.f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 2940, rateLimitType: 'five_hour' }, 'Astera general')
    h.f.onRateLimit({ status: 'rejected' }, 'Astera general', "API Error: You've hit your session limit")
    expect(h.f.getState().active!.returnAt).toBe(T0 + 2_940_000 + RETURN_SLACK_MS)
    expect(h.switches).toEqual(['bedrock'])
  })

  it('an untyped rejection from ANOTHER session still cannot stretch a known reset', () => {
    const h = harness()
    h.f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 2940, rateLimitType: 'five_hour' }, 'a')
    h.f.onRateLimit({ status: 'rejected' }, 'b', 'usage limit reached')
    expect(h.f.getState().active!.returnAt).toBe(T0 + 2_940_000 + RETURN_SLACK_MS)
  })

  it('a known reset replaces a guessed hold, even when sooner', () => {
    const h = harness()
    h.f.onRateLimit({ status: 'rejected' }, 'a', 'usage limit reached')
    expect(h.f.getState().active!.returnAt).toBe(T0 + DEFAULT_HOLD_MS + RETURN_SLACK_MS)
    h.f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 1800, rateLimitType: 'five_hour' }, 'b')
    expect(h.f.getState().active).toMatchObject({ resetsAt: T0 + 1_800_000, returnAt: T0 + 1_800_000 + RETURN_SLACK_MS, rateLimitType: 'five_hour' })
  })

  it("a Fable-pinned session's credit wall plus its text echo never spills the fleet", () => {
    const h = harness('claude-opus-5-5')
    h.f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600, rateLimitType: 'seven_day_overage_included' }, 'Prim hare (fork)')
    const text = "API Error: You're out of usage credits. Switch to another model"
    h.f.onRateLimit({ status: 'rejected', rateLimitType: usageLimitTypeOf(text) }, 'Prim hare (fork)', text)
    expect(h.switches).toEqual([])
    expect(h.f.getState().active).toBeNull()
  })

  it('the echo window is per session and expires', () => {
    const h = harness()
    h.f.onRateLimit({ status: 'rejected', resetsAt: T0 / 1000 + 3600, rateLimitType: 'seven_day_overage_included' }, 'x')
    expect(h.switches).toEqual([])
    h.now.t = T0 + ECHO_WINDOW_MS + 1
    h.f.onRateLimit({ status: 'rejected' }, 'x', 'usage limit reached')
    expect(h.switches).toEqual(['bedrock']) // a genuinely new, unexplained limit still spills
  })
})

describe('usageLimitTypeOf', () => {
  it('types credit wording as overage and leaves plan wording untyped', () => {
    expect(usageLimitTypeOf("You're out of usage credits. Switch to another model")).toBe('overage')
    expect(usageLimitTypeOf('You are out of extra usage')).toBe('overage')
    expect(usageLimitTypeOf("You've hit your session limit · resets 9pm")).toBeUndefined()
  })
})
