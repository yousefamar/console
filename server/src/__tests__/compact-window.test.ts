import { describe, it, expect } from 'vitest'
import { resolveCompactWindow, DEFAULT_COMPACT_WINDOW, COMPACT_WINDOW_MIN, COMPACT_WINDOW_MAX } from '../agents/compact-window.js'

describe('resolveCompactWindow', () => {
  it('caps throwaway forks at 400k and leaves generals / chat forks on the CLI default', () => {
    expect(resolveCompactWindow('fork', undefined)).toEqual({ window: 400_000, reason: 'default' })
    expect(resolveCompactWindow('cronFork', undefined)).toEqual({ window: 400_000, reason: 'default' })
    expect(resolveCompactWindow('listenerFork', undefined)).toEqual({ window: 400_000, reason: 'default' })
    expect(resolveCompactWindow('default', undefined)).toEqual({ window: null, reason: 'default' })
    expect(resolveCompactWindow('chatFork', undefined)).toEqual({ window: null, reason: 'default' })
    expect(resolveCompactWindow(undefined, undefined)).toEqual({ window: null, reason: 'default' })
  })

  it('the pref overrides per kind; 0 or null means the CLI default; values clamp to the CLI range', () => {
    expect(resolveCompactWindow('default', { default: 600_000 })).toEqual({ window: 600_000, reason: 'pref' })
    expect(resolveCompactWindow('fork', { fork: 0 })).toEqual({ window: null, reason: 'pref' })
    expect(resolveCompactWindow('fork', { fork: null })).toEqual({ window: null, reason: 'pref' })
    expect(resolveCompactWindow('fork', { fork: 50_000 }).window).toBe(COMPACT_WINDOW_MIN)
    expect(resolveCompactWindow('fork', { fork: 5_000_000 }).window).toBe(COMPACT_WINDOW_MAX)
  })

  it('ignores junk pref shapes', () => {
    expect(resolveCompactWindow('fork', 'big')).toEqual({ window: DEFAULT_COMPACT_WINDOW.fork, reason: 'default' })
    expect(resolveCompactWindow('fork', { fork: 'huge' })).toEqual({ window: 400_000, reason: 'default' })
  })
})
