// Conservative rate limiter for geocaching.com requests.
//
// Yousef's hard requirement: scraping must be SAFE. So every gc.com request goes
// through this single gate:
//   • concurrency 1 (one in-flight request at a time, globally)
//   • jittered minimum delay between requests (human-paced)
//   • a persisted per-day request budget that hard-stops when exhausted
//
// HTTP 429 backoff (honouring `x-rate-limit-reset`) lives in session.ts; this
// module is the proactive gate that keeps us well under any limit in the first
// place. Fetches are MANUAL-only (no background gc.com polling), so the budget
// is rarely touched.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export class RateLimitExceededError extends Error {
  constructor(public used: number, public cap: number) {
    super(`Daily geocaching.com request budget exhausted (${used}/${cap}). Try again tomorrow.`)
    this.name = 'RateLimitExceededError'
  }
}

interface BudgetState {
  date: string // 'YYYY-MM-DD' (local)
  count: number
}

export interface RateLimiterOptions {
  minDelayMs?: number
  maxDelayMs?: number
  dailyCap?: number
  budgetFile: string
}

function today(): string {
  // Local date — the budget resets at local midnight.
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class RateLimiter {
  private chain: Promise<unknown> = Promise.resolve()
  private lastAt = 0
  private readonly minDelayMs: number
  private readonly maxDelayMs: number
  private readonly dailyCap: number
  private readonly budgetFile: string

  constructor(opts: RateLimiterOptions) {
    this.minDelayMs = opts.minDelayMs ?? 3000
    this.maxDelayMs = opts.maxDelayMs ?? 6000
    this.dailyCap = opts.dailyCap ?? 400
    this.budgetFile = opts.budgetFile
  }

  /** Run `fn` once it's this request's turn, after the budget + delay gate. */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      this.consumeBudget()
      await this.delay()
      return fn()
    })
    // Keep the chain alive even if this task throws.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  budgetStatus(): { used: number; cap: number; remaining: number } {
    const state = this.loadBudget()
    const used = state.date === today() ? state.count : 0
    return { used, cap: this.dailyCap, remaining: Math.max(0, this.dailyCap - used) }
  }

  private async delay(): Promise<void> {
    const wait = this.minDelayMs + Math.floor(jitter() * (this.maxDelayMs - this.minDelayMs))
    const since = Date.now() - this.lastAt
    if (since < wait) await sleep(wait - since)
    this.lastAt = Date.now()
  }

  private consumeBudget(): void {
    const state = this.loadBudget()
    const t = today()
    if (state.date !== t) {
      state.date = t
      state.count = 0
    }
    if (state.count >= this.dailyCap) throw new RateLimitExceededError(state.count, this.dailyCap)
    state.count += 1
    this.saveBudget(state)
  }

  private loadBudget(): BudgetState {
    try {
      if (existsSync(this.budgetFile)) {
        return JSON.parse(readFileSync(this.budgetFile, 'utf8')) as BudgetState
      }
    } catch {
      // fall through to fresh state
    }
    return { date: today(), count: 0 }
  }

  private saveBudget(state: BudgetState): void {
    mkdirSync(dirname(this.budgetFile), { recursive: true })
    const tmp = `${this.budgetFile}.tmp`
    writeFileSync(tmp, JSON.stringify(state), 'utf8')
    renameSync(tmp, this.budgetFile)
  }
}

// Deterministic-enough jitter without Math.random (kept simple + testable).
let jitterSeed = 0x2545f491
function jitter(): number {
  jitterSeed = (jitterSeed * 1103515245 + 12345) & 0x7fffffff
  return jitterSeed / 0x7fffffff
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
