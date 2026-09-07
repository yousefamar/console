// Eventbrite organisers → Calendar overlay bridge.
//
// The hub follows a fixed list of Eventbrite organisers with the user's personal
// token (`/eventbrite/events`, `con cal eventbrite follow <url>`). Their live
// events land here as a read-only synthetic "Eventbrite" calendar via the
// store's overlay seam (`registerOverlaySource`) — the same shape as the Meetup
// overlay. Refreshed on boot, hub-reconnect, and a slow interval; a failed boot
// fetch retries with backoff rather than leaving the overlay unregistered.

import type { CalendarEvent, CalendarInfo } from '@/calendar/types'
import { useCalendarStore } from '@/store/calendar'
import { hubFetch } from '@/hub'
import { hubBus } from '@/sync-bus'

export interface EventbriteEvent {
  id: string
  title: string
  url: string
  start: string
  end: string
  organizerId: string
  organizerName: string
  venueName: string
  address: string
  online: boolean
  summary: string
}

const SOURCE_ID = 'eventbrite'
const REFRESH_MS = 6 * 60 * 60 * 1000

// #f05537 = Eventbrite's brand orange-red; distinct from Meetup's pink.
export const EVENTBRITE_CALENDAR_INFO: CalendarInfo = {
  id: SOURCE_ID,
  accountEmail: SOURCE_ID,
  apiAccountEmail: SOURCE_ID,
  summary: 'Eventbrite',
  backgroundColor: '#f05537',
  foregroundColor: '#ffffff',
  selected: true,
  accessRole: 'reader',
  synthetic: true,
}

/** Pure: EventbriteEvent → a read-only timed CalendarEvent on the overlay calendar. */
export function eventbriteEventToCalendarEvent(ev: EventbriteEvent): CalendarEvent {
  const location = ev.online ? 'Online' : [ev.venueName, ev.address].filter(Boolean).join(', ')
  const description = [ev.organizerName, ev.summary, ev.url].filter(Boolean).join('\n')
  return {
    id: `eventbrite:${ev.id}`,
    calendarId: SOURCE_ID,
    accountEmail: SOURCE_ID,
    summary: ev.title,
    description,
    location,
    start: { dateTime: ev.start },
    end: { dateTime: ev.end || ev.start },
    status: 'confirmed',
    htmlLink: ev.url,
    created: '',
    updated: '',
  }
}

let wired = false
let registered = false
let timer: ReturnType<typeof setInterval> | null = null
let refreshing = false

async function refresh(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const delays = [0, 1000, 3000, 8000, 20000]
    let events: EventbriteEvent[] | null = null
    for (const d of delays) {
      if (d) await new Promise((r) => setTimeout(r, d))
      try {
        const res = await hubFetch<{ events: EventbriteEvent[] }>('/eventbrite/events')
        events = res.events || []
        break
      } catch {
        // hub may be restarting — keep retrying
      }
    }
    if (events === null) return
    const cal = useCalendarStore.getState()
    const mapped = events.map(eventbriteEventToCalendarEvent)
    if (mapped.length) {
      cal.registerOverlaySource(SOURCE_ID, EVENTBRITE_CALENDAR_INFO, mapped)
      registered = true
    } else if (registered) {
      cal.unregisterOverlaySource(SOURCE_ID)
      registered = false
    }
  } finally {
    refreshing = false
  }
}

/** Idempotent; call once on boot. */
export function wireEventbriteCalendarOverlay(): () => void {
  if (wired) return () => {}
  wired = true

  void refresh()
  const unsubConnect = hubBus.onConnect(() => { void refresh() })
  timer = setInterval(() => { void refresh() }, REFRESH_MS)

  return () => {
    unsubConnect()
    if (timer) clearInterval(timer)
    timer = null
    wired = false
    if (registered) {
      useCalendarStore.getState().unregisterOverlaySource(SOURCE_ID)
      registered = false
    }
  }
}
