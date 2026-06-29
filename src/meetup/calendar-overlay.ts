// Meetup → Calendar overlay bridge.
//
// Meetup events are time-based, so they belong in the Calendar tab too — and
// it's the ONLY place online/hybrid events (no venue → no map pin) can surface.
// The Calendar store owns a generic read-only overlay mechanism
// (`registerOverlaySource`); this module is the Meetup side: a pure adapter
// (MeetupEvent → CalendarEvent) + a wiring fn that pushes the current events
// into that overlay whenever the Map store's `events` change.
//
// Read-only synthetic "Meetup" calendar: never persisted to Dexie, never
// network-fetched (the `synthetic` flag stops the Google fetch), never editable
// (accessRole 'reader' gates the calendar's mutation paths).

import type { CalendarEvent, CalendarInfo } from '@/calendar/types'
import { useMapStore, type MeetupEvent } from '@/store/map'
import { useCalendarStore } from '@/store/calendar'

// #a855f7 = the purple of the map's meetup-selected ring, so map ↔ calendar match.
export const MEETUP_CALENDAR_INFO: CalendarInfo = {
  id: 'meetup',
  accountEmail: 'meetup',
  apiAccountEmail: 'meetup',
  summary: 'Meetup',
  backgroundColor: '#a855f7',
  foregroundColor: '#ffffff',
  selected: true,
  accessRole: 'reader',
  synthetic: true,
}

const HOUR_MS = 60 * 60 * 1000

/** Pure: MeetupEvent → a read-only timed CalendarEvent on the 'meetup' calendar. */
export function meetupEventToCalendarEvent(ev: MeetupEvent): CalendarEvent {
  const start = ev.dateTime
  let end = ev.endTime
  if (!end) {
    const t = Date.parse(start)
    end = Number.isNaN(t) ? start : new Date(t + HOUR_MS).toISOString()
  }
  const location =
    ev.isOnline || ev.eventType === 'ONLINE'
      ? 'Online'
      : [ev.venueName, ev.venueCity].filter(Boolean).join(', ')
  const description = [ev.groupName, ev.going > 0 ? `${ev.going} going` : '', ev.eventUrl]
    .filter(Boolean)
    .join('\n')
  return {
    id: `meetup:${ev.id}`, // stable, unique — the only dedupe key (no Dexie compoundKey)
    calendarId: 'meetup',
    accountEmail: 'meetup',
    summary: ev.title,
    description,
    location,
    start: { dateTime: start },
    end: { dateTime: end }, // always timed → the calendar's range filter works
    status: 'confirmed',
    htmlLink: ev.eventUrl,
    created: '',
    updated: '',
  }
}

let wired = false
let registered = false

/** Idempotent; call once on boot. Pushes Meetup events into the calendar's
 *  read-only overlay and keeps them in sync with the Map store. */
export function wireMeetupCalendarOverlay(): () => void {
  if (wired) return () => {}
  wired = true

  const push = (events: MeetupEvent[]): void => {
    const cal = useCalendarStore.getState()
    if (events.length) {
      cal.registerOverlaySource('meetup', MEETUP_CALENDAR_INFO, events.map(meetupEventToCalendarEvent))
      registered = true
    } else if (registered) {
      cal.unregisterOverlaySource('meetup')
      registered = false
    }
  }

  push(useMapStore.getState().events)
  const unsub = useMapStore.subscribe((s, prev) => {
    if (s.events !== prev.events) push(s.events)
  })

  return () => {
    unsub()
    wired = false
    if (registered) {
      useCalendarStore.getState().unregisterOverlaySource('meetup')
      registered = false
    }
  }
}
