import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isAuthFailure, AuthFailureWatch, describeAuthAlert, type AuthFailureAlert, type AuthFailureReport } from '../agents/auth-failure.js'

describe('isAuthFailure', () => {
  it('takes the CLI\'s structured verdict', () => {
    expect(isAuthFailure('authentication_failed', 'anything at all')).toBe(true)
  })

  it('recognises the words when the field is missing or renamed', () => {
    // Verbatim from the 9 Oct 2026 forge transcripts.
    expect(isAuthFailure(undefined, 'Not logged in · Please run /login')).toBe(true)
    expect(isAuthFailure(null, 'Invalid API key · Please run /login')).toBe(true)
    expect(isAuthFailure(undefined, 'OAuth token has expired · Please run /login')).toBe(true)
  })

  it('recognises a Bedrock identity that is missing or stale', () => {
    expect(isAuthFailure(undefined, 'API Error: Could not load credentials from any providers')).toBe(true)
    expect(isAuthFailure(undefined, 'API Error: 403 The security token included in the request is expired')).toBe(true)
    expect(isAuthFailure(undefined, 'API Error: ExpiredTokenException: token expired')).toBe(true)
  })

  it('is not fooled by quota, model, transient or ordinary errors', () => {
    for (const text of [
      'API Error: 429 rate_limit_error',
      "You're out of usage credits. Switch to another model…",
      'API Error: 503 overloaded',
      'API Error: 400 The provided model identifier is invalid',
      'API Error: 403 Model access is denied',
      'Claude usage limit reached. Your limit will reset at 3am.',
      'No response requested.',
    ]) expect(isAuthFailure(undefined, text), text).toBe(false)
    // An unrelated structured error code is not an auth failure either.
    expect(isAuthFailure('rate_limit', 'slow down')).toBe(false)
  })

  it('does not fire on an agent merely TALKING about logging in', () => {
    // Only synthetic CLI messages reach it, but keep the patterns anchored anyway.
    expect(isAuthFailure(undefined, 'The fork said it was not logged in, so I checked the box.')).toBe(false)
    expect(isAuthFailure(undefined, 'Docs: to switch accounts you can/please run /logout first.')).toBe(false)
  })
})

describe('AuthFailureWatch', () => {
  let alerts: AuthFailureAlert[]
  let watch: AuthFailureWatch
  const fork = (n: number, over: Partial<AuthFailureReport> = {}): AuthFailureReport =>
    ({ sessionId: `s${n}`, name: `Fork ${n}`, placement: 'forge', backend: 'bedrock', detail: 'Not logged in · Please run /login', at: Date.now(), ...over })

  beforeEach(() => {
    vi.useFakeTimers()
    alerts = []
    watch = new AuthFailureWatch({ onAlert: (a) => alerts.push(a), windowMs: 20_000, cooldownMs: 600_000 })
  })
  afterEach(() => { watch.stop(); vi.useRealTimers() })

  it('turns twenty-one failing forks into ONE alert', () => {
    // The incident: every forge fork failed within seconds of the restart.
    for (let i = 1; i <= 21; i++) { watch.report(fork(i)); vi.advanceTimersByTime(500) }
    expect(alerts).toHaveLength(0)            // still gathering
    vi.advanceTimersByTime(20_000)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ count: 21, forge: 21, local: 0, failingNow: 21, backends: ['bedrock'] })
    expect(alerts[0]!.names[0]).toBe('Fork 1')
  })

  it('does not alert again for a session that just keeps failing', () => {
    watch.report(fork(1))
    vi.advanceTimersByTime(20_000)
    for (let i = 0; i < 10; i++) { watch.report(fork(1)); vi.advanceTimersByTime(120_000) }
    expect(alerts).toHaveLength(1)
  })

  it('holds a NEW failure during the cooldown and raises it when the cooldown ends', () => {
    watch.report(fork(1))
    vi.advanceTimersByTime(20_000)
    expect(alerts).toHaveLength(1)
    vi.advanceTimersByTime(60_000)
    watch.report(fork(2, { placement: 'local', backend: 'first_party' }))
    vi.advanceTimersByTime(60_000)
    expect(alerts).toHaveLength(1)            // inside the cooldown: held, not dropped
    vi.advanceTimersByTime(600_000)
    expect(alerts).toHaveLength(2)
    expect(alerts[1]).toMatchObject({ count: 1, forge: 0, local: 1, failingNow: 2, names: ['Fork 2'] })
  })

  it('forgets a session that answered for real before the window closed', () => {
    watch.report(fork(1))
    watch.recovered('s1')
    vi.advanceTimersByTime(60_000)
    expect(alerts).toHaveLength(0)
    expect(watch.failing()).toEqual([])
  })

  it('alerts afresh when a recovered session fails again', () => {
    watch.report(fork(1))
    vi.advanceTimersByTime(20_000)
    watch.recovered('s1')
    vi.advanceTimersByTime(700_000)
    watch.report(fork(1))
    vi.advanceTimersByTime(20_000)
    expect(alerts).toHaveLength(2)
  })

  it('keeps the re-send list: who is failing right now, oldest first', () => {
    watch.report(fork(2, { at: 2000 }))
    watch.report(fork(1, { at: 1000 }))
    watch.report(fork(3, { at: 3000 }))
    watch.recovered('s2')
    expect(watch.failing().map((r) => r.name)).toEqual(['Fork 1', 'Fork 3'])
  })
})

describe('describeAuthAlert', () => {
  const base: AuthFailureAlert = { count: 21, forge: 21, local: 0, names: ['Lime elk', 'Gray moth', 'Wise heron', 'Neat colt', 'Teal moth'], backends: ['bedrock'], detail: 'Not logged in · Please run /login', firstAt: 0, failingNow: 21 }

  it('says where the sessions run, which is the first thing the reader needs', () => {
    const { title, body } = describeAuthAlert(base)
    expect(title).toBe('21 agents cannot log in')
    expect(body).toContain('all on forge, started on bedrock')
    expect(body).toContain('"Not logged in · Please run /login"')
    expect(body).toContain('Lime elk, Gray moth, Wise heron, Neat colt +1 more')
    expect(body).toContain('its instructions were not acted on')
  })

  it('handles a mixed fleet and a single session', () => {
    expect(describeAuthAlert({ ...base, count: 5, forge: 2, local: 3, backends: ['bedrock', 'first_party'] }).body).toContain('2 on forge, 3 local, started on bedrock / first_party')
    expect(describeAuthAlert({ ...base, count: 1, forge: 0, local: 1, names: ['Console general'] }).title).toBe('An agent cannot log in')
  })
})
