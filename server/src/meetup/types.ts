// Meetup events data model + node mapper.
//
// Sourced from Meetup's web GraphQL endpoint (https://www.meetup.com/gql2),
// which answers anonymously — no Pro subscription, no OAuth. The `eventSearch`
// query returns events with venue coordinates inline; we map each gql node onto
// this flat summary shape. Unlike geocaches, events are time-bound, so the store
// prunes anything that has already ended (`isExpired`).

export type MeetupEventType = 'PHYSICAL' | 'ONLINE' | 'HYBRID'

/** Lazy full detail (long description) fetched when an event is opened. */
export interface MeetupEventDetail {
  description: string
  fetchedAt: number
}

export interface MeetupEvent {
  id: string
  title: string
  dateTime: string // ISO 8601 with offset, e.g. '2026-07-07T19:00:00+01:00'
  endTime: string // ISO 8601 with offset, '' if unknown
  eventUrl: string
  eventType: MeetupEventType
  isOnline: boolean
  going: number // RSVP count
  groupName: string
  groupUrlname: string
  venueName: string
  venueAddress: string
  venueCity: string
  lat: number | null // null for online events (no venue)
  lon: number | null
  fetchedAt: number // when the summary was last refreshed
  detail?: MeetupEventDetail
}

function normEventType(v: unknown): MeetupEventType {
  const s = String(v ?? 'PHYSICAL').toUpperCase()
  return s === 'ONLINE' || s === 'HYBRID' ? (s as MeetupEventType) : 'PHYSICAL'
}

/** Map an `eventSearch`/`event` gql node onto our flat summary. */
export function eventFromNode(node: Record<string, unknown>): MeetupEvent {
  const group = node.group as { name?: string; urlname?: string } | undefined
  const venue = node.venue as { name?: string; address?: string; city?: string; lat?: number; lon?: number } | undefined
  const going = node.going as { totalCount?: number } | undefined
  return {
    id: String(node.id ?? ''),
    title: String(node.title ?? ''),
    dateTime: typeof node.dateTime === 'string' ? node.dateTime : '',
    endTime: typeof node.endTime === 'string' ? node.endTime : '',
    eventUrl: String(node.eventUrl ?? ''),
    eventType: normEventType(node.eventType),
    isOnline: Boolean(node.isOnline),
    going: Number(going?.totalCount ?? 0),
    groupName: group?.name ?? '',
    groupUrlname: group?.urlname ?? '',
    venueName: venue?.name ?? '',
    venueAddress: venue?.address ?? '',
    venueCity: venue?.city ?? '',
    lat: typeof venue?.lat === 'number' ? venue.lat : null,
    lon: typeof venue?.lon === 'number' ? venue.lon : null,
    fetchedAt: Date.now(),
  }
}

/** Epoch-ms the event ends. Prefers `endTime`; falls back to start + 3h; an
 *  unparseable date returns Infinity so we never prune an event we can't date. */
export function eventEndMs(ev: { dateTime: string; endTime?: string }): number {
  const end = ev.endTime ? Date.parse(ev.endTime) : NaN
  if (!Number.isNaN(end)) return end
  const start = Date.parse(ev.dateTime)
  if (Number.isNaN(start)) return Infinity
  return start + 3 * 60 * 60 * 1000
}

export function isExpired(ev: { dateTime: string; endTime?: string }, nowMs: number): boolean {
  return eventEndMs(ev) < nowMs
}
