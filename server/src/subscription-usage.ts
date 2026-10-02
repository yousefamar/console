// ============================================================================
// Claude Max usage ledger — samples the subscription's rate-limit windows.
//
// "How many subscriptions do I need?" is answered by utilisation over time,
// not by the count of failovers alone: a fleet that sits at 95 % of the 5 h
// window all day is one incident away from Bedrock even when it never trips.
// The CLI itself reads `https://api.anthropic.com/api/oauth/usage` with the
// OAuth access token from `~/.claude/.credentials.json` (the /usage command);
// the hub does the same on a timer and keeps a rolling ledger.
//
// Deliberately NO token refresh here: the `claude` processes refresh and
// rewrite the credentials file themselves; the hub only ever reads it. A 401
// means nobody is logged in (or the refresh token died) — recorded as
// `authError`, polled at a slower cadence, cleared on the next 200.
// ============================================================================

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export interface UsageWindow {
  /** 0..100, as the API reports it. */
  utilization: number
  /** Epoch ms, null when the API gave none. */
  resetsAt: number | null
}

export interface UsageSample {
  at: number
  windows: Record<string, UsageWindow>
}

export interface UsageLedgerState {
  samples: UsageSample[]
  authError: string | null
  lastError: string | null
  lastOkAt: number | null
}

export const USAGE_POLL_MS = 10 * 60_000
export const USAGE_POLL_UNAUTHED_MS = 30 * 60_000
/** 14 days at the normal cadence. */
const SAMPLE_CAP = 14 * 24 * 6

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

export function credentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json')
}

/** The Max OAuth access token, or null when there is no subscription login. */
export function readOAuthToken(path = credentialsPath()): { token: string; subscriptionType?: string } | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { claudeAiOauth?: { accessToken?: string; subscriptionType?: string } }
    const o = raw.claudeAiOauth
    if (!o?.accessToken) return null
    return { token: o.accessToken, subscriptionType: o.subscriptionType }
  } catch {
    return null
  }
}

/** Pure: turn the API body into a sample. Every top-level object carrying a
 *  numeric `utilization` is a window (five_hour, seven_day, seven_day_opus, …) —
 *  shape-tolerant so a new window the API adds is recorded, not dropped. */
export function parseUsageBody(body: unknown, at: number): UsageSample | null {
  if (!body || typeof body !== 'object') return null
  const windows: Record<string, UsageWindow> = {}
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const w = v as { utilization?: unknown; resets_at?: unknown }
    if (typeof w.utilization !== 'number') continue
    let resetsAt: number | null = null
    if (typeof w.resets_at === 'string') {
      const t = Date.parse(w.resets_at)
      resetsAt = Number.isFinite(t) ? t : null
    } else if (typeof w.resets_at === 'number') {
      resetsAt = w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at
    }
    windows[k] = { utilization: w.utilization, resetsAt }
  }
  if (Object.keys(windows).length === 0) return null
  return { at, windows }
}

/** Pure: summary stats over the ledger for the CLI. */
export function summariseUsage(samples: UsageSample[], sinceMs: number): Record<string, { peak: number; mean: number; samplesAbove90: number; samples: number }> {
  const out: Record<string, { peak: number; sum: number; samplesAbove90: number; samples: number }> = {}
  for (const s of samples) {
    if (s.at < sinceMs) continue
    for (const [k, w] of Object.entries(s.windows)) {
      const o = out[k] ?? (out[k] = { peak: 0, sum: 0, samplesAbove90: 0, samples: 0 })
      o.peak = Math.max(o.peak, w.utilization)
      o.sum += w.utilization
      o.samples++
      if (w.utilization >= 90) o.samplesAbove90++
    }
  }
  const res: Record<string, { peak: number; mean: number; samplesAbove90: number; samples: number }> = {}
  for (const [k, o] of Object.entries(out)) res[k] = { peak: o.peak, mean: o.samples ? o.sum / o.samples : 0, samplesAbove90: o.samplesAbove90, samples: o.samples }
  return res
}

export interface UsageLedgerDeps {
  log: (msg: string) => void
  fetchImpl?: typeof fetch
  readToken?: () => { token: string; subscriptionType?: string } | null
  now?: () => number
}

export class SubscriptionUsageLedger {
  private state: UsageLedgerState = { samples: [], authError: null, lastError: null, lastOkAt: null }
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly readToken: () => { token: string; subscriptionType?: string } | null

  constructor(private readonly path: string, private readonly deps: UsageLedgerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.readToken = deps.readToken ?? (() => readOAuthToken())
    this.load()
  }

  getState(): UsageLedgerState {
    return { ...this.state, samples: [...this.state.samples] }
  }

  latest(): UsageSample | null {
    return this.state.samples[this.state.samples.length - 1] ?? null
  }

  start(): void {
    void this.tick()
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  /** One poll. Returns the sample recorded, if any. */
  async poll(): Promise<UsageSample | null> {
    const cred = this.readToken()
    if (!cred) {
      this.setAuthError('no subscription login in ~/.claude/.credentials.json')
      return null
    }
    try {
      const res = await this.fetchImpl(USAGE_URL, {
        headers: { Authorization: `Bearer ${cred.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 401 || res.status === 403) {
        this.setAuthError(`HTTP ${res.status} from the usage endpoint — run \`claude auth login\``)
        return null
      }
      if (!res.ok) {
        this.state.lastError = `HTTP ${res.status}`
        this.save()
        return null
      }
      const sample = parseUsageBody(await res.json(), this.now())
      if (!sample) {
        this.state.lastError = 'usage body carried no windows'
        this.save()
        return null
      }
      if (this.state.authError) this.deps.log(`[usage] subscription login is back (${cred.subscriptionType ?? 'unknown tier'})`)
      this.state.authError = null
      this.state.lastError = null
      this.state.lastOkAt = sample.at
      this.state.samples.push(sample)
      if (this.state.samples.length > SAMPLE_CAP) this.state.samples.splice(0, this.state.samples.length - SAMPLE_CAP)
      this.save()
      return sample
    } catch (e) {
      this.state.lastError = (e as Error).message
      this.save()
      return null
    }
  }

  private setAuthError(msg: string): void {
    if (this.state.authError !== msg) {
      this.deps.log(`[usage] ${msg}`)
      this.state.authError = msg
      this.save()
    }
  }

  private async tick(): Promise<void> {
    await this.poll()
    const wait = this.state.authError ? USAGE_POLL_UNAUTHED_MS : USAGE_POLL_MS
    this.timer = setTimeout(() => { this.timer = null; void this.tick() }, wait)
    this.timer.unref?.()
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<UsageLedgerState>
      this.state = {
        samples: Array.isArray(raw.samples) ? raw.samples : [],
        authError: raw.authError ?? null,
        lastError: raw.lastError ?? null,
        lastOkAt: raw.lastOkAt ?? null,
      }
    } catch { /* fresh ledger */ }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state))
      renameSync(tmp, this.path)
    } catch (e) {
      this.deps.log(`[usage] save failed: ${(e as Error).message}`)
    }
  }
}
