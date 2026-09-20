// con location — where Yousef is (OwnTracks via the hub), plus server-side
// geofences whose transitions wake agents / POST to a URL.
//
//   con location                          latest fix: coords, accuracy, age, battery, fences he is inside
//   con location history [--from D --to D] Recorder history for a day range
//   con location geofence list|add|remove
//   con location events [--limit N] [--fence id]
//   con location replay [--from D --to D] [--fence id]  dry run of the engine over history
//   con location test <fence-id> [--event enter|leave]
//   con location refresh                  fetch /last now (the live WebSocket normally makes this moot)
//   con location for <user-slug>          what THAT person may be told (policy from users/<slug>.md)
//   con location eta "<place>" [--mode]   traffic-aware ETA from the current fix
//   con location late-check [--threshold 10] [--window 180] [--guard]
//                                         upcoming placed events he will be late for; --guard = cron
//                                         semantics (exit 0 + report only when late, else silent exit 1)
//
// The raw fix is owner-grade data: anything relaying it to a third party goes
// through `con location for <user>`, never `con location` itself.

import { hubFetch } from '../client.js'
import { output, info, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags, unknownFlags } from './util.js'

const BOOLEAN_FLAGS = new Set(['private', 'guard'])

function positionals(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('--')) { out.push(a); continue }
    if (!a.includes('=') && !BOOLEAN_FLAGS.has(a.slice(2)) && i + 1 < args.length && !args[i + 1]!.startsWith('--')) i++
  }
  return out
}

function flagsOf(args: string[], allowed: readonly string[], flags: GlobalFlags): Record<string, string> {
  const opts = parseFlags(args)
  const bad = unknownFlags(opts, allowed)
  if (bad.length) exitWithError('USAGE', `Unknown flag(s): ${bad.map((b) => `--${b}`).join(', ')}. Allowed: ${allowed.map((a) => `--${a}`).join(', ') || 'none'}`, flags)
  return opts
}

interface Fix { lat: number; lon: number; tst: number; acc?: number; batt?: number; vel?: number; device?: string; user?: string }
interface LiveStatus { state: 'connected' | 'connecting' | 'polling' | 'stopped'; since: number | null; lastFrameAt: number | null; reconnects: number; lastError: string | null }
interface Current {
  fix: Fix | null; ageS: number | null; inside: Array<{ id: string; name: string; private: boolean }>; polledAt: number | null; lastError: string | null; fences: number
  live?: LiveStatus
  lastReplay?: { at: number; window: [number, number]; fixes: number; events: number } | null
}
interface FenceView {
  id: string; name: string; lat: number; lon: number; radius: number; wake: string[]; url?: string; urlToken?: string; private?: boolean; on: string; note?: string; expiresAt?: number; createdAt: number; createdBy?: string
  state: { inside: boolean; since: number; tst: number } | null
  wakeLive: Array<{ key: string; live: boolean }>
}
interface GeofenceEvent { id: string; ts: number; fenceId: string; fenceName: string; event: 'enter' | 'leave'; fix: Fix; dwellS: number; test?: boolean; replayed?: boolean; delivered: Array<{ to: string; ok: boolean; detail?: string }> }

