import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseUsageBody, summariseUsage, SubscriptionUsageLedger, USAGE_URL, type UsageSample } from '../subscription-usage.js'
import { isUsageLimitError, isTransientApiError } from '../transient-errors.js'

const T0 = 1_800_000_000_000

describe('parseUsageBody', () => {
  it('records every window object carrying a utilization', () => {
    const s = parseUsageBody({
      five_hour: { utilization: 42, resets_at: '2027-01-01T00:00:00Z' },
      seven_day: { utilization: 12.5, resets_at: null },
      seven_day_oauth_apps: null,
      seven_day_opus: { utilization: 3, resets_at: 1_900_000_000 },
      extra_usage: { is_enabled: false },
    }, T0)
    expect(s).not.toBeNull()
    expect(Object.keys(s!.windows).sort()).toEqual(['five_hour', 'seven_day', 'seven_day_opus'])
    expect(s!.windows.five_hour).toEqual({ utilization: 42, resetsAt: Date.parse('2027-01-01T00:00:00Z') })
    expect(s!.windows.seven_day).toEqual({ utilization: 12.5, resetsAt: null })
    expect(s!.windows.seven_day_opus!.resetsAt).toBe(1_900_000_000_000)
  })

  it('rejects bodies without windows', () => {
    expect(parseUsageBody({ type: 'error' }, T0)).toBeNull()
    expect(parseUsageBody(null, T0)).toBeNull()
    expect(parseUsageBody('x', T0)).toBeNull()
  })
})

describe('summariseUsage', () => {
  it('peak / mean / ≥90 counts per window, honouring the since bound', () => {
    const samples: UsageSample[] = [
      { at: T0 - 10, windows: { five_hour: { utilization: 99, resetsAt: null } } }, // too old
      { at: T0, windows: { five_hour: { utilization: 50, resetsAt: null }, seven_day: { utilization: 10, resetsAt: null } } },
      { at: T0 + 1, windows: { five_hour: { utilization: 95, resetsAt: null }, seven_day: { utilization: 20, resetsAt: null } } },
    ]
    const r = summariseUsage(samples, T0)
    expect(r.five_hour).toEqual({ peak: 95, mean: 72.5, samplesAbove90: 1, samples: 2 })
    expect(r.seven_day).toEqual({ peak: 20, mean: 15, samplesAbove90: 0, samples: 2 })
  })
})

describe('SubscriptionUsageLedger.poll', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
  const mk = (fetchImpl: typeof fetch, token: string | null = 'tok') => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-')); dirs.push(dir)
    const logs: string[] = []
    const ledger = new SubscriptionUsageLedger(join(dir, 'usage.json'), {
      log: (m) => logs.push(m), fetchImpl, now: () => T0,
      readToken: () => (token ? { token, subscriptionType: 'max' } : null),
    })
    return { ledger, logs, path: join(dir, 'usage.json') }
  }

  it('records a sample on 200 and persists it', async () => {
    let seen: { url: string; auth: string | undefined } | null = null
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), auth: (init?.headers as Record<string, string>).Authorization }
      return new Response(JSON.stringify({ five_hour: { utilization: 61, resets_at: '2027-01-01T00:00:00Z' } }), { status: 200 })
    }) as unknown as typeof fetch
    const { ledger, path } = mk(f)
    const s = await ledger.poll()
    expect(seen).toEqual({ url: USAGE_URL, auth: 'Bearer tok' })
    expect(s!.windows.five_hour!.utilization).toBe(61)
    expect(ledger.latest()!.at).toBe(T0)
    expect(JSON.parse(readFileSync(path, 'utf-8')).samples).toHaveLength(1)
    expect(ledger.getState().authError).toBeNull()
  })

  it('401 is an auth error, logged once, cleared by the next 200', async () => {
    let status = 401
    const f = (async () => new Response(status === 200 ? JSON.stringify({ five_hour: { utilization: 1 } }) : '{"type":"error"}', { status })) as unknown as typeof fetch
    const { ledger, logs } = mk(f)
    await ledger.poll(); await ledger.poll()
    expect(ledger.getState().authError).toContain('401')
    expect(logs.filter((l) => l.includes('401'))).toHaveLength(1)
    status = 200
    await ledger.poll()
    expect(ledger.getState().authError).toBeNull()
    expect(logs.some((l) => l.includes('login is back'))).toBe(true)
  })

  it('no credentials file → auth error, no fetch', async () => {
    let called = 0
    const f = (async () => { called++; return new Response('{}') }) as unknown as typeof fetch
    const { ledger } = mk(f, null)
    expect(await ledger.poll()).toBeNull()
    expect(called).toBe(0)
    expect(ledger.getState().authError).toContain('no subscription login')
  })
})

describe('isUsageLimitError', () => {
  it('matches the CLI wording for subscription exhaustion', () => {
    expect(isUsageLimitError('API Error: usage limit reached')).toBe(true)
    expect(isUsageLimitError("You've hit your usage limit · resets 3pm")).toBe(true)
    expect(isUsageLimitError("You've reached your Fable limit")).toBe(true)
    expect(isUsageLimitError("You're out of usage credits. Switch to another model")).toBe(true)
  })
  it('does not match plain API rate limits or unrelated errors', () => {
    expect(isUsageLimitError('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"too many requests"}}')).toBe(false)
    expect(isUsageLimitError('API Error: 503 Service Unavailable')).toBe(false)
    expect(isUsageLimitError('max_tokens limit exceeded')).toBe(false)
    // A usage-limit message is still transient for the Continue nudge.
    expect(isTransientApiError('API Error: 429 usage limit reached')).toBe(true)
  })
})
