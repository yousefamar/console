// Google Places helpers shared by the Map tab and the calendar event form.
// Everything goes through the hub (`/gmaps/*`); the API key never reaches the browser.
import { hubFetch } from '@/hub'

export interface GPlace {
  id: string
  name: string
  address?: string
  lat: number
  lon: number
  types?: string[]
  rating?: number
  userRatingCount?: number
  googleMapsUri?: string
}

export interface GSuggestion {
  placeId: string
  text: string
  mainText: string
  secondaryText?: string
}

export interface LatLon { lat: number; lon: number }

// Places Autocomplete session token: groups a burst of keystrokes + the final
// details fetch into one billable session. Rotated after each details fetch.
let _session: string | null = null
export function gmapsSessionToken(): string {
  if (!_session) _session = crypto.randomUUID()
  return _session
}
export function resetGmapsSession(): void {
  _session = null
}

/** Is a Maps Platform key configured on the hub? Probed once per page load. */
let _configured: Promise<boolean> | null = null
export function gmapsConfigured(): Promise<boolean> {
  if (!_configured) {
    _configured = hubFetch<{ configured: boolean }>('/gmaps/status')
      .then((r) => r.configured)
      .catch(() => { _configured = null; return false })
  }
  return _configured
}

/** Type-ahead suggestions for `input`, optionally biased around a point. */
export async function autocompletePlaces(input: string, bias?: LatLon): Promise<GSuggestion[]> {
  const q = input.trim()
  if (q.length < 2) return []
  const params = new URLSearchParams({ q, session: gmapsSessionToken() })
  if (bias) {
    params.set('lat', String(bias.lat))
    params.set('lon', String(bias.lon))
  }
  const { suggestions } = await hubFetch<{ suggestions: GSuggestion[] }>(`/gmaps/autocomplete?${params.toString()}`)
  return suggestions
}

/** Resolve a suggestion to a full place. Ends the autocomplete billing session. */
export async function fetchPlace(placeId: string): Promise<GPlace> {
  const params = new URLSearchParams({ session: gmapsSessionToken() })
  const { place } = await hubFetch<{ place: GPlace }>(`/gmaps/place/${encodeURIComponent(placeId)}?${params.toString()}`)
  resetGmapsSession()
  return place
}

/** "Name, formatted address" the way Google Calendar fills its own location field. */
export function placeLocationText(place: GPlace): string {
  const { name, address } = place
  if (!address) return name
  if (!name || address.toLowerCase().startsWith(name.toLowerCase())) return address
  return `${name}, ${address}`
}

/** Yousef's latest phone fix from the hub, for biasing suggestions. Cached 10 min. */
let _fix: { at: number; value: LatLon | null } | null = null
export async function lastKnownLocation(): Promise<LatLon | null> {
  if (_fix && Date.now() - _fix.at < 10 * 60_000) return _fix.value
  let value: LatLon | null = null
  try {
    const r = await hubFetch<{ fix: LatLon | null }>('/location')
    if (r.fix && Number.isFinite(r.fix.lat) && Number.isFinite(r.fix.lon)) value = { lat: r.fix.lat, lon: r.fix.lon }
  } catch { /* no fix — unbiased suggestions still work */ }
  _fix = { at: Date.now(), value }
  return value
}
