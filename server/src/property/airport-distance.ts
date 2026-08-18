// Nearest-airport driving + transit time for a single property listing.
//
// The isochrone that defines a search's polygon (~60 min drive of one of
// these airports) is a boolean gate: every listing that reaches us already
// passed it, but the polygon itself carries no number and doesn't say which
// airport. This computes the actual figure for one listing at a time, via
// the Routes API (Google Maps Platform key required — see gmaps/client.ts).
//
// Airport lists per country, curated in the vault
// (~/sync/brain/root/projects/home/{manifest,fra-reachable}.json) — the same
// airports whose isochrones were unioned into the search polygon in the first
// place, so "nearest of these" is the right question by construction.

import type { GoogleMapsClient, LatLon } from '../gmaps/client.js'
import type { Country } from './store.js'

export interface Airport {
  iata: string
  name: string
  lat: number
  lon: number
}

// UK: data/manifest.json (all 26 UK international airports fetched for the
// isochrone build). DE/IT: the Germany/Italy subset of data/fra-reachable.json
// (airports with a direct FRA connection within 180 min great-circle est.).
export const AIRPORTS_BY_COUNTRY: Record<Country, Airport[]> = {
  UK: [
    { iata: 'EXT', name: 'Exeter Airport', lat: 50.734849, lon: -3.4138105 },
    { iata: 'MME', name: 'Teesside International Airport', lat: 54.509306, lon: -1.4274728 },
    { iata: 'BRS', name: 'Bristol Airport', lat: 51.3830799, lon: -2.7186615 },
    { iata: 'NCL', name: 'Newcastle International Airport', lat: 55.0385826, lon: -1.6925163 },
    { iata: 'ABZ', name: 'Aberdeen International Airport', lat: 57.2022306, lon: -2.1990857 },
    { iata: 'PIK', name: 'Glasgow Prestwick Airport', lat: 55.5021692, lon: -4.5948374 },
    { iata: 'SOU', name: 'Southampton Airport', lat: 50.9513872, lon: -1.3516684 },
    { iata: 'SEN', name: 'London Southend Airport', lat: 51.5701749, lon: 0.6924624 },
    { iata: 'LTN', name: 'London Luton Airport', lat: 51.8780363, lon: -0.3701408 },
    { iata: 'LCY', name: 'London City Airport', lat: 51.5042658, lon: 0.0539987 },
    { iata: 'BFS', name: 'Belfast International Airport', lat: 54.6527839, lon: -6.2152983 },
    { iata: 'INV', name: 'Inverness Airport', lat: 57.5431698, lon: -4.0476971 },
    { iata: 'LGW', name: 'London Gatwick Airport', lat: 51.1540929, lon: -0.1884007 },
    { iata: 'CWL', name: 'Cardiff Airport', lat: 51.3978598, lon: -3.343817 },
    { iata: 'BOH', name: 'Bournemouth Airport', lat: 50.7825186, lon: -1.8422929 },
    { iata: 'EDI', name: 'Edinburgh Airport', lat: 55.9500825, lon: -3.3614651 },
    { iata: 'STN', name: 'London Stansted Airport', lat: 51.8869677, lon: 0.2429264 },
    { iata: 'GLA', name: 'Glasgow Airport', lat: 55.8705835, lon: -4.4351667 },
    { iata: 'BHD', name: 'George Best Belfast City Airport', lat: 54.6202182, lon: -5.8699556 },
    { iata: 'MAN', name: 'Manchester Airport', lat: 53.3503197, lon: -2.2798822 },
    { iata: 'BHX', name: 'Birmingham Airport', lat: 52.4543843, lon: -1.7468974 },
    { iata: 'LDY', name: 'City of Derry Airport', lat: 55.0419148, lon: -7.1631528 },
    { iata: 'EMA', name: 'East Midlands Airport', lat: 52.8281122, lon: -1.3322143 },
    { iata: 'LBA', name: 'Leeds Bradford Airport', lat: 53.8667047, lon: -1.660138 },
    { iata: 'LHR', name: 'London Heathrow Airport', lat: 51.4677522, lon: -0.4547736 },
    { iata: 'LPL', name: 'Liverpool John Lennon Airport', lat: 53.3357677, lon: -2.8502323 },
  ],
  DE: [
    { iata: 'FRA', name: 'Frankfurt am Main Airport', lat: 50.033333, lon: 8.570556 },
    { iata: 'STR', name: 'Stuttgart Airport', lat: 48.6898994446, lon: 9.22196006775 },
    { iata: 'DUS', name: 'Düsseldorf Airport', lat: 51.289501, lon: 6.76678 },
    { iata: 'NUE', name: 'Nuremberg Airport', lat: 49.498699, lon: 11.078056 },
    { iata: 'HAJ', name: 'Hannover Airport', lat: 52.461101532, lon: 9.68507957458 },
    { iata: 'MUC', name: 'Munich Airport', lat: 48.353802, lon: 11.7861 },
    { iata: 'LEJ', name: 'Leipzig/Halle Airport', lat: 51.423889, lon: 12.236389 },
    { iata: 'BRE', name: 'Bremen Airport', lat: 53.0475006104, lon: 8.78666973114 },
    { iata: 'DRS', name: 'Dresden Airport', lat: 51.1328010559, lon: 13.7672004700 },
    { iata: 'HAM', name: 'Hamburg Airport', lat: 53.630401611328, lon: 9.9882297515869 },
    { iata: 'GWT', name: 'Westerland Sylt Airport', lat: 54.9132003784, lon: 8.34047031403 },
  ],
  IT: [
    { iata: 'MXP', name: 'Malpensa International Airport', lat: 45.6306, lon: 8.72811 },
    { iata: 'LIN', name: 'Milano Linate Airport', lat: 45.445099, lon: 9.27674 },
    { iata: 'TRN', name: 'Turin Airport', lat: 45.200802, lon: 7.64963 },
    { iata: 'VRN', name: 'Verona Villafranca Airport', lat: 45.395699, lon: 10.8885 },
    { iata: 'VCE', name: 'Venice Marco Polo Airport', lat: 45.505299, lon: 12.3519 },
    { iata: 'TRS', name: 'Trieste–Friuli Venezia Giulia Airport', lat: 45.827499, lon: 13.4722 },
    { iata: 'BLQ', name: 'Bologna Guglielmo Marconi Airport', lat: 44.5354, lon: 11.2887 },
    { iata: 'FLR', name: 'Peretola Airport', lat: 43.810001, lon: 11.2051 },
    { iata: 'PSA', name: 'Pisa International Airport', lat: 43.683899, lon: 10.3927 },
    { iata: 'FCO', name: 'Leonardo da Vinci–Fiumicino Airport', lat: 41.8002778, lon: 12.2388889 },
    { iata: 'OLB', name: 'Olbia Costa Smeralda Airport', lat: 40.898701, lon: 9.51763 },
    { iata: 'NAP', name: 'Naples International Airport', lat: 40.886002, lon: 14.2908 },
    { iata: 'BRI', name: 'Bari Karol Wojtyła Airport', lat: 41.138901, lon: 16.760599 },
    { iata: 'BDS', name: 'Brindisi – Salento Airport', lat: 40.6576, lon: 17.947001 },
    { iata: 'PMO', name: 'Falcone–Borsellino Airport', lat: 38.175999, lon: 13.091 },
    { iata: 'SUF', name: 'Lamezia Terme Airport', lat: 38.905399, lon: 16.2423 },
    { iata: 'CTA', name: 'Catania-Fontanarossa Airport', lat: 37.466801, lon: 15.0664 },
  ],
}

