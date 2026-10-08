import { describe, it, expect, beforeEach } from 'vitest'
import {
  resolveCompactWindow, DEFAULT_COMPACT_WINDOW, COMPACT_WINDOW_MIN, COMPACT_WINDOW_MAX,
  isThrashing, liftCompactWindow, isCompactWindowLifted, clearLiftedCompactWindows,
  THRASH_COMPACTIONS, THRASH_WINDOW_MS,
} from '../agents/compact-window.js'

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

describe('a window the session cannot work in is lifted', () => {
  beforeEach(() => { clearLiftedCompactWindows() })

  it('calls it thrashing only at THRASH_COMPACTIONS inside the window', () => {
    const now = 1_000_000
    const recent = (n: number) => Array.from({ length: n }, (_, i) => now - i * 1000)
    expect(isThrashing(recent(THRASH_COMPACTIONS - 1), now)).toBe(false)
    expect(isThrashing(recent(THRASH_COMPACTIONS), now)).toBe(true)
    expect(isThrashing([], now)).toBe(false)
  })

  it('ignores compactions older than the window — a long session compacts normally', () => {
    const now = 1_000_000
    const old = Array.from({ length: 10 }, (_, i) => now - THRASH_WINDOW_MS - i * 1000)
    expect(isThrashing(old, now)).toBe(false)
    expect(isThrashing([...old, now, now - 1000], now)).toBe(false)
  })

  it('lifts by cwd, so the next fork in that directory never pays for it', () => {
    const cwd = '/home/amar/proj/code/console/android'
    expect(resolveCompactWindow('fork', undefined, cwd)).toEqual({ window: 400_000, reason: 'default' })
    expect(liftCompactWindow(cwd)).toBe(true)
    expect(isCompactWindowLifted(cwd)).toBe(true)
    expect(resolveCompactWindow('fork', undefined, cwd)).toEqual({ window: null, reason: 'thrash' })
    expect(resolveCompactWindow('cronFork', undefined, cwd)).toEqual({ window: null, reason: 'thrash' })
    // Other directories keep the cap — only the thrashing bundle is exempt.
    expect(resolveCompactWindow('fork', undefined, '/home/amar/sync/brain/root/projects/astera')).toEqual({ window: 400_000, reason: 'default' })
    expect(resolveCompactWindow('fork', undefined)).toEqual({ window: 400_000, reason: 'default' })
  })

  it('beats an explicit pref too — a cap that thrashes costs more than it saves', () => {
    const cwd = '/tmp/heavy'
    liftCompactWindow(cwd)
    expect(resolveCompactWindow('fork', { fork: 200_000 }, cwd)).toEqual({ window: null, reason: 'thrash' })
  })

  it('reports whether the lift was new, so it is logged once per cwd', () => {
    expect(liftCompactWindow('/a')).toBe(true)
    expect(liftCompactWindow('/a')).toBe(false)
    expect(liftCompactWindow('')).toBe(false)
    expect(isCompactWindowLifted(null)).toBe(false)
    expect(isCompactWindowLifted(undefined)).toBe(false)
  })
})