const when = (ms: number | null | undefined) => ms ? new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '') : '—'
const ago = (s: number | null | undefined) => s == null ? '—' : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${(s / 3600).toFixed(1)} h ago` : `${Math.round(s / 86400)} d ago`
const coords = (f: { lat: number; lon: number }) => `${f.lat.toFixed(5)},${f.lon.toFixed(5)}`

export async function location(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case undefined:
    case 'now':
    case 'last': return locationNow(args, flags)
    case 'refresh': return locationNow(args, flags, true)
    case 'history': return locationHistory(args, flags)
    case 'geofence':
    case 'fence': return geofence(args[0], args.slice(1), flags)
    case 'events': return locationEvents(args, flags)
    case 'replay': return locationReplay(args, flags)
    case 'test': return locationTest(args, flags)
    case 'for': return locationFor(args, flags)
    case 'eta': return locationEta(args, flags)
    case 'late-check':
    case 'late': return locationLateCheck(args, flags)
    default:
      exitWithError('USAGE', `Unknown location command: ${verb}. Verbs: now, refresh, history, geofence, events, replay, test, for, eta, late-check. Run 'con help location'.`, flags)
  }
}

function describe(d: Current): string[] {
  if (!d.fix) return [`No fix known${d.lastError ? ` — ${d.lastError}` : ' (OwnTracks unconfigured or Recorder unreachable)'}`]
  const f = d.fix
  const parts = [coords(f)]
  if (f.acc != null) parts.push(`±${Math.round(f.acc)} m`)
  parts.push(ago(d.ageS), when(f.tst * 1000))
  if (f.batt != null) parts.push(`battery ${f.batt} %`)
  if (f.vel != null && f.vel > 0) parts.push(`${f.vel} km/h`)
  const lines = [parts.join(' · ')]
  lines.push(d.inside.length ? `Inside: ${d.inside.map((i) => `${i.name}${i.private ? ' (private)' : ''}`).join(', ')}` : `Inside: none of ${d.fences} fence${d.fences === 1 ? '' : 's'}`)
  lines.push(`https://maps.google.com/?q=${f.lat},${f.lon}`)
  if (d.live) lines.push(`Feed: ${describeLive(d.live)}${d.lastReplay?.fixes ? ` · last replay ${d.lastReplay.fixes} fixes → ${d.lastReplay.events} transitions (${when(d.lastReplay.at)})` : ''}`)
  if (d.lastError) lines.push(`Last poll error: ${d.lastError}`)
  return lines
}

function describeLive(l: LiveStatus): string {
  const now = Date.now()
  switch (l.state) {
    case 'connected': return `live WebSocket, up ${ago(Math.round((now - (l.since ?? now)) / 1000)).replace(' ago', '')}${l.lastFrameAt ? `, last frame ${ago(Math.round((now - l.lastFrameAt) / 1000))}` : ''}${l.reconnects ? `, ${l.reconnects} reconnect${l.reconnects === 1 ? '' : 's'}` : ''}`
    case 'connecting': return `RECONNECTING${l.lastError ? ` (${l.lastError})` : ''}`
    case 'polling': return `no live feed${l.lastError ? ` — ${l.lastError}` : ''}`
    case 'stopped': return 'stopped'
  }
}

async function locationNow(args: string[], flags: GlobalFlags, refresh = false): Promise<void> {
  flagsOf(args, [], flags)
  const d = refresh ? await hubFetch<Current>('/location/refresh', { method: 'POST', body: {} }) : await hubFetch<Current>('/location')
  if (flags.json) { output(d, flags); return }
  for (const l of describe(d)) info(l)
}

// con location history [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit N] — Recorder day range (default today).
async function locationHistory(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = flagsOf(args, ['from', 'to', 'limit', 'user', 'device'], flags)
  const cur = await hubFetch<Current>('/location')
  const user = opts.user ?? cur.fix?.user ?? 'amar'
  const device = opts.device ?? cur.fix?.device ?? 'armor'
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  const from = opts.from ?? today
  const to = opts.to ?? from
  const d = await hubFetch<{ count?: number; data?: Array<Fix & { isolocal?: string }> } | Array<Fix & { isolocal?: string }>>('/owntracks/locations', { params: { user, device, from, to, format: 'json' } })
  const rows = Array.isArray(d) ? d : d.data ?? []
  const limit = Number(opts.limit ?? 0) || 0
  const shown = limit ? rows.slice(-limit) : rows
  if (flags.json) { output({ user, device, from, to, count: rows.length, data: shown }, flags); return }
  info(`${rows.length} fixes for ${user}/${device} ${from}${to !== from ? ` → ${to}` : ''}${limit && rows.length > limit ? ` (last ${limit})` : ''}`)
  for (const r of shown) info(`${r.isolocal ?? new Date(r.tst * 1000).toISOString()}  ${coords(r)}${r.acc != null ? `  ±${Math.round(r.acc)} m` : ''}${r.vel ? `  ${r.vel} km/h` : ''}`)
}

async function geofence(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case undefined:
    case 'list': return fenceList(args, flags)
    case 'add':
    case 'set': return fenceAdd(args, flags)
    case 'remove':
    case 'rm': return fenceRemove(args, flags)
    default:
      exitWithError('USAGE', `Unknown geofence command: ${verb}. Verbs: list, add, remove.`, flags)
  }
}

