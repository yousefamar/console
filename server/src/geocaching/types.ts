// Geocaching.com data model + enum tables.
//
// Ported from the `pycaching` Python library (github.com/tomasbedrich/pycaching),
// which we reimplement here so the Console hub can fetch geocache data by
// scraping Yousef's own logged-in session. Enum ids are verbatim from
// pycaching's cache.py / log.py so they track the real geocaching.com values.
// A weekly cron watches pycaching's releases.atom to fold upstream fixes in.

/** geocacheType id (search/v2) / SVG icon number → human label. */
export const CACHE_TYPES: Record<number, string> = {
  2: 'Traditional',
  3: 'Multi-cache',
  8: 'Mystery',
  5: 'Letterbox',
  6: 'Event',
  453: 'Mega-Event',
  7005: 'Giga-Event',
  137: 'EarthCache',
  13: 'Cache In Trash Out Event',
  11: 'Webcam',
  4: 'Virtual',
  1858: 'Wherigo',
  3653: 'Community Celebration',
  9: 'Project APE',
  3773: 'Geocaching HQ',
  1304: 'GPS Adventures Exhibit',
  4738: 'HQ Block Party',
  12: 'Locationless',
  3774: 'HQ Celebration',
}

/** search/v2 containerType id → size label. */
export const SIZE_BY_CONTAINER_TYPE: Record<number, string> = {
  1: 'not chosen',
  2: 'micro',
  3: 'regular',
  4: 'large',
  5: 'virtual',
  6: 'other',
  8: 'small',
}

/** Log type id (from the logbook image filename, ext stripped) → name. */
export const LOG_TYPES: Record<string, string> = {
  '74': 'announcement',
  '5': 'archive',
  '6': 'archive',
  '10': 'attended',
  '3': 'didnt_find_it',
  '48': 'discovered_it',
  '23': 'enable_listing',
  '2': 'found_it',
  '19': 'grabbed_it',
  '16': 'marked_missing',
  '7': 'needs_archive',
  '45': 'needs_maintenance',
  '4': 'note',
  '83': 'oc_team_comment',
  '46': 'owner_maintenance',
  '14': 'placed_it',
  '18': 'post_reviewer_note',
  '68': 'post_reviewer_note',
  '24': 'publish_listing',
  '1003': 'publish_listing',
  '25': 'retract',
  '13': 'retrieved_it',
  '76': 'submit_for_review',
  '22': 'temp_disable_listing',
  '12': 'unarchive',
  '1': 'unarchive',
  '47': 'update_coordinates',
  '75': 'visit',
  '1001': 'visit',
  '11': 'webcam_photo_taken',
  '9': 'will_attend',
}

/** cacheStatus id (search/v2) → name. */
export const STATUS_BY_ID: Record<number, string> = {
  0: 'enabled',
  1: 'disabled',
  2: 'archived',
  3: 'unpublished',
  4: 'locked',
}

/** A few attribute slugs whose humanized form reads badly; the rest fall back
 *  to `humanizeSlug`. The slug itself is the source of truth (parsed off the
 *  attribute image filename), so this is purely presentational. */
export const ATTRIBUTE_LABELS: Record<string, string> = {
  abandonedbuilding: 'Abandoned structure',
  cliff: 'Cliff / falling rocks',
  cito: 'CITO',
  kids: 'Recommended for kids',
  onehour: 'Takes less than an hour',
  parkngrab: 'Park and grab',
  poisonoak: 'Poison plants',
  rappelling: 'Climbing gear',
  s_tool: 'Special tool required',
  scenic: 'Scenic view',
  stealth: 'Stealth required',
  stroller: 'Stroller accessible',
  uv: 'UV light required',
  wheelchair: 'Wheelchair accessible',
}

export interface GeocacheLog {
  id: string
  type: string // log type name, e.g. 'found_it'
  text: string
  date: string // 'YYYY-MM-DD'
  author: string
}

export interface GeocacheAttribute {
  slug: string // machine name, e.g. 'dogs'
  label: string // humanized
  enabled: boolean // yes/no variant of the attribute image
}

export interface GeocacheWaypoint {
  id: string
  type: string
  lat: number | null
  lon: number | null
  note: string
}

export interface GeocacheDetail {
  hint: string
  description: string
  attributes: GeocacheAttribute[]
  logs: GeocacheLog[]
  waypoints: GeocacheWaypoint[]
  fetchedAt: number
}

export interface Geocache {
  code: string // GC code, e.g. 'GC1PAR2'
  name: string
  lat: number | null
  lon: number | null
  type: string
  size: string
  difficulty: number
  terrain: number
  found: boolean
  pmOnly: boolean
  owner: string
  hidden: string // placed date 'YYYY-MM-DD'
  favorites: number
  status: string
  fetchedAt: number // when the summary was last refreshed
  detail?: GeocacheDetail
}

/** Bounding box [south, west, north, east]. */
export type BBox = [number, number, number, number]

export function typeName(geocacheType: number | undefined): string {
  return (geocacheType != null && CACHE_TYPES[geocacheType]) || 'Unknown'
}

export function sizeName(containerType: number | undefined): string {
  return (containerType != null && SIZE_BY_CONTAINER_TYPE[containerType]) || 'unknown'
}

export function logTypeName(filenameStem: string): string {
  return LOG_TYPES[filenameStem] || 'unknown'
}

export function humanizeSlug(slug: string): string {
  if (ATTRIBUTE_LABELS[slug]) return ATTRIBUTE_LABELS[slug]
  const spaced = slug.replace(/[-_]+/g, ' ').trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : slug
}

/** ROT13 — geocaching.com hints are ROT13-encoded in the page. */
export function rot13(input: string): string {
  return input.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
  })
}

/** Map a raw search/v2 record onto our Geocache summary (pycaching _from_api_record). */
export function cacheFromApiRecord(record: Record<string, unknown>): Geocache {
  const coords = record.postedCoordinates as { latitude?: number; longitude?: number } | undefined
  const owner = record.owner as { username?: string } | undefined
  const placed = typeof record.placedDate === 'string' ? record.placedDate.split('T')[0] : ''
  return {
    code: String(record.code ?? ''),
    name: String(record.name ?? ''),
    lat: coords?.latitude ?? null,
    lon: coords?.longitude ?? null,
    type: typeName(record.geocacheType as number | undefined),
    size: sizeName(record.containerType as number | undefined),
    difficulty: Number(record.difficulty ?? 0),
    terrain: Number(record.terrain ?? 0),
    found: 'userFound' in record ? Boolean(record.userFound) : false,
    pmOnly: Boolean(record.premiumOnly),
    owner: owner?.username ?? '',
    hidden: placed,
    favorites: Number(record.favoritePoints ?? 0),
    status: STATUS_BY_ID[record.cacheStatus as number] ?? 'enabled',
    fetchedAt: Date.now(),
  }
}
