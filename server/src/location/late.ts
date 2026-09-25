// Late-for-a-meeting check — the primitive behind "if I'm running more than
// 10 min late, …". For every upcoming event he is going to (cal/visibility.ts:
// his ticked calendars, invites he has not declined) with a PHYSICAL venue:
// geocode it, get a traffic-aware ETA from his current fix, compare arrival
// with the start. One report per event; it re-reports only when lateness has
// grown by another threshold (state file keyed by event id). All IO injected.
//
// Travel blocks ("Drive to X", "Flight to Y") are the exception: their
// location is the DESTINATION and their start is the DEPARTURE time, so
// "arrives after the start" is meaningless. For those the check is "did he
// leave on time": the fix at departure time is remembered as the origin, and a
// report fires only once the start has passed by more than the threshold with
// him still within ARRIVED_M of it.

import { haversineM, type Fix } from './geofence.js'

export interface CalEvent {
  id: string
  summary?: string
  status?: string
  location?: string | null
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
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
  /** `late` = will reach the venue after the start; `not-left` = a travel block whose departure time has passed with him still at the origin. */
  kind: 'late' | 'not-left'
  eventId: string
  calendarId?: string
  summary: string
  startIso: string
  endIso?: string
  /** Negative once the start has passed (travel blocks only). */
  startsInMin: number
  location: string
  /** Absent on a `not-left` report whose destination could not be geocoded. */
  venue?: Geocoded
  mode: TravelMode
  etaMin?: number
  distanceKm?: number
  arriveIso?: string
  lateMin: number
  attendees: string[]
  reAlert: boolean
}

export type LateState = Record<string, {
  lateMin: number
  at: string
  /** Travel block — set by title or by the duration rule, sticky so the post-departure ticks need no route. */
  travel?: true
  /** Where he was at the last tick before departure time. */
  origin?: { lat: number; lon: number }
  /** Moved away from `origin` after the departure time — nothing left to judge. */
  departed?: true
}>

/** Venues we cannot drive to. Home stays private; virtual meetings have no ETA. */
export const VIRTUAL_RE = /\b(home|living room|kitchen|online|zoom|meet\.google|teams|google meet|call|phone|remote)\b|https?:\/\//i

/** Titles of travel blocks: a travel verb leading to a "to", or an origin → destination arrow. */
export const TRAVEL_RE = /^(drive|driving|travel|travelling|traveling|train|flight|fly|flying|cycle|cycling|bike|walk|walking|bus|coach|commute|taxi|cab|uber|ferry)\b.*\bto\b|\S\s*(→|->)\s*\S/i

/** An event as long as the route to it (±20 %) with nobody else invited is a travel block too. */
export const TRAVEL_DURATION_TOL = 0.2

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