async function fenceList(args: string[], flags: GlobalFlags): Promise<void> {
  flagsOf(args, [], flags)
  const d = await hubFetch<{ fences: FenceView[] }>('/location/geofences')
  if (flags.json) { output(d, flags); return }
  if (!d.fences.length) { info('No geofences — con location geofence add <name> --at "<address>" --radius 150'); return }
  for (const f of d.fences) {
    const st = f.state ? `${f.state.inside ? 'INSIDE' : 'outside'} since ${when(f.state.since)}` : 'no fix yet'
    const wake = f.wakeLive.map((w) => `@${w.key}${w.live ? '' : '(not live)'}`).join(',') || 'nobody'
    info(`${f.id.padEnd(22)} ${coords(f)} r ${Math.round(f.radius)} m  ${st}  on ${f.on} → ${wake}${f.url ? ` + POST ${f.url}` : ''}${f.private ? '  [private]' : ''}${f.expiresAt ? `  expires ${when(f.expiresAt)}` : ''}`)
    if (f.note) info(`  ${f.note}`)
  }
}

/** `+90m` / `+2h` / `+1d` / ISO → epoch ms. */
export function parseExpires(v: string, nowMs = Date.now()): number {
  const m = /^\+(\d+)([mhd])$/.exec(v.trim())
  if (m) return nowMs + Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd']
  const t = Date.parse(v)
  if (!Number.isFinite(t)) throw new Error(`bad --expires "${v}" (use +90m, +2h, +1d or an ISO datetime)`)
  return t
}

// con location geofence add <name> (--at "<address>" | --lat --lon) --radius M [--id] [--wake al,ceo]
//   [--url https://…] [--url-token T] [--private] [--on enter|leave|both] [--expires +2h] [--note …]
async function fenceAdd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = flagsOf(args, ['at', 'lat', 'lon', 'radius', 'id', 'wake', 'url', 'url-token', 'private', 'on', 'expires', 'note'], flags)
  const name = positionals(args).join(' ').trim()
  if (!name) exitWithError('USAGE', 'Usage: con location geofence add <name> (--at "<address>" | --lat L --lon L) --radius <m> [--wake al,ceo] [--url …] [--private] [--on enter|leave|both] [--expires +2h] [--note …]', flags)
  let lat = opts.lat != null ? Number(opts.lat) : NaN
  let lon = opts.lon != null ? Number(opts.lon) : NaN
  let resolved: string | undefined
  if (opts.at) {
    const cur = await hubFetch<Current>('/location').catch(() => null)
    const params: Record<string, string> = { q: opts.at }
    if (cur?.fix) { params.lat = String(cur.fix.lat); params.lon = String(cur.fix.lon); params.radius = '50000' }
    const g = await hubFetch<{ results: Array<{ name: string; address?: string; lat: number; lon: number }> }>('/gmaps/search', { params })
    const hit = g.results[0]
    if (!hit) exitWithError('NOT_FOUND', `Nothing found for "${opts.at}"`, flags)
    lat = hit!.lat; lon = hit!.lon; resolved = `${hit!.name}${hit!.address ? `, ${hit!.address}` : ''}`
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) exitWithError('USAGE', 'Give --at "<address>" or both --lat and --lon', flags)
  const radius = Number(opts.radius ?? 150)
  let expiresAt: number | undefined
  if (opts.expires) { try { expiresAt = parseExpires(opts.expires) } catch (e) { exitWithError('USAGE', (e as Error).message, flags) } }
  const body: Record<string, unknown> = { name, lat, lon, radius, on: opts.on ?? 'both' }
  if (opts.id) body.id = opts.id
  if (opts.wake) body.wake = opts.wake
  if (opts.url) body.url = opts.url
  if (opts['url-token']) body.urlToken = opts['url-token']
  if (opts.private) body.private = true
  if (expiresAt) body.expiresAt = expiresAt
  const note = [opts.note, resolved ? `at ${resolved}` : undefined].filter(Boolean).join(' — ')
  if (note) body.note = note
  const d = await hubFetch<{ fence: FenceView; created: boolean }>('/location/geofences', { method: 'POST', body })
  if (flags.json) { output(d, flags); return }
  const f = d.fence
  info(`${d.created ? 'Created' : 'Updated'} fence "${f.id}" — ${coords(f)} r ${Math.round(f.radius)} m${resolved ? ` (${resolved})` : ''}`)
  info(`  wakes ${f.wakeLive.map((w) => `@${w.key}${w.live ? '' : ' (not live)'}`).join(', ') || 'nobody'} on ${f.on}${f.url ? `; POSTs ${f.url}` : ''}${f.private ? '; private' : ''}${f.expiresAt ? `; expires ${when(f.expiresAt)}` : ''}`)
  info(`  state now: ${f.state ? (f.state.inside ? 'INSIDE' : 'outside') : 'no fix yet'}`)
}

