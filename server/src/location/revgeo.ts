// Reverse geocoding via Nominatim, cached per ~100 m cell + zoom in
// ~/.config/console/revgeo-cache.json. Nominatim wants a User-Agent and
// ≤1 req/s; the cache keeps repeat "where is he" answers off the network.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ReverseGeo, ReverseGeocoder } from './disclose.js'

const USER_AGENT = 'console-hub-location/1 (yousef@amar.io)'

export function makeNominatimReverse(cacheFile: string, fetchImpl: typeof fetch = fetch): ReverseGeocoder {
  let cache: Record<string, ReverseGeo> | null = null
  const load = () => {
    if (cache) return cache
    try { cache = existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, ReverseGeo>) : {} } catch { cache = {} }
    return cache
  }
  const save = () => {
    try { mkdirSync(dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, JSON.stringify(cache)) } catch { /* cache is best-effort */ }
  }
  return async (lat, lon, zoom) => {
    const c = load()
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}@${zoom}`
    const hit = c[key]
    if (hit && !hit.error) return hit
    const q = new URLSearchParams({ lat: String(lat), lon: String(lon), zoom: String(zoom), format: 'jsonv2', 'accept-language': 'en' })
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 15_000)
    try {
      const res = await fetchImpl(`https://nominatim.openstreetmap.org/reverse?${q}`, { headers: { 'User-Agent': USER_AGENT }, signal: ctrl.signal })
      if (!res.ok) return { display: null, address: {}, error: `nominatim HTTP ${res.status}` }
      const d = (await res.json()) as { display_name?: string; address?: Record<string, string> }
      const out: ReverseGeo = { display: d.display_name ?? null, address: d.address ?? {} }
      c[key] = out
      save()
      return out
    } catch (err) {
      return { display: null, address: {}, error: (err as Error).message }
    } finally {
      clearTimeout(t)
    }
  }
}
