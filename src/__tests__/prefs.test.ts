import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

const hubFetch = vi.hoisted(() => vi.fn())
vi.mock('@/hub', () => ({ hubFetch }))

import { initPrefs, isPrefsLoaded, getPref, setPref, prefsReady, __resetPrefsForTests } from '@/prefs'

/** Mock only the GET /config loads; PUTs (from setPref) always succeed. */
function mockLoads(...results: Array<Record<string, unknown> | Error>) {
  let i = 0
  hubFetch.mockImplementation((_path: string, init?: { method?: string }) => {
    if (init?.method === 'PUT') return Promise.resolve({})
    const r = results[Math.min(i++, results.length - 1)]
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r)
  })
}

const FAIL = new Error('timeout')

describe('initPrefs distinguishes "load finished" from "load succeeded"', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hubFetch.mockReset()
    __resetPrefsForTests()
  })
  afterEach(() => { vi.useRealTimers() })

  it('does NOT report loaded when the /config fetch fails', async () => {
    mockLoads(FAIL)
    void initPrefs()
    await vi.advanceTimersByTimeAsync(0)
    expect(isPrefsLoaded()).toBe(false)
    // The guard every automatic writer uses stays shut, so nothing can persist
    // a default over the real value (the 2026-09-03 calendar-visibility wipe).
    expect(getPref('calendar.visibleIds', [])).toEqual([])
  })

  it('retries and reports loaded once a later attempt succeeds', async () => {
    mockLoads(FAIL, { 'calendar.visibleIds': ['a', 'b'] })
    const done = initPrefs()
    await vi.advanceTimersByTimeAsync(2_100)
    await done
    expect(isPrefsLoaded()).toBe(true)
    expect(getPref('calendar.visibleIds', [])).toEqual(['a', 'b'])
  })

  it('prefsReady() stays pending while loads keep failing', async () => {
    mockLoads(FAIL, FAIL, FAIL)
    void initPrefs()
    let resolved = false
    void prefsReady().then(() => { resolved = true })
    await vi.advanceTimersByTimeAsync(8_000)
    expect(resolved).toBe(false)
    expect(isPrefsLoaded()).toBe(false)
  })

  it('a local write survives a retry landing afterwards', async () => {
    mockLoads(FAIL, { dnd: false, 'calendar.visibleIds': ['stale'] })
    const done = initPrefs()
    setPref('calendar.visibleIds', ['user-set'])
    await vi.advanceTimersByTimeAsync(2_100)
    await done
    expect(getPref('calendar.visibleIds', [])).toEqual(['user-set'])
    expect(getPref('dnd', true)).toBe(false)
  })

  it('is idempotent — a second initPrefs joins the in-flight load', async () => {
    mockLoads({ a: 1 })
    await Promise.all([initPrefs(), initPrefs()])
    expect(hubFetch).toHaveBeenCalledTimes(1)
  })
})