async function fenceRemove(args: string[], flags: GlobalFlags): Promise<void> {
  flagsOf(args, [], flags)
  const id = positionals(args)[0]
  if (!id) exitWithError('USAGE', 'Usage: con location geofence remove <id>', flags)
  const d = await hubFetch<{ removed: string }>(`/location/geofences/${encodeURIComponent(id!)}`, { method: 'DELETE' })
  if (flags.json) { output(d, flags); return }
  info(`Removed fence "${d.removed}"`)
}

async function locationEvents(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = flagsOf(args, ['limit', 'fence'], flags)
  const d = await hubFetch<{ events: GeofenceEvent[] }>('/location/events', { params: { limit: opts.limit ?? '20', fence: opts.fence } })
  if (flags.json) { output(d, flags); return }
  if (!d.events.length) { info('No geofence events yet.'); return }
  for (const e of d.events) {
    const to = e.delivered.map((x) => `${x.ok ? '✓' : '✗'} ${x.to}${!x.ok && x.detail ? ` (${x.detail})` : ''}`).join(', ') || 'nobody'
    info(`${when(e.ts)}  ${e.test ? 'TEST ' : ''}${e.replayed ? 'REPLAYED ' : ''}${e.event.toUpperCase().padEnd(5)} ${e.fenceId.padEnd(22)} after ${ago(e.dwellS).replace(' ago', '')} ${e.event === 'enter' ? 'away' : 'inside'}  → ${to}`)
  }
}

