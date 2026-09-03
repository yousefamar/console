import { describe, it, expect } from 'vitest'
import { makeRebuildScheduler } from '@/inbox/rebuild-scheduler'

/** Deterministic timer harness: `tick(ms)` advances a fake clock and fires
 *  timers whose deadline has passed, in order. */
function harness() {
  let now = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  let seq = 0
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: (id: unknown) => { timers.delete(id as number) },
    tick(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at
        timers.delete(due[0])
        due[1].fn()
      }
      now = target
    },
  }
}

describe('makeRebuildScheduler', () => {
  it('runs once after the debounce when writes stop', () => {
    const h = harness()
    let runs = 0
    const s = makeRebuildScheduler(() => runs++, { debounceMs: 300, maxWaitMs: 1000, ...h })
    s.schedule(); h.tick(100); s.schedule(); h.tick(100); s.schedule()
    expect(runs).toBe(0)
    h.tick(299); expect(runs).toBe(0)
    h.tick(1); expect(runs).toBe(1)
    expect(s.pending()).toBe(false)
  })

  it('a stream of writes faster than the debounce cannot starve it past maxWait', () => {
    const h = harness()
    let runs = 0
    const s = makeRebuildScheduler(() => runs++, { debounceMs: 300, maxWaitMs: 1000, ...h })
    // Write every 200 ms for 3 s — a plain trailing debounce would never fire.
    for (let t = 0; t < 3000; t += 200) { s.schedule(); h.tick(200) }
    expect(runs).toBeGreaterThanOrEqual(2)
    expect(runs).toBeLessThanOrEqual(4)
  })

  it('the ceiling counts from the FIRST pending request, not the latest', () => {
    const h = harness()
    const fired: number[] = []
    const s = makeRebuildScheduler(() => fired.push(h.now()), { debounceMs: 300, maxWaitMs: 1000, ...h })
    s.schedule()
    for (let t = 0; t < 900; t += 100) { h.tick(100); s.schedule() }
    // Last schedule at t=900 would want t=1200; the ceiling forces t=1000.
    h.tick(100)
    expect(fired).toEqual([1000])
  })

  it('after firing, the next request starts a fresh window', () => {
    const h = harness()
    const fired: number[] = []
    const s = makeRebuildScheduler(() => fired.push(h.now()), { debounceMs: 300, maxWaitMs: 1000, ...h })
    s.schedule(); h.tick(300)
    s.schedule(); h.tick(300)
    expect(fired).toEqual([300, 600])
  })
})
