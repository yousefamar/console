// ============================================================================
// Backend failover — Claude Max subscription first, Amazon Bedrock as backup.
//
// Why: the AWS credits are running out (Oct 2026), so the fleet should run on
// the fixed-cost Max subscription and spill onto pay-per-token Bedrock ONLY
// while a subscription window (5 h / weekly) is exhausted. Each spill is
// recorded, because how often and for how long the fleet sits on Bedrock is
// exactly the number that says how many subscriptions are needed.
//
// Mechanics: a first-party `claude` emits `rate_limit_event` whenever the
// unified rate-limit headers change; `status: rejected` carries `resetsAt`.
// Session surfaces that as a 'rate_limit' event → `onRateLimit` here switches
// the fleet to Bedrock (routes/agents.ts applyBackendSwitch — env rewrite +
// chain swap + respawn), persists the open episode, and arms a timer that
// switches back once the window has reset. The episode survives a hub
// restart (`boot()` re-arms or returns immediately if the reset is past).
//
// `preferred` is the human's choice (`con agent backend set …`): failover
// only ever runs while preferred === 'first_party', and a manual set closes
// any open episode — a human picking Bedrock is not a failover.
// ============================================================================

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AuthBackend } from './auth-backend.js'
import type { ClaudeRateLimitInfo } from './protocol.js'

export interface FailoverEpisode {
  /** When the first `rejected` landed. */
  hitAt: number
  /** Epoch ms the binding window resets (null when the CLI gave none). */
  resetsAt: number | null
  /** When the fleet is due back on the subscription (resetsAt + slack, or the default hold). */
  returnAt: number
  rateLimitType?: string
  /** Which session tripped it (name or id). */
  trippedBy?: string
  /** Set when the episode closed. */
  returnedAt?: number
  /** 'reset' = timer fired, 'manual' = `con agent backend set` closed it. */
  closedBy?: 'reset' | 'manual'
}

export interface UsageWarning {
  at: number
  utilization?: number
  rateLimitType?: string
  resetsAt: number | null
}

export interface FailoverState {
  preferred: AuthBackend
  active: FailoverEpisode | null
  history: FailoverEpisode[]
  lastWarning: UsageWarning | null
}

/** No resetsAt on the rejection → hold on Bedrock this long before trying the
 *  subscription again (the shortest window is 5 h). */
export const DEFAULT_HOLD_MS = 5 * 3_600_000
/** Return a little after the reset so the first turn back doesn't race it. */
export const RETURN_SLACK_MS = 60_000
/** A `resetsAt` further out than this is treated as "unknown" (a bogus header
 *  must not park the fleet on Bedrock for a month). */
export const MAX_HOLD_MS = 8 * 24 * 3_600_000
const HISTORY_CAP = 100

export interface FailoverDeps {
  /** Perform the fleet switch (env + chain + respawn). */
  switchTo: (backend: AuthBackend, reason: string) => void
  /** What settings.json currently says — the ground truth `claude` reads. */
  activeBackend: () => AuthBackend
  log: (msg: string) => void
  emit?: (topic: string, data: Record<string, unknown>, key?: string) => void
  now?: () => number
}

/** `resetsAt` arrives in epoch seconds from the CLI; be tolerant of ms too. */
export function normaliseResetsAt(v: unknown, now: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null
  const ms = v < 1e12 ? v * 1000 : v
  if (ms - now > MAX_HOLD_MS) return null
  return ms
}

export class BackendFailover {
  private state: FailoverState = { preferred: 'first_party', active: null, history: [], lastWarning: null }
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number

  constructor(private readonly path: string, private readonly deps: FailoverDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.load()
  }

  getState(): FailoverState {
    return { ...this.state, history: [...this.state.history] }
  }

  /** Re-arm (or settle) a persisted episode after a hub restart. Also adopts
   *  the on-disk backend as `preferred` when nothing was ever recorded, so a
   *  fleet that was manually on Bedrock before this module existed stays there. */
  boot(): void {
    const ep = this.state.active
    if (!ep) return
    if (this.state.preferred !== 'first_party') { this.closeEpisode('manual'); return }
    if (ep.returnAt <= this.now()) {
      this.deps.log(`[failover] reset passed while the hub was down — returning to the subscription`)
      this.returnToPreferred()
    } else {
      this.arm(ep.returnAt)
      this.deps.log(`[failover] re-armed: back on the subscription at ${new Date(ep.returnAt).toISOString()}`)
    }
  }