// con location replay [--from D] [--to D] [--fence id] [--device d] — dry run of
// the fence engine over Recorder history: what WOULD have fired. Nothing is
// woken, no state changes. Tune a radius against a known week.
async function locationReplay(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = flagsOf(args, ['from', 'to', 'fence', 'device', 'user'], flags)
  const day = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s)
  const toDay = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59` : s)
  interface Replay { window: [number, number]; devices: string[]; fixes: number; events: Array<{ id: string; ts: number; fenceId: string; fenceName: string; event: string; dwellS: number; fix: { lat: number; lon: number; acc?: number; tst: number } }>; state: Record<string, { inside: boolean; since: number }> }
  const d = await hubFetch<Replay>('/location/replay', { method: 'POST', body: { from: day(opts.from), to: toDay(opts.to), fence: opts.fence, device: opts.device, user: opts.user } })
  if (flags.json) { output(d, flags); return }
  info(`${d.fixes} fixes for ${d.devices.join(', ')} ${when(d.window[0] * 1000)} → ${when(d.window[1] * 1000)}: ${d.events.length} transition${d.events.length === 1 ? '' : 's'}${opts.fence ? ` for "${opts.fence}"` : ''} (dry run — nothing fired)`)
  for (const e of d.events) info(`${when(e.ts)}  ${e.event.toUpperCase().padEnd(5)} ${e.fenceId.padEnd(22)} after ${ago(e.dwellS).replace(' ago', '')} ${e.event === 'enter' ? 'away' : 'inside'}  ${coords(e.fix)}${e.fix.acc != null ? ` ±${Math.round(e.fix.acc)} m` : ''}`)
  const end = Object.entries(d.state).map(([id, s]) => `${id}: ${s.inside ? 'INSIDE' : 'outside'}`).join(', ')
  if (end) info(`End state: ${end}`)
}

async function locationTest(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = flagsOf(args, ['event'], flags)
  const id = positionals(args)[0]
  if (!id) exitWithError('USAGE', 'Usage: con location test <fence-id> [--event enter|leave]', flags)
  const d = await hubFetch<{ event: GeofenceEvent }>(`/location/geofences/${encodeURIComponent(id!)}/test`, { method: 'POST', body: { event: opts.event ?? 'enter' } })
  if (flags.json) { output(d, flags); return }
  info(`Fired TEST ${d.event.event} for "${d.event.fenceId}" → ${d.event.delivered.map((x) => `${x.ok ? '✓' : '✗'} ${x.to}${!x.ok && x.detail ? ` (${x.detail})` : ''}`).join(', ') || 'nobody to notify'}`)
}

// con location for <user-slug> — the ONLY way to answer a third party. The hub
// applies users/<slug>.md (`location:` level / legacy allow / none) and returns
// the sentence to relay; `say: null` = refuse and tell Yousef who asked.
async function locationFor(args: string[], flags: GlobalFlags): Promise<void> {
  flagsOf(args, [], flags)
  const slug = positionals(args)[0]
  if (!slug) exitWithError('USAGE', 'Usage: con location for <user-slug>   (users/<slug>.md in AL\'s workspace)', flags)
  const d = await hubFetch<{ user: string; level: string; why: string; say: string | null; note: string }>(`/location/for/${encodeURIComponent(slug!)}`)
  if (flags.json) { output(d, flags); return }
  info(`level: ${d.level} (${d.why})`)
  info(`say: ${d.say ?? `REFUSE — ${d.note}`}`)
}

async function locationEta(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = flagsOf(args, ['mode'], flags)
  const place = positionals(args).join(' ').trim()
  if (!place) exitWithError('USAGE', 'Usage: con location eta "<place>" [--mode DRIVE|TRANSIT|WALK|BICYCLE]', flags)
  const d = await hubFetch<{ from: { lat: number; lon: number; ageS: number | null }; to: { name: string; address?: string; lat: number; lon: number }; mode: string; durationSec: number; distanceMeters: number; description: string | null; arriveAt: string }>(
    '/location/eta', { params: { to: place, mode: opts.mode?.toUpperCase() } })
  if (flags.json) { output(d, flags); return }
  const arrive = new Date(d.arriveAt).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false })
  info(`${d.to.name}${d.to.address ? `, ${d.to.address}` : ''}`)
  info(`${d.mode === 'DRIVE' ? 'Drive' : d.mode.toLowerCase()}: ${Math.round(d.durationSec / 60)} min, ${(d.distanceMeters / 1000).toFixed(1)} km${d.description ? `, via ${d.description}` : ''}; arrive ~${arrive} if leaving now (fix ${ago(d.from.ageS)}).`)
}

interface LateReport { eventId: string; calendarId?: string; summary: string; startIso: string; startsInMin: number; location: string; venue: { name: string }; mode: string; etaMin: number; distanceKm: number; arriveIso: string; lateMin: number; attendees: string[]; reAlert: boolean }

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false })

function formatLate(r: LateReport): string {
  return [
    `LATE: "${r.summary}" starts ${hhmm(r.startIso)} (in ${r.startsInMin} min) at ${r.location}`,
    `  ${r.mode === 'DRIVE' ? 'Drive' : r.mode.toLowerCase()} ETA ${r.etaMin} min (${r.distanceKm} km) → arrives ~${hhmm(r.arriveIso)}, about ${r.lateMin} min late${r.reAlert ? ' (re-alert: got worse)' : ''}`,
    `  Attendees: ${r.attendees.length ? r.attendees.join(', ') : 'none besides Yousef'}`,
    `  Event id: ${r.eventId}${r.calendarId ? `  calendar: ${r.calendarId}` : ''}`,
  ].join('\n')
}

// con location late-check [--threshold 10] [--window 180] [--mode DRIVE] [--guard]
// --guard = hub-cron guard semantics: print the report(s) and exit 0 only when
// he is late for something; otherwise print nothing and exit 1.
async function locationLateCheck(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = flagsOf(args, ['threshold', 'window', 'mode', 'guard'], flags)
  const d = await hubFetch<{ late: LateReport[]; considered: number; skipped: string | null; thresholdMin: number; windowMin: number; mode: string }>(
    '/location/late-check', { params: { threshold: opts.threshold, window: opts.window, mode: opts.mode?.toUpperCase() } })
  if (opts.guard) {
    if (!d.late.length) process.exit(1)
    console.log(d.late.map(formatLate).join('\n\n'))
    return
  }
  if (flags.json) { output(d, flags); return }
  if (!d.late.length) {
    info(d.skipped ? `Cannot judge lateness: ${d.skipped}.` : `Not late for anything in the next ${d.windowMin} min (${d.considered} placed event${d.considered === 1 ? '' : 's'} checked, threshold ${d.thresholdMin} min, ${d.mode.toLowerCase()}).`)
    return
  }
  for (const r of d.late) info(formatLate(r))
}
