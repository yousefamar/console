// ============================================================================
// Loop-health monitor.
//
// Background loops (mail, calendar, matrix, flights) catch their own tick
// errors and log to pm2 — which nobody reads. So a loop can die in place for
// days without anyone noticing (the phone-camera Syncthing folder sat broken
// for weeks exactly this way). This escalates a run of consecutive failures to
// a push notification, and pushes a recovery notice when it comes back.
//
// Usage from a loop: `import { health } from './health.js'`, then
// `health.reportSuccess('<name>')` after a good tick and
// `health.reportFailure('<name>', String(e))` in the catch. Nothing else.
//
// The notify sink is bound LATE (`bindHealthNotify` from index.ts, after the
// PushServer exists) because loops import this module at load time. Alerts
// raised before the bind queue up and flush on bind.
// ============================================================================

import type { PushMessage } from './push.js'

export interface LoopHealth {
  name: string
  consecutiveFailures: number
  lastError?: string
  lastFailureAt?: number
  lastOkAt?: number
  /** Set when the alert push has been sent; cleared on recovery. */
  alertedAt?: number
}

export class HealthMonitor {
  private readonly loops = new Map<string, LoopHealth>()

  constructor(
    private readonly notify: (msg: PushMessage) => void,
    private readonly log: (m: string) => void = () => {},
    private readonly threshold = 3,
    private readonly realertEvery = 20,
  ) {}

  private loop(name: string): LoopHealth {
    let l = this.loops.get(name)
    if (!l) {
      l = { name, consecutiveFailures: 0 }
      this.loops.set(name, l)
    }
    return l
  }

  reportSuccess(name: string): void {
    const l = this.loop(name)
    l.lastOkAt = Date.now()
    if (l.alertedAt) {
      const downFor = l.consecutiveFailures
      this.push({
        type: 'generic',
        id: `health:${name}`,
        title: `${name} recovered`,
        body: `Back to normal after ${downFor} consecutive failure${downFor === 1 ? '' : 's'}.`,
      })
      this.log(`[health] ${name} recovered after ${downFor} failures`)
    }
    l.consecutiveFailures = 0
    delete l.alertedAt
    delete l.lastError
  }

  reportFailure(name: string, detail: string): void {
    const l = this.loop(name)
    l.consecutiveFailures++
    l.lastError = detail
    l.lastFailureAt = Date.now()
    const n = l.consecutiveFailures
    const shouldAlert = n === this.threshold ||
      (n > this.threshold && (n - this.threshold) % this.realertEvery === 0)
    if (shouldAlert) {
      l.alertedAt = Date.now()
      this.push({
        type: 'generic',
        id: `health:${name}`,
        title: `${name} failing`,
        body: `${n} consecutive failures. Last error: ${detail}`,
      })
      this.log(`[health] ALERT ${name}: ${n} consecutive failures (${detail})`)
    }
  }

  snapshot(): LoopHealth[] {
    return [...this.loops.values()].map((l) => ({ ...l }))
  }

  private push(msg: PushMessage): void {
    try {
      this.notify(msg)
    } catch (e) {
      // The monitor must never take a loop down with it.
      this.log(`[health] notify failed: ${(e as Error).message}`)
    }
  }
}

let boundNotify: ((msg: PushMessage) => void) | null = null
let boundLog: ((m: string) => void) | null = null
const pendingAlerts: PushMessage[] = []

export function bindHealthNotify(notify: (msg: PushMessage) => void, log?: (m: string) => void): void {
  boundNotify = notify
  if (log) boundLog = log
  while (pendingAlerts.length > 0) {
    const msg = pendingAlerts.shift()!
    try {
      notify(msg)
    } catch (e) {
      boundLog?.(`[health] deferred notify failed: ${(e as Error).message}`)
    }
  }
}

export const health = new HealthMonitor(
  (msg) => {
    if (boundNotify) boundNotify(msg)
    else pendingAlerts.push(msg)
  },
  (m) => boundLog?.(m),
)