export interface AirportDistance {
  airport: Airport
  driveMinutes: number
  transitMinutes: number | null
}

/** Great-circle distance, km — cheap pre-filter before spending Routes calls. */
function haversineKm(a: LatLon, b: LatLon): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** How many of the closest-by-air-line airports to actually query with Routes. */
const CANDIDATE_COUNT = 3

/**
 * Next weekday 09:00 UTC strictly in the future — a reasonable, reproducible
 * "typical commute-ish morning" departure for TRANSIT, never a dead-of-night
 * or weekend-service query. Re-derived per call (not cached) since "next
 * weekday" changes every day.
 */
export function nextWeekdayMorningUtc(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0))
  if (d <= now) d.setUTCDate(d.getUTCDate() + 1)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Nearest airport to a point by real drive time, plus that same airport's
 * transit time. Narrows to the `CANDIDATE_COUNT` closest airports by
 * straight-line distance first (cheap), then asks Routes for real drive time
 * on just those — a straight-line-nearest airport is usually but not always
 * the fastest-to-reach one (motorway layout, river crossings), so checking a
 * few is worth the extra calls; checking all 11-26 per country isn't.
 */
export async function nearestAirport(gmaps: GoogleMapsClient, point: LatLon, country: Country): Promise<AirportDistance | null> {
  const airports = AIRPORTS_BY_COUNTRY[country]
  if (!airports.length) return null

  const candidates = airports
    .map((a) => ({ airport: a, km: haversineKm(point, a) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, CANDIDATE_COUNT)

  const driveResults = await Promise.all(
    candidates.map(async ({ airport }) => {
      try {
        const routes = await gmaps.computeRoutes({ origin: point, destination: airport, travelMode: 'DRIVE', alternatives: false })
        const fastest = routes.sort((a, b) => a.durationSec - b.durationSec)[0]
        return fastest ? { airport, driveSec: fastest.durationSec } : null
      } catch {
        return null
      }
    }),
  )
  const valid = driveResults.filter((r): r is { airport: Airport; driveSec: number } => r != null)
  if (!valid.length) return null
  const nearest = valid.sort((a, b) => a.driveSec - b.driveSec)[0]!

  let transitMinutes: number | null = null
  try {
    const transitRoutes = await gmaps.computeRoutes({
      origin: point,
      destination: nearest.airport,
      travelMode: 'TRANSIT',
      alternatives: false,
      departureTime: nextWeekdayMorningUtc(),
    })
    const fastest = transitRoutes.sort((a, b) => a.durationSec - b.durationSec)[0]
    if (fastest) transitMinutes = Math.round(fastest.durationSec / 60)
  } catch {
    // No transit route (rural, or Google has no schedule data there) — leave null.
  }

  return { airport: nearest.airport, driveMinutes: Math.round(nearest.driveSec / 60), transitMinutes }
}
