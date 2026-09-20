// The one Recorder call the watcher needs: latest fix per device, mapped to
// our `Fix`. Same basic-auth config the /owntracks proxy uses (auth.json
// `owntracks{}`); unconfigured → [] so the watcher idles instead of erroring.

import type { AuthStore } from '../auth-store.js'
import type { Fix } from './geofence.js'

interface RecorderLast {
  _type?: string
  lat?: number
  lon?: number
  tst?: number
  acc?: number
  batt?: number
  vel?: number
  device?: string
  username?: string
}

export function fixFromRecorder(r: RecorderLast): Fix | null {
  if (typeof r.lat !== 'number' || typeof r.lon !== 'number' || typeof r.tst !== 'number') return null
  const fix: Fix = { lat: r.lat, lon: r.lon, tst: r.tst }
  if (typeof r.acc === 'number') fix.acc = r.acc
  if (typeof r.batt === 'number') fix.batt = r.batt
  if (typeof r.vel === 'number') fix.vel = r.vel
  if (r.device) fix.device = r.device
  if (r.username) fix.user = r.username
  return fix
}

export function makeRecorderLastFetcher(authStore: AuthStore): () => Promise<Fix[]> {
  return async () => {
    const cfg = authStore.getOwntracksConfig()
    if (!cfg?.url || !cfg.password) return []
    const target = `${cfg.url.replace(/\/+$/, '')}/api/0/last`
    const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 15_000)
    try {
      const res = await fetch(target, { headers: { Authorization: `Basic ${auth}` }, signal: ctrl.signal })
      if (!res.ok) throw new Error(`recorder /last HTTP ${res.status}`)
      const body = (await res.json()) as unknown
      if (!Array.isArray(body)) return []
      return body.map((r) => fixFromRecorder(r as RecorderLast)).filter((f): f is Fix => f !== null)
    } finally {
      clearTimeout(t)
    }
  }
}
