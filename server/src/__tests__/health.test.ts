import { describe, it, expect, vi } from 'vitest'
import { HealthMonitor } from '../health.js'
import type { PushMessage } from '../push.js'

function make(threshold = 3, realertEvery = 20) {
  const pushes: PushMessage[] = []
  const logs: string[] = []
  const mon = new HealthMonitor((m) => pushes.push(m), (m) => logs.push(m), threshold, realertEvery)
  return { mon, pushes, logs }
}

describe('HealthMonitor', () => {
  it('stays silent below the failure threshold', () => {
    const { mon, pushes } = make()
    mon.reportFailure('mail-sync', 'boom')
    mon.reportFailure('mail-sync', 'boom')
    expect(pushes).toHaveLength(0)
  })

  it('alerts exactly once when crossing the threshold', () => {
    const { mon, pushes } = make()
    for (let i = 0; i < 5; i++) mon.reportFailure('mail-sync', 'ECONNRESET')
    expect(pushes).toHaveLength(1)
    expect(pushes[0].id).toBe('health:mail-sync')
    expect(pushes[0].title).toContain('mail-sync failing')
    expect(pushes[0].body).toContain('3 consecutive failures')
    expect(pushes[0].body).toContain('ECONNRESET')
  })

  it('re-alerts every realertEvery further failures while still down', () => {
    const { mon, pushes } = make(3, 20)
    for (let i = 0; i < 3 + 20; i++) mon.reportFailure('mail-sync', 'boom')
    expect(pushes).toHaveLength(2)
    expect(pushes[1].body).toContain('23 consecutive failures')
  })

  it('pushes a recovery notice and resets after success', () => {
    const { mon, pushes } = make()
    for (let i = 0; i < 4; i++) mon.reportFailure('cal-sync', 'boom')
    mon.reportSuccess('cal-sync')
    expect(pushes).toHaveLength(2)
    expect(pushes[1].title).toContain('cal-sync recovered')
    // A fresh failure run must count from zero again.
    mon.reportFailure('cal-sync', 'boom')
    mon.reportFailure('cal-sync', 'boom')
    expect(pushes).toHaveLength(2)
    mon.reportFailure('cal-sync', 'boom')
    expect(pushes).toHaveLength(3)
  })

  it('does not push a recovery notice for a loop that never alerted', () => {
    const { mon, pushes } = make()
    mon.reportFailure('flight-sync', 'boom')
    mon.reportSuccess('flight-sync')
    expect(pushes).toHaveLength(0)
  })

  it('tracks loops independently', () => {
    const { mon, pushes } = make()
    mon.reportFailure('mail-sync', 'a')
    mon.reportFailure('mail-sync', 'a')
    mon.reportFailure('cal-sync', 'b')
    mon.reportFailure('cal-sync', 'b')
    expect(pushes).toHaveLength(0)
    mon.reportFailure('mail-sync', 'a')
    expect(pushes).toHaveLength(1)
    expect(pushes[0].id).toBe('health:mail-sync')
  })

  it('exposes state via snapshot()', () => {
    const { mon } = make()
    mon.reportFailure('mail-sync', 'boom')
    mon.reportSuccess('cal-sync')
    const snap = Object.fromEntries(mon.snapshot().map((l) => [l.name, l]))
    expect(snap['mail-sync'].consecutiveFailures).toBe(1)
    expect(snap['mail-sync'].lastError).toBe('boom')
    expect(snap['cal-sync'].consecutiveFailures).toBe(0)
    expect(snap['cal-sync'].lastOkAt).toBeTypeOf('number')
  })

  it('survives a throwing notify sink', () => {
    const logs: string[] = []
    const mon = new HealthMonitor(() => { throw new Error('push down') }, (m) => logs.push(m), 1)
    expect(() => mon.reportFailure('mail-sync', 'boom')).not.toThrow()
    expect(logs.some((l) => l.includes('notify failed'))).toBe(true)
  })
})

describe('health singleton', () => {
  it('queues alerts fired before bindHealthNotify and flushes them on bind', async () => {
    vi.resetModules()
    const fresh = await import('../health.js')
    for (let i = 0; i < 3; i++) fresh.health.reportFailure('boot-loop', 'early failure')
    const pushes: PushMessage[] = []
    fresh.bindHealthNotify((m) => pushes.push(m))
    expect(pushes).toHaveLength(1)
    expect(pushes[0].id).toBe('health:boot-loop')
    // Post-bind alerts go straight through.
    fresh.health.reportSuccess('boot-loop')
    expect(pushes).toHaveLength(2)
    expect(pushes[1].title).toContain('recovered')
  })
})
