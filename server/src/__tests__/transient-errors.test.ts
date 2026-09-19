import { describe, it, expect } from 'vitest'
import {
  isTransientApiError, isUpstreamOutageError, UpstreamOutageTracker,
  RESUME_BACKOFF_MS, MAX_AUTO_RESUMES_PER_HOUR,
  OUTAGE_MIN_FAILURES, OUTAGE_MIN_SPAN_MS, OUTAGE_WINDOW_MS, OUTAGE_ADVANCE_COOLDOWN_MS,
} from '../transient-errors.js'

describe('isTransientApiError', () => {
  it('matches rate-limit shapes', () => {
    expect(isTransientApiError('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}')).toBe(true)
    expect(isTransientApiError('Too many requests, please wait before trying again.')).toBe(true)
    expect(isTransientApiError('Too many tokens, please wait before trying again.')).toBe(true)
    expect(isTransientApiError('ThrottlingException: Rate exceeded')).toBe(true)
  })

  it('matches overloaded / unavailable shapes', () => {
    expect(isTransientApiError('API Error: 529 overloaded_error')).toBe(true)
    expect(isTransientApiError('503 Service Unavailable')).toBe(true)
    expect(isTransientApiError('Bedrock is unable to process your request')).toBe(true)
  })

  it('matches network-flavour transients (timeouts, resets)', () => {
    expect(isTransientApiError('API Error: The operation timed out.')).toBe(true) // seen live 2026-07-28
    expect(isTransientApiError('Request timeout')).toBe(true)
    expect(isTransientApiError('read ECONNRESET')).toBe(true)
    expect(isTransientApiError('socket hang up')).toBe(true)
    expect(isTransientApiError('TypeError: fetch failed')).toBe(true)
    expect(isTransientApiError('API Error: Unable to connect to API (ConnectionRefused)')).toBe(true)
  })

  it('matches server-error shapes (seen live 2026-08-15)', () => {
    expect(isTransientApiError('API Error: 503 Bedrock is unable to process your request. This is a server-side issue, usually temporary — try again in a moment.')).toBe(true)
    expect(isTransientApiError('API Error: Server error mid-response. The response above may be incomplete.')).toBe(true)
    expect(isTransientApiError('500 Internal Server Error')).toBe(true)
    expect(isTransientApiError('502 Bad Gateway')).toBe(true)
  })

  it('does NOT match model-unavailable errors (those advance the fallback chain)', () => {
    expect(isTransientApiError('The provided model identifier is invalid')).toBe(false)
    expect(isTransientApiError('model not found: claude-fable-5')).toBe(false)
    expect(isTransientApiError('404 no such model')).toBe(false)
  })

  it('does NOT match ordinary errors', () => {
    expect(isTransientApiError('TypeError: cannot read properties of undefined')).toBe(false)
    expect(isTransientApiError('Credit balance is too low')).toBe(false)
  })
})

const BEDROCK_503 = 'API Error: 503 Bedrock is unable to process your request. This is a server-side issue, usually temporary — try again in a moment.'

describe('isUpstreamOutageError', () => {
  it('matches the model-capacity class (503 / 529 / overloaded / Bedrock unable)', () => {
    expect(isUpstreamOutageError(BEDROCK_503)).toBe(true)
    expect(isUpstreamOutageError('ServiceUnavailableException: Bedrock is unable to process your request')).toBe(true)
    expect(isUpstreamOutageError('API Error: 529 overloaded_error')).toBe(true)
    expect(isUpstreamOutageError('503 Service Unavailable')).toBe(true)
  })

  it('is a strict subset of isTransientApiError', () => {
    for (const t of [BEDROCK_503, 'API Error: 529 overloaded_error', '503 Service Unavailable']) {
      expect(isTransientApiError(t), t).toBe(true)
    }
  })

  it('ignores rate limits, network errors and gateway 5xx — none of those indict the model', () => {
    expect(isUpstreamOutageError('API Error: 429 rate_limit_error')).toBe(false)
    expect(isUpstreamOutageError('ThrottlingException: Rate exceeded')).toBe(false)
    expect(isUpstreamOutageError('API Error: The operation timed out.')).toBe(false)
    expect(isUpstreamOutageError('read ECONNRESET')).toBe(false)
    expect(isUpstreamOutageError('TypeError: fetch failed')).toBe(false)
    expect(isUpstreamOutageError('500 Internal Server Error')).toBe(false)
    expect(isUpstreamOutageError('502 Bad Gateway')).toBe(false)
    expect(isUpstreamOutageError('API Error: Server error mid-response. The response above may be incomplete.')).toBe(false)
  })
})

