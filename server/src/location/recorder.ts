// The Recorder calls the watcher needs, all on the same basic-auth config the
// /owntracks proxy uses (auth.json `owntracks{}`); unconfigured → [] / null so
// the watcher idles instead of erroring.
//
//   /api/0/last                     latest fix per device (manual refresh)
//   /api/0/locations?from&to        history, for the replay after a gap
//   /ws/last                        live feed: send "LAST" → the last fix per
//                                   device then a literal "LAST" sentinel;
//                                   afterwards every fix the Recorder stores,
//                                   as it arrives

import WebSocket from 'ws'
import type { AuthStore } from '../auth-store.js'
import type { Fix } from './geofence.js'

interface RecorderLocation {
  _type?: string
  lat?: number
  lon?: number
  tst?: number
  acc?: number
  batt?: number
  vel?: number
  device?: string
  username?: string
  /** owntracks/<user>/<device> — the only identity the /ws/last snapshot carries */
  topic?: string
}

export function fixFromRecorder(r: RecorderLocation): Fix | null {
  if (typeof r.lat !== 'number' || typeof r.lon !== 'number' || typeof r.tst !== 'number') return null
  const fix: Fix = { lat: r.lat, lon: r.lon, tst: r.tst }
  if (typeof r.acc === 'number') fix.acc = r.acc
  if (typeof r.batt === 'number') fix.batt = r.batt
  if (typeof r.vel === 'number') fix.vel = r.vel
  const topic = typeof r.topic === 'string' ? r.topic.split('/') : []
  const device = r.device || (topic.length >= 3 ? topic[2] : undefined)
  const user = r.username || (topic.length >= 3 ? topic[1] : undefined)
  if (device) fix.device = device
  if (user) fix.user = user
  return fix
}

type Cfg = { url: string; username: string; password: string }

function configured(authStore: AuthStore): Cfg | null {
  const cfg = authStore.getOwntracksConfig()
  return cfg?.url && cfg.password ? cfg : null
}

function basic(cfg: Cfg): string {
  return `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`
}

async function getJson(cfg: Cfg, pathAndQuery: string, timeoutMs = 15_000): Promise<unknown> {
  const target = `${cfg.url.replace(/\/+$/, '')}/api/0/${pathAndQuery}`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(target, { headers: { Authorization: basic(cfg) }, signal: ctrl.signal })
    if (!res.ok) throw new Error(`recorder /${pathAndQuery.split('?')[0]} HTTP ${res.status}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(t)
  }
}

export function makeRecorderLastFetcher(authStore: AuthStore): () => Promise<Fix[]> {
  return async () => {
    const cfg = configured(authStore)
    if (!cfg) return []
    const body = await getJson(cfg, 'last')
    if (!Array.isArray(body)) return []
    return body.map((r) => fixFromRecorder(r as RecorderLocation)).filter((f): f is Fix => f !== null)
  }
}

export interface HistoryQuery {
  user: string
  device: string
  /** unix seconds, inclusive */
  fromTst: number
  /** unix seconds, inclusive */
  toTst: number
}

function isoUtc(tst: number): string {
  return new Date(tst * 1000).toISOString().replace(/\.\d{3}Z$/, '')
}

/** Recorder history in fix order. The Recorder reads from/to as UTC. */
export function makeRecorderHistoryFetcher(authStore: AuthStore): (q: HistoryQuery) => Promise<Fix[]> {
  return async (q) => {
    const cfg = configured(authStore)
    if (!cfg) return []
    const params = new URLSearchParams({ user: q.user, device: q.device, from: isoUtc(q.fromTst), to: isoUtc(q.toTst), format: 'json' })
    const body = (await getJson(cfg, `locations?${params.toString()}`, 60_000)) as { data?: unknown[] } | unknown[]
    const rows = Array.isArray(body) ? body : body?.data ?? []
    // history rows name neither device nor user — the query did
    return rows
      .map((r) => fixFromRecorder({ device: q.device, username: q.user, ...(r as RecorderLocation) }))
      .filter((f): f is Fix => f !== null)
      .sort((a, b) => a.tst - b.tst)
  }
}

export interface LiveFeedHandlers {
  /** A fix — from the LAST snapshot (before `onSnapshot`) or live (after). */
  onFix: (fix: Fix) => void
  /** The LAST snapshot is complete; everything after this is live. */
  onSnapshot: () => void
  /** The socket is gone (never fires twice per open). */
  onClose: (reason: string) => void
}

export interface LiveFeed {
  close: () => void
}

/** Open the Recorder's live WebSocket; null when OwnTracks is unconfigured. */
export type OpenLiveFeed = (h: LiveFeedHandlers) => LiveFeed | null

const PING_MS = 30_000
const DEAD_AFTER_MS = 90_000

export function makeRecorderLiveFeed(authStore: AuthStore): OpenLiveFeed {
  return (h) => {
    const cfg = configured(authStore)
    if (!cfg) return null
    const url = `${cfg.url.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws/last`
    const ws = new WebSocket(url, { headers: { Authorization: basic(cfg) }, handshakeTimeout: 15_000 })
    let closed = false
    let lastInboundAt = Date.now()
    const finish = (reason: string) => {
      if (closed) return
      closed = true
      clearInterval(pinger)
      try { ws.terminate() } catch { /* already gone */ }
      h.onClose(reason)
    }
    const pinger = setInterval(() => {
      if (Date.now() - lastInboundAt > DEAD_AFTER_MS) { finish('no frames or pongs for 90 s'); return }
      try { ws.ping() } catch { /* closing */ }
    }, PING_MS)
    pinger.unref?.()
    ws.on('open', () => { lastInboundAt = Date.now(); ws.send('LAST') })
    ws.on('pong', () => { lastInboundAt = Date.now() })
    ws.on('message', (raw) => {
      lastInboundAt = Date.now()
      const text = raw.toString()
      if (text === 'LAST') { h.onSnapshot(); return }
      if (!text.startsWith('{')) return
      let parsed: RecorderLocation
      try { parsed = JSON.parse(text) as RecorderLocation } catch { return }
      if (parsed._type && parsed._type !== 'location') return
      const fix = fixFromRecorder(parsed)
      if (fix) h.onFix(fix)
    })
    ws.on('unexpected-response', (_req, res) => finish(`HTTP ${res.statusCode}`))
    ws.on('error', (err) => finish(err.message))
    ws.on('close', (code, reason) => finish(`closed ${code}${reason.length ? ` ${reason.toString()}` : ''}`))
    return { close: () => finish('closed by hub') }
  }
}
