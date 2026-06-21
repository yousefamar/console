// Pure parsers for geocaching.com responses. Kept side-effect-free so they're
// unit-testable against captured fixtures — the bits most likely to break when
// gc.com changes its markup, and the bits the upstream-watch cron re-checks.

import { parseHTML } from 'linkedom'
import {
  cacheFromApiRecord,
  humanizeSlug,
  logTypeName,
  rot13,
  type Geocache,
  type GeocacheAttribute,
  type GeocacheLog,
  type GeocacheWaypoint,
} from './types.js'

export interface SearchPage {
  caches: Geocache[]
  total: number
}

export function parseSearchResults(json: unknown): SearchPage {
  const obj = (json ?? {}) as { results?: unknown[]; total?: number }
  const results = Array.isArray(obj.results) ? obj.results : []
  return {
    caches: results.map((r) => cacheFromApiRecord(r as Record<string, unknown>)),
    total: typeof obj.total === 'number' ? obj.total : results.length,
  }
}

export interface CacheDetailParse {
  name: string | null
  hint: string
  description: string
  attributes: GeocacheAttribute[]
  waypoints: GeocacheWaypoint[]
  favorites: number | null
  /** Token needed to fetch the logbook (`userToken = '...'` in page JS). */
  userToken: string | null
}

export function parseCacheDetail(html: string): CacheDetailParse {
  const { document } = parseHTML(html)
  const text = (sel: string): string => document.querySelector(sel)?.textContent?.trim() ?? ''

  const hintRaw = text('#div_hint')
  const hint = hintRaw ? rot13(hintRaw) : ''

  const description = text('#ctl00_ContentBody_LongDescription') || text('#ctl00_ContentBody_ShortDescription')

  const attributes: GeocacheAttribute[] = []
  const seen = new Set<string>()
  for (const img of document.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    if (!src.includes('/images/attributes/')) continue
    const file = src.split('/').pop() ?? ''
    const stem = file.replace(/\.[a-z0-9]+$/i, '') // e.g. "dogs-yes"
    const dash = stem.lastIndexOf('-')
    if (dash < 0) continue
    const slug = stem.slice(0, dash)
    const state = stem.slice(dash + 1)
    if (!slug || slug === 'attribute') continue // "attribute-blank" spacer
    if (seen.has(slug)) continue
    seen.add(slug)
    attributes.push({ slug, label: humanizeSlug(slug), enabled: state === 'yes' })
  }

  const favText = text('.favorite-value')
  const favorites = favText ? parseInt(favText.replace(/[^\d]/g, ''), 10) || 0 : null

  const tokenMatch = /userToken\s*=\s*'([^']+)'/.exec(html)

  return {
    name: text('#ctl00_ContentBody_CacheName') || null,
    hint,
    description,
    attributes,
    waypoints: parseWaypoints(document),
    favorites,
    userToken: tokenMatch ? tokenMatch[1] : null,
  }
}

function parseWaypoints(document: Document): GeocacheWaypoint[] {
  // Best-effort: the additional-waypoints table is brittle (alternating rows).
  // Extract what we cleanly can; degrade to [] rather than throw.
  const out: GeocacheWaypoint[] = []
  const table = document.querySelector('#ctl00_ContentBody_Waypoints')
  if (!table) return out
  for (const row of table.querySelectorAll('tr')) {
    const cells = [...row.querySelectorAll('td')].map((c) => c.textContent?.trim() ?? '')
    if (cells.length < 7) continue
    const id = cells.find((c) => /^[A-Z0-9]{2,}$/.test(c)) ?? ''
    const coordCell = cells.find((c) => /[NSEW]\s*\d/.test(c)) ?? ''
    if (!id && !coordCell) continue
    const ll = parseDegMin(coordCell)
    out.push({ id, type: cells[1] ?? '', lat: ll?.lat ?? null, lon: ll?.lon ?? null, note: '' })
  }
  return out
}

/** Parse "N 51° 27.123 W 000° 57.456" → decimal degrees. */
export function parseDegMin(s: string): { lat: number; lon: number } | null {
  const m = /([NS])\s*(\d+)[°\s]+([\d.]+).*?([EW])\s*(\d+)[°\s]+([\d.]+)/.exec(s)
  if (!m) return null
  const lat = (parseInt(m[2], 10) + parseFloat(m[3]) / 60) * (m[1] === 'S' ? -1 : 1)
  const lon = (parseInt(m[5], 10) + parseFloat(m[6]) / 60) * (m[4] === 'W' ? -1 : 1)
  return { lat, lon }
}

interface LogbookEntry {
  LogGuid?: string
  LogTypeImage?: string
  LogText?: string
  Visited?: string
  UserName?: string
}

export function parseLogbook(json: unknown): GeocacheLog[] {
  const obj = (json ?? {}) as { data?: LogbookEntry[]; status?: string }
  const data = Array.isArray(obj.data) ? obj.data : []
  return data.map((d) => ({
    id: d.LogGuid ?? '',
    type: logTypeName((d.LogTypeImage ?? '').replace(/\.[a-z0-9]+$/i, '')),
    text: d.LogText ?? '',
    date: (d.Visited ?? '').split('T')[0],
    author: d.UserName ?? '',
  }))
}
