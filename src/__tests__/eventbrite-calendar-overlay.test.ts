import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'

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
vi.mock('@/hub', () => ({ hubFetch: vi.fn(), getHubUrl: () => 'http://localhost' }))
vi.mock('@/sync-bus', () => ({ hubBus: { onConnect: () => () => {} } }))

import { eventbriteEventToCalendarEvent, EVENTBRITE_CALENDAR_INFO, type EventbriteEvent } from '@/eventbrite/calendar-overlay'

const ev: EventbriteEvent = {
  id: '1994648479296', title: 'Wilding Camp: Autumn Equinox', url: 'https://www.eventbrite.co.uk/e/x-1994648479296',
  start: '2026-09-25T08:30:00Z', end: '2026-09-27T14:00:00Z', organizerId: '121041407049', organizerName: 'Wilding with Harry',
  venueName: 'Sparrows Campsite', address: 'Halstead, CO9 1RS', online: false, summary: 'A weekend in the woods',
}

describe('eventbriteEventToCalendarEvent', () => {
  it('maps to a read-only timed event on the synthetic Eventbrite calendar with the real end', () => {
    const out = eventbriteEventToCalendarEvent(ev)
    expect(out.id).toBe('eventbrite:1994648479296')
    expect(out.calendarId).toBe(EVENTBRITE_CALENDAR_INFO.id)
    expect(out.start).toEqual({ dateTime: '2026-09-25T08:30:00Z' })
    expect(out.end).toEqual({ dateTime: '2026-09-27T14:00:00Z' })
    expect(out.location).toBe('Sparrows Campsite, Halstead, CO9 1RS')
    expect(out.description).toContain('Wilding with Harry')
    expect(out.htmlLink).toBe(ev.url)
    expect(EVENTBRITE_CALENDAR_INFO).toMatchObject({ accessRole: 'reader', synthetic: true, summary: 'Eventbrite' })
  })
  it('labels online events and falls back to start when end is missing', () => {
    const out = eventbriteEventToCalendarEvent({ ...ev, online: true, end: '' })
    expect(out.location).toBe('Online')
    expect(out.end).toEqual({ dateTime: ev.start })
  })
})
