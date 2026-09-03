import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Module-scope localStorage reads in the calendar store's import graph.
vi.hoisted(() => {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  }
})

const hubFetch = vi.hoisted(() => vi.fn())
vi.mock('@/hub', () => ({ hubFetch, getHubUrl: () => 'http://localhost' }))

/** PUT (a setPref write) always succeeds; GET /config returns `prefs` or throws. */
function mockHub(prefs: Record<string, unknown> | Error) {
  hubFetch.mockImplementation((_path: string, init?: { method?: string }) => {
    if (init?.method === 'PUT') return Promise.resolve({})
    return prefs instanceof Error ? Promise.reject(prefs) : Promise.resolve(prefs)
  })
}

const putCount = () =>
  hubFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string } | undefined)?.method === 'PUT').length

import { useCalendarStore } from '@/store/calendar'
import { initPrefs, getPref, __resetPrefsForTests } from '@/prefs'
import type { CalendarInfo } from '@/calendar/types'

const VISIBLE = 'calendar.visibleIds'
const OVERLAY = { id: 'meetup', summary: 'Meetup', accountEmail: 'meetup', accessRole: 'reader', synthetic: true } as unknown as CalendarInfo
const REAL_IDS = ['a@group.calendar.google.com', 'b@group.calendar.google.com']

async function loadPrefs(prefs: Record<string, unknown>) {
  __resetPrefsForTests()
  mockHub(prefs)
  await initPrefs()
}

describe('registerOverlaySource cannot shrink the persisted visibility set', () => {
  beforeEach(() => {
    useCalendarStore.setState({ visibleCalendarIds: new Set(), overlaySources: {}, calendars: [] })
  })

  it('unions the persisted ids when the store has not been hydrated yet', async () => {
    // The store is created at import time — before the prefs cache is populated
    // — so an overlay registering in that window used to persist ONLY itself.
    await loadPrefs({ [VISIBLE]: REAL_IDS, 'calendar.overlaySeen': [] })
    useCalendarStore.getState().registerOverlaySource('meetup', OVERLAY, [])
    expect(getPref<string[]>(VISIBLE, [])).toEqual([...REAL_IDS, 'meetup'])
    expect(useCalendarStore.getState().visibleCalendarIds.has(REAL_IDS[0]!)).toBe(true)
  })

  it('respects an explicit toggle-off of an already-seen overlay', async () => {
    await loadPrefs({ [VISIBLE]: REAL_IDS, 'calendar.overlaySeen': ['meetup'] })
    useCalendarStore.getState().registerOverlaySource('meetup', OVERLAY, [])
    expect(useCalendarStore.getState().visibleCalendarIds.has('meetup')).toBe(false)
    expect(getPref<string[]>(VISIBLE, [])).toEqual(REAL_IDS)
  })

  it('persists nothing while the prefs load is still failing', async () => {
    __resetPrefsForTests()
    mockHub(new Error('timeout'))
    void initPrefs()
    await Promise.resolve()
    const before = putCount()
    useCalendarStore.getState().registerOverlaySource('meetup', OVERLAY, [])
    expect(putCount()).toBe(before)
    // …but it is visible in memory, so the user still sees it this session.
    expect(useCalendarStore.getState().visibleCalendarIds.has('meetup')).toBe(true)
  })
})
