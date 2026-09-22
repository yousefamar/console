// Late-for-a-meeting check — the primitive behind "if I'm running more than
// 10 min late, …". For every upcoming event he is going to (cal/visibility.ts:
// his ticked calendars, invites he has not declined) with a PHYSICAL venue:
// geocode it, get a traffic-aware ETA from his current fix, compare arrival
// with the start. One report per event; it re-reports only when lateness has
// grown by another threshold (state file keyed by event id). All IO injected.

import { haversineM, type Fix } from './geofence.js'

export interface CalEvent {
  id: string
  summary?: string
  status?: string
  location?: string | null
  start?: { dateTime?: string; date?: string }
  attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }> | null
  calendarId?: string
}

export interface Geocoded { name: string; address?: string; lat: number; lon: number }
export interface RouteEta { durationSec: number; distanceMeters: number; description?: string }
export type TravelMode = 'DRIVE' | 'WALK' | 'BICYCLE' | 'TRANSIT'

export interface LateCtx {
  listEvents: (fromIso: string, toIso: string) => Promise<CalEvent[]>
  geocode: (query: string, near: { lat: number; lon: number }) => Promise<Geocoded | null>
  route: (origin: { lat: number; lon: number }, dest: { lat: number; lon: number }, mode: TravelMode) => Promise<RouteEta | null>
}

export interface LateReport {
  eventId: string
  calendarId?: string
  summary: string
  startIso: string
  startsInMin: number
  location: string
  venue: Geocoded
  mode: TravelMode
  etaMin: number
  distanceKm: number
  arriveIso: string
  lateMin: number
  attendees: string[]
  reAlert: boolean
}

export type LateState = Record<string, { lateMin: number; at: string }>

/** Venues we cannot drive to. Home stays private; virtual meetings have no ETA. */
export const VIRTUAL_RE = /\b(home|living room|kitchen|online|zoom|meet\.google|teams|google meet|call|phone|remote)\b|https?:\/\//i

/** Fixes older than this say nothing about where he is now. */
export const STALE_FIX_S = 30 * 60
/** Within this of the venue = arrived. */
export const ARRIVED_M = 250

export interface LateCheckResult {
  reports: LateReport[]
  state: LateState
  /** Why nothing was evaluated, when that is the case. */
  skipped?: 'no fix' | 'stale fix'
  considered: number
}

export async function lateCheck(
  ctx: LateCtx,
  fix: Fix | null,
  ageS: number | null,
  prevState: LateState,
  opts: { thresholdMin?: number; windowMin?: number; mode?: TravelMode; nowMs?: number } = {},
): Promise<LateCheckResult> {
  const threshold = opts.thresholdMin ?? 10
  const windowMin = opts.windowMin ?? 180
  const mode = opts.mode ?? 'DRIVE'
  const nowMs = opts.nowMs ?? Date.now()
  const state: LateState = { ...prevState }
  if (!fix) return { reports: [], state, skipped: 'no fix', considered: 0 }
  if ((ageS ?? 0) > STALE_FIX_S) return { reports: [], state, skipped: 'stale fix', considered: 0 }

  const events = await ctx.listEvents(new Date(nowMs).toISOString(), new Date(nowMs + windowMin * 60_000).toISOString())
  const reports: LateReport[] = []
  let considered = 0
  for (const ev of events) {
    const startIso = ev.start?.dateTime
    const loc = (ev.location ?? '').trim()
    if (!startIso || !loc || VIRTUAL_RE.test(loc) || ev.status === 'cancelled') continue
    const me = (ev.attendees ?? []).find((a) => a.self)
    if (me?.responseStatus === 'declined') continue
    const startMs = Date.parse(startIso)
    if (!Number.isFinite(startMs) || startMs < nowMs) continue
    considered++
    const venue = await ctx.geocode(loc, fix)
    if (!venue) continue
    if (haversineM(fix.lat, fix.lon, venue.lat, venue.lon) <= ARRIVED_M) { delete state[ev.id]; continue }
    const r = await ctx.route(fix, venue, mode)
    if (!r) continue
    const arriveMs = nowMs + r.durationSec * 1000
    const lateMin = (arriveMs - startMs) / 60_000
    if (lateMin <= threshold) continue
    const prev = state[ev.id]
    if (prev && lateMin < prev.lateMin + threshold) continue
    state[ev.id] = { lateMin: Math.round(lateMin), at: new Date(nowMs).toISOString() }
    reports.push({
      eventId: ev.id,
      calendarId: ev.calendarId,
      summary: ev.summary ?? '(untitled)',
      startIso,
      startsInMin: Math.round((startMs - nowMs) / 60_000),
      location: loc,
      venue,
      mode,
      etaMin: Math.round(r.durationSec / 60),
      distanceKm: Math.round(r.distanceMeters / 100) / 10,
      arriveIso: new Date(arriveMs).toISOString(),
      lateMin: Math.round(lateMin),
      attendees: (ev.attendees ?? []).filter((a) => !a.self && a.email).map((a) => a.email!),
      reAlert: !!prev,
    })
  }
  return { reports, state, considered }
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false })

/** The guard's stdout / the WhatsApp-ready summary. */
export function formatLateReport(r: LateReport): string {
  return [
    `LATE: "${r.summary}" starts ${hhmm(r.startIso)} (in ${r.startsInMin} min) at ${r.location}`,
    `  ${r.mode === 'DRIVE' ? 'Drive' : r.mode.toLowerCase()} ETA ${r.etaMin} min (${r.distanceKm} km) → arrives ~${hhmm(r.arriveIso)}, about ${r.lateMin} min late${r.reAlert ? ' (re-alert: got worse)' : ''}`,
    `  Attendees: ${r.attendees.length ? r.attendees.join(', ') : 'none besides Yousef'}`,
    `  Event id: ${r.eventId}${r.calendarId ? `  calendar: ${r.calendarId}` : ''}`,
  ].join('\n')
}
