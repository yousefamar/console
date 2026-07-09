// OutdoorLads → Calendar overlay bridge.
//
// OutdoorLads publishes a national RSS feed of upcoming events; the hub fetches
// + parses it (`/outdoorlads/events`). These are time-based with no geo coords,
// so they belong ONLY in the Calendar tab — via the store's generic read-only
// overlay seam (`registerOverlaySource`). This module fetches from the hub,
// filters to the event types we care about (camping by default), adapts them to
// CalendarEvents, and registers the overlay. Refreshed on boot, hub-reconnect,
// and a slow interval.
//
// Read-only synthetic "OutdoorLads" calendar: never persisted to Dexie, never
// Google-fetched (the `synthetic` flag), never editable (accessRole 'reader').

import type { CalendarEvent, CalendarInfo } from '@/calendar/types'
import { useCalendarStore } from '@/store/calendar'
import { hubFetch } from '@/hub'
import { hubBus } from '@/sync-bus'

interface OutdoorLadsEvent {
  id: string
  title: string
  link: string
  start: string
  eventType: string
  region: string
  location: string
  description: string
}

const SOURCE_ID = 'outdoorlads'
const REFRESH_MS = 6 * 60 * 60 * 1000 // 6h — the hub also TTL-caches at 1h
const EVENT_MS = 2 * 60 * 60 * 1000 // default block length (feed gives no end time)

// Event types to surface. The feed is UK-wide across many activity types; we
// only want camping. Substring match (case-insensitive) catches "Campsites".
const INCLUDE_TYPES = ['camp']

// #f5821f = OutdoorLads' brand orange — distinct from Meetup pink + the blues/
// greens/reds already in use.
export const OUTDOORLADS_CALENDAR_INFO: CalendarInfo = {
  id: SOURCE_ID,
  accountEmail: SOURCE_ID,
  apiAccountEmail: SOURCE_ID,
  summary: 'OutdoorLads',
  backgroundColor: '#f5821f',
  foregroundColor: '#ffffff',
  selected: true,
  accessRole: 'reader',
  synthetic: true,
}

function included(ev: OutdoorLadsEvent): boolean {
  const t = ev.eventType.toLowerCase()
  return INCLUDE_TYPES.some((k) => t.includes(k))
}

/** Pure: OutdoorLadsEvent → a read-only timed CalendarEvent on the source's calendar. */
export function outdoorLadsEventToCalendarEvent(ev: OutdoorLadsEvent): CalendarEvent {
  const startMs = Date.parse(ev.start)
  const end = Number.isNaN(startMs) ? ev.start : new Date(startMs + EVENT_MS).toISOString()
  const description = [ev.eventType, ev.description, ev.link].filter(Boolean).join('\n')
  return {
    id: `outdoorlads:${ev.id}`, // stable, unique — the only dedupe key
    calendarId: SOURCE_ID,
    accountEmail: SOURCE_ID,
    summary: ev.title,
    description,
    location: ev.location,
    start: { dateTime: ev.start },
    end: { dateTime: end },
    status: 'confirmed',
    htmlLink: ev.link,
    created: '',
    updated: '',
  }
}

let wired = false
let registered = false
let timer: ReturnType<typeof setInterval> | null = null

// Guards against overlapping refreshes (boot + onConnect + timer can race).
let refreshing = false

async function refresh(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    // Retry with backoff: at boot the hub may still be restarting, so a single
    // failed fetch used to leave the overlay permanently unregistered (onConnect
    // won't re-fire if the WS was already up at wire time). Keep trying until we
    // get an answer, then apply it.
    const delays = [0, 1000, 3000, 8000, 20000]
    let events: OutdoorLadsEvent[] | null = null
    for (const d of delays) {
      if (d) await new Promise((r) => setTimeout(r, d))
      try {
        const res = await hubFetch<{ events: OutdoorLadsEvent[] }>('/outdoorlads/events')
        events = res.events || []
        break
      } catch {
        // keep retrying
      }
    }
    if (events === null) return // still unreachable — leave existing overlay in place
    const cal = useCalendarStore.getState()
    const filtered = events.filter(included).map(outdoorLadsEventToCalendarEvent)
    if (filtered.length) {
      cal.registerOverlaySource(SOURCE_ID, OUTDOORLADS_CALENDAR_INFO, filtered)
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
export function wireOutdoorLadsCalendarOverlay(): () => void {
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