  /** The human picked a backend. Closes any open episode — a manual choice is
   *  never a failover, and the timer must not flip them back later. */
  setPreferred(backend: AuthBackend): void {
    this.state.preferred = backend
    if (this.state.active) this.closeEpisode('manual')
    this.save()
  }

  /** A first-party session reported its rate-limit headers. */
  onRateLimit(info: ClaudeRateLimitInfo, from?: string, detail?: string): void {
    const now = this.now()
    const resetsAt = normaliseResetsAt(info.resetsAt ?? info.unifiedWindows?.[info.rateLimitType as 'five_hour' | 'seven_day']?.resetsAt, now)
    if (info.status !== 'rejected') {
      if (info.status === 'allowed_warning') {
        this.state.lastWarning = { at: now, utilization: info.utilization, rateLimitType: info.rateLimitType, resetsAt }
        this.save()
      }
      return
    }
    if (this.state.preferred !== 'first_party') return // Bedrock by choice — nothing to fail over from
    const returnAt = (resetsAt ?? now + DEFAULT_HOLD_MS) + RETURN_SLACK_MS
    const ep = this.state.active
    if (ep) {
      // Already spilled (e.g. the 5 h window tripped, now the weekly one) —
      // only ever push the return later, never earlier.
      if (returnAt > ep.returnAt) {
        ep.returnAt = returnAt
        ep.resetsAt = resetsAt
        if (info.rateLimitType) ep.rateLimitType = info.rateLimitType
        this.arm(returnAt)
        this.save()
        this.deps.log(`[failover] hold extended to ${new Date(returnAt).toISOString()} (${info.rateLimitType ?? 'unknown window'})`)
      }
      return
    }
    this.state.active = { hitAt: now, resetsAt, returnAt, rateLimitType: info.rateLimitType, trippedBy: from }
    this.save()
    const why = `subscription limit${info.rateLimitType ? ` (${info.rateLimitType})` : ''} hit by ${from ?? 'a session'}${detail ? `: ${detail}` : ''}`
    this.deps.log(`[failover] ${why} — spilling to Bedrock until ${new Date(returnAt).toISOString()}`)
    if (this.deps.activeBackend() !== 'bedrock') this.deps.switchTo('bedrock', why)
    this.arm(returnAt)
    this.deps.emit?.('console.backend.failover', {
      to: 'bedrock', rateLimitType: info.rateLimitType ?? null, resetsAt, returnAt, trippedBy: from ?? null,
    }, `failover:${now}`)
  }

  /** The window reset — back onto the subscription. */
  private returnToPreferred(): void {
    const ep = this.state.active
    if (!ep) return
    const onBedrockMs = this.now() - ep.hitAt
    this.closeEpisode('reset')
    this.deps.log(`[failover] subscription window reset — returning after ${(onBedrockMs / 60_000).toFixed(0)} min on Bedrock`)
    if (this.deps.activeBackend() !== 'first_party') this.deps.switchTo('first_party', 'subscription window reset')
    this.deps.emit?.('console.backend.restored', {
      to: 'first_party', onBedrockMs, rateLimitType: ep.rateLimitType ?? null,
    }, `restored:${ep.hitAt}`)
  }

  private closeEpisode(by: 'reset' | 'manual'): void {
    const ep = this.state.active
    if (!ep) return
    ep.returnedAt = this.now()
    ep.closedBy = by
    this.state.history.push(ep)
    if (this.state.history.length > HISTORY_CAP) this.state.history.splice(0, this.state.history.length - HISTORY_CAP)
    this.state.active = null
    this.disarm()
    this.save()
  }

  private arm(at: number): void {
    this.disarm()
    const wait = Math.max(0, Math.min(at - this.now(), 0x7fffffff))
    this.timer = setTimeout(() => { this.timer = null; this.returnToPreferred() }, wait)
    this.timer.unref?.()
  }

  private disarm(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  /** Test hook: fire the return timer now. */
  fireTimerForTest(): void {
    if (!this.timer) return
    this.disarm()
    this.returnToPreferred()
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<FailoverState>
      this.state = {
        preferred: raw.preferred === 'bedrock' ? 'bedrock' : 'first_party',
        active: raw.active ?? null,
        history: Array.isArray(raw.history) ? raw.history : [],
        lastWarning: raw.lastWarning ?? null,
      }
    } catch {
      // First boot: whatever settings.json says IS the human's standing choice.
      this.state.preferred = this.deps.activeBackend()
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.path)
    } catch (e) {
      this.deps.log(`[failover] save failed: ${(e as Error).message}`)
    }
  }
}
