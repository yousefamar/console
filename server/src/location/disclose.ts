// Disclosure — what a given person may be told about where Yousef is.
//
// The policy is the frontmatter of that person's `users/<slug>.md` in AL's
// workspace: `trust: owner` → exact; `location: <level>`; legacy
// `allow: [location]` → exact (`location:city` etc. inside allow also work);
// nothing → none. The TOOL applies the level so a non-owner conversation never
// has the raw fix in its context — prose rules can be argued with, this can't.
//
// Inside a PRIVATE fence (home) the fine levels collapse to the fence's name.
// Backstop when no fence matched: a reverse-geocode naming a term from the
// WhatsApp send censor (his address) collapses the same way.

import type { CurrentLocation } from './watcher.js'

export const LEVELS = ['none', 'country', 'city', 'area', 'exact'] as const
export type Level = (typeof LEVELS)[number]

/** Nominatim `zoom` per level — the geocoder's own granularity ladder. */
export const ZOOM: Record<Exclude<Level, 'none'>, number> = { country: 3, city: 10, area: 14, exact: 18 }

export interface ReverseGeo {
  display: string | null
  address: Record<string, string>
  error?: string
}

export type ReverseGeocoder = (lat: number, lon: number, zoom: number) => Promise<ReverseGeo>

export function isLevel(v: unknown): v is Level {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
}

/** Policy → level, with the matching rule named for the log. */
export function levelFor(frontmatter: Record<string, string | string[]> | null): { level: Level; why: string } {
  if (!frontmatter) return { level: 'none', why: 'unknown sender (no user file)' }
  if (String(frontmatter.trust ?? '').toLowerCase() === 'owner') return { level: 'exact', why: 'trust: owner' }
  const lv = String(frontmatter.location ?? '').toLowerCase().trim()
  if (isLevel(lv)) return { level: lv, why: `location: ${lv}` }
  const allow = Array.isArray(frontmatter.allow) ? frontmatter.allow : frontmatter.allow ? [frontmatter.allow] : []
  for (const raw of allow) {
    const a = String(raw).toLowerCase().trim()
    if (a === 'location') return { level: 'exact', why: 'allow: location' }
    if (a.startsWith('location:')) {
      const sub = a.slice('location:'.length)
      if (isLevel(sub)) return { level: sub, why: `allow: ${a}` }
    }
  }
  return { level: 'none', why: 'not in allow' }
}

function cityOf(a: Record<string, string>): string | undefined {
  return a.city || a.town || a.village || a.municipality || a.county
}

/** The words for one level from a Nominatim address block. */
export function placeWords(address: Record<string, string> | undefined, level: Exclude<Level, 'none'>): string {
  const a = address ?? {}
  const city = cityOf(a)
  const country = a.country
  if (level === 'country') return country ? `in ${country}` : 'location unknown'
  if (level === 'city') return city ? `in ${city}` : country ? `in ${country}` : 'location unknown'
  const local = a.neighbourhood || a.suburb || a.quarter || a.road || a.hamlet
  if (level === 'area') return local && city ? `in ${city}, around ${local}` : `in ${city || country || 'an unknown place'}`
  const parts = [a.house_number, a.road, a.suburb, city, a.postcode].filter(Boolean)
  return parts.join(', ') || city || country || 'unknown'
}

export function ageWords(ageS: number | null): string {
  if (ageS == null || ageS < 10 * 60) return ''
  if (ageS < 3600) return ` (as of ${Math.floor(ageS / 60)} min ago)`
  if (ageS < 86400) return ` (last seen ${(ageS / 3600).toFixed(1)} h ago)`
  return ` (last seen ${Math.floor(ageS / 86400)} d ago)`
}

export interface Disclosure {
  level: Level
  why: string
  /** The sentence to relay verbatim; null = refuse. */
  say: string | null
  note: string
  /** Only on `exact` outside a private zone. */
  lat?: number
  lon?: number
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export async function disclose(
  policy: { level: Level; why: string },
  cur: CurrentLocation,
  revgeo: ReverseGeocoder,
  blockedTerms: string[],
): Promise<Disclosure> {
  const { level, why } = policy
  if (level === 'none') return { level, why, say: null, note: 'do not disclose; tell Yousef who asked' }
  const fix = cur.fix
  if (!fix) return { level, why, say: "I can't see where Yousef is right now.", note: 'no fix' }
  const stale = ageWords(cur.ageS)
  let privateZone = cur.inside.find((i) => i.private)
  const named = cur.inside.find((i) => !i.private)
  const geo = await revgeo(fix.lat, fix.lon, ZOOM[level])
  const fine = level === 'area' || level === 'exact'
  if (fine && !privateZone && geo.display) {
    const hay = normalizeForMatch(geo.display)
    if (blockedTerms.some((t) => t && hay.includes(normalizeForMatch(t)))) privateZone = { id: 'home', name: 'Home', private: true }
  }
  if (fine && privateZone) {
    const cityGeo = await revgeo(fix.lat, fix.lon, ZOOM.city)
    const city = placeWords(cityGeo.address, 'city').replace(/^in /, '')
    return { level, why, say: `At ${privateZone.name.toLowerCase()} (${city})${stale}.`, note: `inside private fence ${privateZone.id}: no coordinates` }
  }
  const words = placeWords(geo.address, level)
  if (level === 'exact') {
    const pin = `https://maps.google.com/?q=${fix.lat.toFixed(5)},${fix.lon.toFixed(5)}`
    const say = `${named ? `At ${named.name} — ` : ''}${words}${stale}. Pin: ${pin}`
    return { level, why, say, note: 'exact', lat: fix.lat, lon: fix.lon }
  }
  const say = level === 'area' && named ? `Yousef is at ${named.name}, ${words}${stale}.` : `Yousef is ${words}${stale}.`
  return { level, why, say, note: level }
}