describe('UpstreamOutageTracker', () => {
  const MIN = 60_000
  const M = 'us.anthropic.claude-fable-5-1'
  function tracker(start = 1_000_000) {
    let t = start
    const tr = new UpstreamOutageTracker(() => t)
    return { tr, at: (ms: number) => { t = start + ms } }
  }

  it('one lone session: fires on the third retry of the backoff schedule (~4 min), not before', () => {
    const { tr, at } = tracker()
    at(0); expect(tr.recordFailure(M)).toBeNull()
    at(RESUME_BACKOFF_MS[0]); expect(tr.recordFailure(M)).toBeNull()
    at(RESUME_BACKOFF_MS[0] + RESUME_BACKOFF_MS[1])
    expect(tr.recordFailure(M)).toMatch(/3 upstream failures over 4\.0 min vs 0 successes/)
  })

  it('a simultaneous burst from many sessions is a blip, not an outage', () => {
    const { tr, at } = tracker()
    at(0)
    for (let i = 0; i < 10; i++) expect(tr.recordFailure(M)).toBeNull()
    at(30_000)
    for (let i = 0; i < 10; i++) expect(tr.recordFailure(M)).toBeNull()
    // ...but the same fleet still failing two minutes later is.
    at(OUTAGE_MIN_SPAN_MS)
    expect(tr.recordFailure(M)).not.toBeNull()
  })

  it('a model that mostly succeeds never trips, however busy the fleet', () => {
    const { tr, at } = tracker()
    at(0); tr.recordFailure(M)
    for (let i = 1; i <= 8; i++) { at(i * 30_000); tr.recordSuccess(M) }
    at(5 * MIN); expect(tr.recordFailure(M)).toBeNull()
    at(8 * MIN); expect(tr.recordFailure(M)).toBeNull() // 3 fails vs 8 oks
  })

  it('a flapping model trips only once it fails more than twice as often as it succeeds', () => {
    const { tr, at } = tracker()
    at(0); tr.recordFailure(M); tr.recordFailure(M)
    at(MIN); tr.recordSuccess(M)
    at(2 * MIN); tr.recordSuccess(M)
    at(3 * MIN); expect(tr.recordFailure(M)).toBeNull() // 3 vs 2
    at(4 * MIN); expect(tr.recordFailure(M)).toBeNull() // 4 vs 2
    at(5 * MIN); expect(tr.recordFailure(M)).toMatch(/5 upstream failures over 5\.0 min vs 2 successes/)
  })

  it('successes before the streak began do not shield it', () => {
    const { tr, at } = tracker()
    for (let i = 0; i < 50; i++) { at(i * 1000); tr.recordSuccess(M) }
    at(MIN); tr.recordFailure(M)
    at(2 * MIN); tr.recordFailure(M)
    at(3 * MIN + OUTAGE_MIN_SPAN_MS); expect(tr.recordFailure(M)).not.toBeNull()
  })

  it('failures are tracked per model — siblings stay clean', () => {
    const { tr, at } = tracker()
    at(0); tr.recordFailure(M); tr.recordFailure('other')
    at(MIN); tr.recordFailure(M)
    at(3 * MIN); expect(tr.recordFailure(M)).not.toBeNull()
    at(4 * MIN); expect(tr.recordFailure('other')).toBeNull()
  })

  it('failures outside the window fall away', () => {
    const { tr, at } = tracker()
    at(0); tr.recordFailure(M)
    at(MIN); tr.recordFailure(M)
    at(OUTAGE_WINDOW_MS + 2 * MIN); expect(tr.recordFailure(M)).toBeNull()
  })

  it('firing clears the streak; the cooldown stops a cascade down the chain', () => {
    const { tr, at } = tracker()
    at(0); tr.recordFailure(M)
    at(MIN); tr.recordFailure(M)
    at(3 * MIN); expect(tr.recordFailure(M)).not.toBeNull()
    // Fleet moves to the next model, which turns out to be failing too.
    const N = 'us.anthropic.claude-fable-5'
    at(4 * MIN); tr.recordFailure(N)
    at(5 * MIN); tr.recordFailure(N)
    at(7 * MIN); expect(tr.recordFailure(N)).toBeNull() // held: cooldown
    at(3 * MIN + OUTAGE_ADVANCE_COOLDOWN_MS); expect(tr.recordFailure(N)).not.toBeNull()
  })

  it('a held streak is not lost — it fires the moment the cooldown ends', () => {
    const { tr, at } = tracker()
    at(0); tr.recordFailure(M); at(MIN); tr.recordFailure(M); at(3 * MIN); tr.recordFailure(M)
    const N = 'next'
    at(4 * MIN); tr.recordFailure(N); at(5 * MIN); tr.recordFailure(N); at(7 * MIN); tr.recordFailure(N)
    at(3 * MIN + OUTAGE_ADVANCE_COOLDOWN_MS)
    expect(tr.recordFailure(N)).toMatch(/4 upstream failures/)
  })

  it('ignores an empty model id', () => {
    const { tr } = tracker()
    for (let i = 0; i < 10; i++) expect(tr.recordFailure('')).toBeNull()
  })

  it('thresholds are sane', () => {
    expect(OUTAGE_MIN_FAILURES).toBeGreaterThanOrEqual(3)
    expect(OUTAGE_MIN_SPAN_MS).toBeGreaterThan(RESUME_BACKOFF_MS[0])
    expect(OUTAGE_MIN_SPAN_MS).toBeLessThan(RESUME_BACKOFF_MS[0] + RESUME_BACKOFF_MS[1])
    expect(OUTAGE_WINDOW_MS).toBeGreaterThan(OUTAGE_MIN_SPAN_MS)
  })
})

describe('policy constants', () => {
  it('backoff grows monotonically', () => {
    for (let i = 1; i < RESUME_BACKOFF_MS.length; i++) {
      expect(RESUME_BACKOFF_MS[i]).toBeGreaterThan(RESUME_BACKOFF_MS[i - 1])
    }
  })
  it('hourly cap is sane', () => {
    expect(MAX_AUTO_RESUMES_PER_HOUR).toBeGreaterThan(0)
    expect(MAX_AUTO_RESUMES_PER_HOUR).toBeLessThanOrEqual(12)
  })
})
