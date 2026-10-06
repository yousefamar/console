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

/** A MODEL-scoped window ran out (e.g. `seven_day_opus`, or a Fable one): the
 *  fleet steps down to the next model on the SAME subscription instead of
 *  spilling to Bedrock, and steps back up when that window resets. */
export interface ModelHold {
  /** model family the window covers (`opus`, `sonnet`, `fable`, …) */
  family: string
  /** the hub model when it tripped, and the one stepped down to */
  from: string
  to: string
  hitAt: number
  resetsAt: number | null
  returnAt: number
  rateLimitType: string
  trippedBy?: string
  returnedAt?: number
}

export interface FailoverState {
  preferred: AuthBackend
  active: FailoverEpisode | null
  history: FailoverEpisode[]
  lastWarning: UsageWarning | null
  modelHold: ModelHold | null
  /** every model-scoped limit hit — the per-model half of the usage ledger */
  modelHistory: ModelHold[]
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
  /** Step the hub model past `family` on the current backend. Returns the
   *  models stepped from/to, or null when the active model is not in that
   *  family (a pinned session hit it) or nothing else is left in the chain. */
  stepDownFrom?: (family: string, reason: string) => { from: string; to: string } | null
  /** Put the hub model back to `model` — only if it is still `steppedTo`
   *  (a human may have picked something else meanwhile). */
  restoreModel?: (model: string, steppedTo: string, reason: string) => void
  /** The model the fleet is currently spawning with, so an out-of-credits
   *  rejection can tell "the hub model is metered" from "a pinned session is". */
  activeModel?: () => string
}

/** `seven_day_<family>` is a per-model window; the plan-wide ones are
 *  five_hour / seven_day / seven_day_overage_included / overage. */
export function modelFamilyOf(rateLimitType: string | undefined): string | null {
  if (!rateLimitType) return null
  const m = /^seven_day_([a-z0-9]+)$/.exec(rateLimitType)
  if (!m || m[1] === 'overage_included') return null
  return m[1]!
}

/** Which credit-metered family a model id belongs to, or null when it is a
 *  flat-rate model. Only Fable is metered on a Max plan today (2026-10);
 *  keep this list explicit rather than guessing from the id, so a new model
 *  defaults to "flat rate, do not step past it". */
const METERED_FAMILIES = ['fable'] as const
export function modelFamilyToken(model: string): string | null {
  const m = model.toLowerCase()
  return METERED_FAMILIES.find((f) => m.includes(f)) ?? null
}

/** An out-of-CREDITS rejection (`overage`, `seven_day_overage_included`) is a
 *  MODEL problem wearing a plan-shaped label: a credit-metered model (Fable on
 *  a Max plan) has spent its own allowance while every flat-rate model on the
 *  same subscription still answers. Treating it as plan exhaustion spilled the
 *  whole fleet to pay-per-token Bedrock for five days on 2026-10-06 while
 *  probes showed opus-5-5 and haiku fine — so step the hub model past the
 *  metered one and only spill if nothing on the subscription works. */
export function isOutOfCredits(rateLimitType: string | undefined): boolean {
  return rateLimitType === 'overage' || rateLimitType === 'seven_day_overage_included'
}

/** `resetsAt` arrives in epoch seconds from the CLI; be tolerant of ms too. */
export function normaliseResetsAt(v: unknown, now: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null
  const ms = v < 1e12 ? v * 1000 : v
  if (ms - now > MAX_HOLD_MS) return null
  return ms
}

export class BackendFailover {
  private state: FailoverState = { preferred: 'first_party', active: null, history: [], lastWarning: null, modelHold: null, modelHistory: [] }
  private timer: ReturnType<typeof setTimeout> | null = null
  private modelTimer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number

  constructor(private readonly path: string, private readonly deps: FailoverDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.load()
  }

  getState(): FailoverState {
    return { ...this.state, history: [...this.state.history], modelHistory: [...this.state.modelHistory] }
  }