export const isTravelTitle = (summary: string | undefined): boolean => TRAVEL_RE.test((summary ?? '').trim())

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
  const nowIso = new Date(nowMs).toISOString()
  const state: LateState = { ...prevState }
  if (!fix) return { reports: [], state, skipped: 'no fix', considered: 0 }
  if ((ageS ?? 0) > STALE_FIX_S) return { reports: [], state, skipped: 'stale fix', considered: 0 }

  const events = await ctx.listEvents(nowIso, new Date(nowMs + windowMin * 60_000).toISOString())
  const reports: LateReport[] = []
  let considered = 0
  const here = { lat: fix.lat, lon: fix.lon }
  for (const ev of events) {
    const startIso = ev.start?.dateTime
    const loc = (ev.location ?? '').trim()
    if (!startIso || !loc || VIRTUAL_RE.test(loc) || ev.status === 'cancelled') continue
    const me = (ev.attendees ?? []).find((a) => a.self)
    if (me?.responseStatus === 'declined') continue
    const startMs = Date.parse(startIso)
    if (!Number.isFinite(startMs)) continue
    const endIso = ev.end?.dateTime
    const endMs = endIso ? Date.parse(endIso) : NaN
    const others = (ev.attendees ?? []).filter((a) => !a.self && a.email).map((a) => a.email!)
    const prev = state[ev.id]
    const base = { eventId: ev.id, calendarId: ev.calendarId, summary: ev.summary ?? '(untitled)', startIso, endIso, location: loc, mode, attendees: others }

    if (prev?.travel || isTravelTitle(ev.summary)) {
      considered++
      if (prev?.departed) continue
      if (startMs > nowMs || !prev?.origin) { state[ev.id] = { lateMin: prev?.lateMin ?? 0, at: nowIso, travel: true, origin: here }; continue }
      if (haversineM(fix.lat, fix.lon, prev.origin.lat, prev.origin.lon) > ARRIVED_M) { state[ev.id] = { ...prev, departed: true }; continue }
      const lateMin = (nowMs - startMs) / 60_000
      if (lateMin <= threshold || (prev.lateMin > 0 && lateMin < prev.lateMin + threshold)) continue
      const venue = await ctx.geocode(loc, fix)
      if (venue && haversineM(fix.lat, fix.lon, venue.lat, venue.lon) <= ARRIVED_M) { state[ev.id] = { ...prev, departed: true }; continue }
      const r = venue ? await ctx.route(fix, venue, mode) : null
      state[ev.id] = { ...prev, lateMin: Math.round(lateMin), at: nowIso }
      reports.push({
        ...base,
        kind: 'not-left',
        startsInMin: -Math.round(lateMin),
        venue: venue ?? undefined,
        etaMin: r ? Math.round(r.durationSec / 60) : undefined,
        distanceKm: r ? Math.round(r.distanceMeters / 100) / 10 : undefined,
        arriveIso: r ? new Date(nowMs + r.durationSec * 1000).toISOString() : undefined,
        lateMin: Math.round(lateMin),
        reAlert: prev.lateMin > 0,
      })
      continue
    }

    if (startMs < nowMs) continue
    considered++
    const venue = await ctx.geocode(loc, fix)
    if (!venue) continue
    if (haversineM(fix.lat, fix.lon, venue.lat, venue.lon) <= ARRIVED_M) { delete state[ev.id]; continue }
    const r = await ctx.route(fix, venue, mode)
    if (!r) continue
    if (Number.isFinite(endMs) && !others.length && Math.abs((endMs - startMs) / 1000 - r.durationSec) <= TRAVEL_DURATION_TOL * r.durationSec) {
      state[ev.id] = { lateMin: 0, at: nowIso, travel: true, origin: here }
      continue
    }
    const arriveMs = nowMs + r.durationSec * 1000
    const lateMin = (arriveMs - startMs) / 60_000
    if (lateMin <= threshold) continue
    if (prev && lateMin < prev.lateMin + threshold) continue
    state[ev.id] = { lateMin: Math.round(lateMin), at: nowIso }
    reports.push({
      ...base,
      kind: 'late',
      startsInMin: Math.round((startMs - nowMs) / 60_000),
      venue,
      etaMin: Math.round(r.durationSec / 60),
      distanceKm: Math.round(r.distanceMeters / 100) / 10,
      arriveIso: new Date(arriveMs).toISOString(),
      lateMin: Math.round(lateMin),
      reAlert: !!prev,
    })
  }
  // The window only moves forward, so an id no longer listed is over (or was moved and will be judged afresh).
  const listed = new Set(events.map((e) => e.id))
  for (const id of Object.keys(state)) if (!listed.has(id)) delete state[id]
  return { reports, state, considered }
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false })

/** The guard's stdout / the WhatsApp-ready summary. */
export function formatLateReport(r: LateReport): string {
  const modeName = r.mode === 'DRIVE' ? 'Drive' : r.mode.toLowerCase()
  const tail = [
    `  Attendees: ${r.attendees.length ? r.attendees.join(', ') : 'none besides Yousef'}`,
    `  Event id: ${r.eventId}${r.calendarId ? `  calendar: ${r.calendarId}` : ''}`,
  ]
  if (r.kind === 'not-left') {
    return [
      `NOT LEFT: "${r.summary}" was due to leave ${hhmm(r.startIso)}, ${r.lateMin} min ago; still where he was at departure time, heading for ${r.location}${r.reAlert ? ' (re-alert: still there)' : ''}`,
      r.etaMin != null && r.arriveIso
        ? `  ${modeName} ETA ${r.etaMin} min (${r.distanceKm} km) → arrives ~${hhmm(r.arriveIso)}${r.endIso ? `, block ends ${hhmm(r.endIso)}` : ''}`
        : '  No route: destination could not be geocoded',
      ...tail,
    ].join('\n')
  }
  return [
    `LATE: "${r.summary}" starts ${hhmm(r.startIso)} (in ${r.startsInMin} min) at ${r.location}`,
    `  ${modeName} ETA ${r.etaMin} min (${r.distanceKm} km) → arrives ~${hhmm(r.arriveIso!)}, about ${r.lateMin} min late${r.reAlert ? ' (re-alert: got worse)' : ''}`,
    ...tail,
  ].join('\n')
}
