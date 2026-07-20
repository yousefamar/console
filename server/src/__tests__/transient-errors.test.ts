import { describe, it, expect } from 'vitest'
import { isTransientApiError, RESUME_BACKOFF_MS, MAX_AUTO_RESUMES_PER_HOUR } from '../transient-errors.js'

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
