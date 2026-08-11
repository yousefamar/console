// Google Maps Platform client — thin wrapper the hub proxies /gmaps/* through.
//
// Two APIs, both keyed by a single Cloud key (X-Goog-Api-Key header):
//   • Places API (New) — POST places:searchText for "find a location" search.
//   • Routes API       — POST directions/v2:computeRoutes for directions,
//     asking for alternate routes + returning each route's duration + geometry.
//
// We request GeoJSON polylines (polylineEncoding: GEO_JSON_LINESTRING) so the
// route geometry drops straight onto MapLibre with no encoded-polyline decode.
//
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
//       https://developers.google.com/maps/documentation/routes/compute_route_directions

import type { AuthStore } from '../auth-store.js'

const PLACES_BASE = 'https://places.googleapis.com/v1'
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes'

// UK-centric bias when the caller gives no location.
const DEFAULT_REGION = 'gb'

export interface PlaceResult {
  id: string
  name: string
  address?: string
  lat: number
  lon: number
  /** google.maps place types, e.g. ["restaurant","food"] */
  types?: string[]
  rating?: number
  userRatingCount?: number
  /** deep-link for "open in Google Maps" on mobile */
  googleMapsUri?: string
}

export type TravelMode = 'DRIVE' | 'WALK' | 'BICYCLE' | 'TRANSIT'

export interface RouteResult {
  /** Google's own short human label, e.g. "M4 and A404(M)" */
  description?: string
  /** seconds */
  durationSec: number
  /** metres */
  distanceMeters: number
  /** GeoJSON LineString geometry (lng,lat pairs) for the whole route */
  geometry: { type: 'LineString'; coordinates: [number, number][] }
}

export interface LatLon {
  lat: number
  lon: number
}

export interface ComputeRoutesInput {
  origin: LatLon
  destination: LatLon
  travelMode?: TravelMode
  /** ask Google for alternate routes (default true) */
  alternatives?: boolean
}

export class GoogleMapsClient {
  constructor(private readonly auth: AuthStore) {}

  isConfigured(): boolean {
    return !!this.auth.getGoogleMapsKey()
  }

  private requireKey(): string {
    const k = this.auth.getGoogleMapsKey()
    if (!k) throw apiError(412, 'Google Maps key not configured. POST /gmaps/credentials with {apiKey}')
    return k
  }

  /** Places API (New) text search. `bias` nudges results toward a viewport. */
  async searchText(query: string, bias?: { lat: number; lon: number; radiusMeters?: number }): Promise<PlaceResult[]> {
    const apiKey = this.requireKey()
    const body: Record<string, unknown> = {
      textQuery: query,
      regionCode: DEFAULT_REGION,
      maxResultCount: 12,
    }
    if (bias) {
      body.locationBias = {
        circle: {
          center: { latitude: bias.lat, longitude: bias.lon },
          radius: Math.min(Math.max(bias.radiusMeters ?? 20000, 1), 50000),
        },
      }
    }
    const fieldMask = [
      'places.id',
      'places.displayName',
      'places.formattedAddress',
      'places.location',
      'places.types',
      'places.rating',
      'places.userRatingCount',
      'places.googleMapsUri',
    ].join(',')

    const res = await fetch(`${PLACES_BASE}/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw apiError(res.status, `Places searchText failed: ${res.status} ${text.slice(0, 300)}`)
    let data: any
    try { data = JSON.parse(text) } catch { data = {} }
    const places: any[] = Array.isArray(data.places) ? data.places : []
    return places
      .filter((p) => p?.location?.latitude != null && p?.location?.longitude != null)
      .map((p): PlaceResult => ({
        id: String(p.id ?? ''),
        name: p.displayName?.text ?? p.formattedAddress ?? 'Unknown',
        address: p.formattedAddress,
        lat: p.location.latitude,
        lon: p.location.longitude,
        types: Array.isArray(p.types) ? p.types : undefined,
        rating: typeof p.rating === 'number' ? p.rating : undefined,
        userRatingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : undefined,
        googleMapsUri: p.googleMapsUri,
      }))
  }

  /** Routes API — origin→destination with alternate routes + geometry. */
  async computeRoutes(input: ComputeRoutesInput): Promise<RouteResult[]> {
    const apiKey = this.requireKey()
    const mode = input.travelMode ?? 'DRIVE'
    const body: Record<string, unknown> = {
      origin: { location: { latLng: { latitude: input.origin.lat, longitude: input.origin.lon } } },
      destination: { location: { latLng: { latitude: input.destination.lat, longitude: input.destination.lon } } },
      travelMode: mode,
      computeAlternativeRoutes: input.alternatives ?? true,
      polylineEncoding: 'GEO_JSON_LINESTRING',
      units: 'METRIC',
    }
    // routingPreference is only valid for DRIVE / TWO_WHEELER — sending it for
    // WALK/BICYCLE/TRANSIT 400s the request.
    if (mode === 'DRIVE') body.routingPreference = 'TRAFFIC_AWARE'

    const fieldMask = [
      'routes.duration',
      'routes.distanceMeters',
      'routes.description',
      'routes.polyline.geoJsonLinestring',
    ].join(',')

    const res = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw apiError(res.status, `Routes computeRoutes failed: ${res.status} ${text.slice(0, 300)}`)
    let data: any
    try { data = JSON.parse(text) } catch { data = {} }
    const routes: any[] = Array.isArray(data.routes) ? data.routes : []
    return routes
      .map((r): RouteResult | null => {
        const geom = r?.polyline?.geoJsonLinestring
        if (!geom || geom.type !== 'LineString' || !Array.isArray(geom.coordinates)) return null
        return {
          description: r.description,
          durationSec: parseDurationSeconds(r.duration),
          distanceMeters: typeof r.distanceMeters === 'number' ? r.distanceMeters : 0,
          geometry: { type: 'LineString', coordinates: geom.coordinates },
        }
      })
      .filter((r): r is RouteResult => r != null)
  }
}

/** Routes API returns duration as a protobuf-style "1234s" string. */
export function parseDurationSeconds(d: unknown): number {
  if (typeof d === 'number') return d
  if (typeof d === 'string') {
    const m = d.match(/^(\d+(?:\.\d+)?)s$/)
    if (m) return Math.round(parseFloat(m[1]!))
    const n = Number(d)
    if (!isNaN(n)) return n
  }
  return 0
}

function apiError(status: number, message: string): Error {
  const e = new Error(message) as Error & { status: number }
  e.status = status
  return e
}