  /** Re-arm (or settle) a persisted episode after a hub restart. Also adopts
   *  the on-disk backend as `preferred` when nothing was ever recorded, so a
   *  fleet that was manually on Bedrock before this module existed stays there. */
  boot(): void {
    const mh = this.state.modelHold
    if (mh) {
      if (mh.returnAt <= this.now()) this.restoreModelHold('window reset while the hub was down')
      else this.armModel(mh.returnAt)
    }
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
    const family = modelFamilyOf(info.rateLimitType)
    if (family && this.deps.stepDownFrom) {
      this.onModelLimit(family, info.rateLimitType!, resetsAt, returnAt, now, from)
      return
    }
    // Out of credits for the ACTIVE model: step past it on this subscription.
    // `stepDownFrom` returns null when the hub model is not the metered one —
    // i.e. a session PINNED to it tripped this, and one pinned session must
    // never move the whole fleet onto pay-per-token. Only a step that finds
    // nothing left falls through to the spill below.
    if (isOutOfCredits(info.rateLimitType) && this.deps.stepDownFrom) {
      const active = this.deps.activeModel?.()
      const metered = active ? modelFamilyToken(active) : null
      if (metered) {
        const stepped = this.onModelLimit(metered, info.rateLimitType!, resetsAt, returnAt, now, from)
        if (stepped) return
      } else {
        this.deps.log(`[failover] ${info.rateLimitType} hit by ${from ?? 'a session'} but the hub model is not metered — a pinned session; NOT spilling the fleet`)
        return
      }
    }
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

  /** A per-model window is exhausted: stay on the subscription, step the hub
   *  model down past that family, and step back up when it resets. */
  private onModelLimit(family: string, rateLimitType: string, resetsAt: number | null, returnAt: number, now: number, from?: string): boolean {
    const held = this.state.modelHold
    if (held && held.family === family) {
      if (returnAt > held.returnAt) { held.returnAt = returnAt; held.resetsAt = resetsAt; this.armModel(returnAt); this.save() }
      return true
    }
    const why = `${rateLimitType} limit hit by ${from ?? 'a session'}`
    const step = this.deps.stepDownFrom!(family, why)
    const hold: ModelHold = { family, from: step?.from ?? '', to: step?.to ?? '', hitAt: now, resetsAt, returnAt, rateLimitType, trippedBy: from }
    this.state.modelHistory.push(hold)
    if (this.state.modelHistory.length > HISTORY_CAP) this.state.modelHistory.splice(0, this.state.modelHistory.length - HISTORY_CAP)
    if (!step) {
      this.deps.log(`[failover] ${why} — the hub model is not ${family} (a pinned session?); nothing stepped down`)
      this.save()
      return false
    }
    this.state.modelHold = hold
    this.armModel(returnAt)
    this.save()
    this.deps.log(`[failover] ${why} — stepped down ${step.from} → ${step.to} on the same subscription until ${new Date(returnAt).toISOString()}`)
    this.deps.emit?.('console.backend.model_stepdown', { family, from: step.from, to: step.to, rateLimitType, resetsAt, returnAt, trippedBy: from ?? null }, `stepdown:${now}`)
    return true
  }

  private restoreModelHold(reason: string): void {
    const mh = this.state.modelHold
    if (!mh) return
    mh.returnedAt = this.now()
    this.state.modelHold = null
    this.disarmModel()
    this.save()
    if (mh.from) this.deps.restoreModel?.(mh.from, mh.to, reason)
    this.deps.log(`[failover] ${mh.rateLimitType} window reset — back to ${mh.from || 'the chain head'}`)
    this.deps.emit?.('console.backend.model_restored', { family: mh.family, to: mh.from, rateLimitType: mh.rateLimitType }, `model-restored:${mh.hitAt}`)
  }

  private armModel(at: number): void {
    this.disarmModel()
    const wait = Math.max(0, Math.min(at - this.now(), 0x7fffffff))
    this.modelTimer = setTimeout(() => { this.modelTimer = null; this.restoreModelHold('window reset') }, wait)
    this.modelTimer.unref?.()
  }

  private disarmModel(): void {
    if (this.modelTimer) { clearTimeout(this.modelTimer); this.modelTimer = null }
  }

  /** Test hook: fire the model-hold return timer now. */
  fireModelTimerForTest(): void {
    if (!this.modelTimer) return
    this.disarmModel()
    this.restoreModelHold('window reset')
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
        modelHold: raw.modelHold ?? null,
        modelHistory: Array.isArray(raw.modelHistory) ? raw.modelHistory : [],
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
