// Geofences — pure evaluation over OwnTracks fixes.
//
// A fence is a circle (lat, lon, radius m). State per fence is inside/outside
// plus the fix that set it. `evaluate` applies one fix to every fence with
// hysteresis (leave needs radius + margin) and refuses to flip on fixes whose
// accuracy is worse than the fence can resolve, so a wifi-fix at the edge of
// a small fence does not flap. A fence with no prior state is initialised
// silently: an event means a TRANSITION, never "here is where he already was".

export interface Fix {
  lat: number
  lon: number
  /** unix seconds */
  tst: number
  /** metres */
  acc?: number
  batt?: number
  /** km/h */
  vel?: number
  device?: string
  user?: string
}

export type FenceTrigger = 'enter' | 'leave' | 'both'

export interface Geofence {
  id: string
  name: string
  lat: number
  lon: number
  /** metres */
  radius: number
  /** agentKeys woken with a [GEOFENCE] envelope on a transition */
  wake: string[]
  /** outbound POST target (JSON body = the event) */
  url?: string
  /** bearer for the outbound POST */
  urlToken?: string
  /** privacy zone: disclosure tools name the fence, never its coordinates */
  private?: boolean
  on: FenceTrigger
  note?: string
  /** one-shot fences (a meeting venue) self-prune at this epoch ms */
  expiresAt?: number
  createdAt: number
  createdBy?: string
}

export interface FenceState {
  inside: boolean
  /** epoch ms the current state began (fix time) */
  since: number
  /** tst of the fix that last evaluated this fence */
  tst: number
}

export interface GeofenceEvent {
  id: string
  /** epoch ms of the fix that caused it */
  ts: number
  fenceId: string
  fenceName: string
  event: 'enter' | 'leave'
  fix: Fix
  /** seconds spent in the previous state */
  dwellS: number
  test?: boolean
  /** derived from Recorder history after a live-feed gap, not from a live fix */
  replayed?: boolean
  delivered: Array<{ to: string; ok: boolean; detail?: string }>
}

export const EARTH_RADIUS_M = 6371008.8

export function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLon = toRad(bLon - aLon)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** Extra distance beyond the radius before a LEAVE fires. */
export function leaveMarginM(radius: number): number {
  return Math.max(30, radius * 0.15)
}

/** A fix too imprecise to say anything about this fence. */
export function fixTooCoarse(fence: Geofence, fix: Fix): boolean {
  return fix.acc != null && fix.acc > Math.max(fence.radius * 2, 150)
}

export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'fence'
}

export function eventId(fenceId: string, tst: number, event: 'enter' | 'leave'): string {
  return `gf_${tst.toString(36)}_${event[0]}_${fenceId}`.slice(0, 64)
}

export interface EvaluateResult {
  state: Record<string, FenceState>
  events: GeofenceEvent[]
}

/**
 * Apply one fix to every fence. Returns the new state map and the transitions
 * that fired (already filtered by each fence's `on`). Pure — no clock, no IO.
 */
export function evaluate(fences: Geofence[], prev: Record<string, FenceState>, fix: Fix): EvaluateResult {
  const state: Record<string, FenceState> = {}
  const events: GeofenceEvent[] = []
  const nowMs = fix.tst * 1000
  for (const f of fences) {
    const d = haversineM(f.lat, f.lon, fix.lat, fix.lon)
    const was = prev[f.id]
    if (fixTooCoarse(f, fix)) {
      if (was) state[f.id] = was
      continue
    }
    const inside = was?.inside ? d <= f.radius + leaveMarginM(f.radius) : d <= f.radius
    if (!was) {
      state[f.id] = { inside, since: nowMs, tst: fix.tst }
      continue
    }
    if (inside === was.inside) {
      state[f.id] = { ...was, tst: fix.tst }
      continue
    }
    state[f.id] = { inside, since: nowMs, tst: fix.tst }
    const event = inside ? 'enter' : 'leave'
    if (f.on !== 'both' && f.on !== event) continue
    events.push({
      id: eventId(f.id, fix.tst, event),
      ts: nowMs,
      fenceId: f.id,
      fenceName: f.name,
      event,
      fix,
      dwellS: Math.max(0, Math.round((nowMs - was.since) / 1000)),
      delivered: [],
    })
  }
  return { state, events }
}

/** Fences the fix is currently inside (by plain radius, no hysteresis). */
export function fencesContaining(fences: Geofence[], fix: Fix): Geofence[] {
  return fences.filter((f) => haversineM(f.lat, f.lon, fix.lat, fix.lon) <= f.radius)
}

export function fmtDuration(s: number): string {
  if (s < 60) return `${Math.round(s)} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 48) return rm ? `${h} h ${rm} min` : `${h} h`
  return `${Math.round(h / 24)} d`
}

function fmtLocal(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '')
}

/** The wake envelope for an agent. Carries the exact fix — it only ever goes to the fence's own `wake` keys. */
export function buildGeofenceEnvelope(ev: GeofenceEvent, fence: Geofence | undefined, nowMs = Date.now()): string {
  const verb = ev.event === 'enter' ? 'ENTERED' : 'LEFT'
  const ageS = Math.max(0, Math.round((nowMs - ev.ts) / 1000))
  const acc = ev.fix.acc != null ? ` ±${Math.round(ev.fix.acc)} m` : ''
  const batt = ev.fix.batt != null ? `, battery ${ev.fix.batt} %` : ''
  const prevState = ev.event === 'enter' ? 'outside' : 'inside'
  const lines = [
    `[GEOFENCE${ev.test ? ' TEST' : ''}${ev.replayed ? ' REPLAYED' : ''} — Yousef ${verb} "${ev.fenceName}"]`,
    `When: ${fmtLocal(ev.ts)} Europe/London (fix ${fmtDuration(ageS)} old${acc}${batt})${ev.replayed ? ' — replayed from Recorder history; the hub was not listening when it happened' : ''}`,
    `Fence: ${ev.fenceId} — ${fence ? `${fence.lat.toFixed(5)},${fence.lon.toFixed(5)} r ${Math.round(fence.radius)} m` : 'removed'}${fence?.note ? ` — ${fence.note}` : ''}`,
    `Fix: ${ev.fix.lat.toFixed(5)},${ev.fix.lon.toFixed(5)}`,
    `Before: ${prevState} for ${fmtDuration(ev.dwellS)}`,
    `Event id ${ev.id} — \`con location events\` for history, \`con location\` for the current fix.`,
    'Decide what this means for you; the hub has done nothing else.',
  ]
  return lines.join('\n')
}
