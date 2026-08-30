// `con map property <verb>` — saved house-hunt searches. One portal per country
// (UK→Rightmove, DE→ImmoScout24, IT→immobiliare); the search polygon is a
// map-layer slug, so the same isochrone the Map tab renders is what gets queried.

import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function mapProperty(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case undefined:
    case 'list': return list(flags)
    case 'add': return add(args, flags)
    case 'get': return get(args, flags)
    case 'set': return set(args, flags)
    case 'remove': return remove(args, flags)
    case 'run': return run(args, flags)
    case 'backfill': return backfill(args, flags)
    case 'dismiss': return dismiss(args, flags)
    case 'reseed': return reseed(args, flags)
    case 'count': return count(args, flags)
    case 'listings': return listings(args, flags)
    default:
      exitWithError(
        'USAGE',
        `Unknown 'con map property' verb: ${verb}. Try list | add | get | set | remove | run | backfill | dismiss | reseed | count | listings.`,
        flags,
      )
  }
}

async function list(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/property/searches'), flags)
}

async function get(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args[0]
  if (!id) return exitWithError('USAGE', 'con map property get <id>', flags)
  output(await hubFetch(`/property/searches/${encodeURIComponent(id)}`), flags)
}

async function add(args: string[], flags: GlobalFlags): Promise<void> {
  const o = parseFlags(args)
  if (!o.country) return exitWithError('USAGE', 'con map property add --country UK|DE|IT --layer <group/name> [criteria flags]', flags)
  if (!o.layer) return exitWithError('USAGE', '--layer <map-layer-slug> required (supplies the search polygon)', flags)
  const body: Record<string, unknown> = {
    country: String(o.country).toUpperCase(),
    layer: String(o.layer),
    criteria: criteriaFrom(o),
  }
  if (o.label) body.label = String(o.label)
  if (o['max-rings']) body.maxRings = Number(o['max-rings'])
  if (o['notify-layer']) body.notifyLayer = String(o['notify-layer'])
  output(await hubFetch('/property/searches', { method: 'POST', body }), flags)
}

async function set(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args[0]
  if (!id) return exitWithError('USAGE', 'con map property set <id> [--label X] [--enabled true|false] [criteria flags]', flags)
  const o = parseFlags(args.slice(1))
  const body: Record<string, unknown> = {}
  if (o.label) body.label = String(o.label)
  if (o.layer) body.layer = String(o.layer)
  if (o.country) body.country = String(o.country).toUpperCase()
  if (o['max-rings']) body.maxRings = Number(o['max-rings'])
  if (o.enabled) body.enabled = o.enabled !== 'false'
  // --notify-layer none clears the filter (push on everything again).
  if (o['notify-layer']) body.notifyLayer = String(o['notify-layer']) === 'none' ? null : String(o['notify-layer'])
  const criteria = criteriaFrom(o)
  // Only send criteria when a criteria flag was actually passed — an empty
  // object would wipe the search's filters and force a re-seed.
  if (Object.keys(criteria).length) body.criteria = criteria
  output(await hubFetch(`/property/searches/${encodeURIComponent(id)}`, { method: 'PATCH', body }), flags)
}

async function remove(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args[0]
  if (!id) return exitWithError('USAGE', 'con map property remove <id>', flags)
  output(await hubFetch(`/property/searches/${encodeURIComponent(id)}`, { method: 'DELETE' }), flags)
}

async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args[0]
  if (!id) return exitWithError('USAGE', 'con map property run <id>', flags)
  output(await hubFetch(`/property/searches/${encodeURIComponent(id)}/run`, { method: 'POST' }), flags)
}

async function backfill(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args[0]
  if (!id) return exitWithError('USAGE', 'con map property backfill <id>', flags)
  output(await hubFetch(`/property/searches/${encodeURIComponent(id)}/backfill`, { method: 'POST' }), flags)
}

async function dismiss(args: string[], flags: GlobalFlags): Promise<void> {
  const [id, listingId] = args
  if (!id || !listingId) return exitWithError('USAGE', 'con map property dismiss <id> <listingId> [--undo]', flags)
  const o = parseFlags(args.slice(2))
  const body = { listingId, dismissed: !o.undo }
  output(await hubFetch(`/property/searches/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body }), flags)
}

async function reseed(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args[0]
  if (!id) return exitWithError('USAGE', 'con map property reseed <id>', flags)
  output(await hubFetch(`/property/searches/${encodeURIComponent(id)}/reseed`, { method: 'POST' }), flags)
}

async function count(args: string[], flags: GlobalFlags): Promise<void> {
  const o = parseFlags(args)
  if (!o.country || !o.layer) return exitWithError('USAGE', 'con map property count --country UK|DE|IT --layer <group/name> [criteria flags]', flags)
  const body: Record<string, unknown> = {
    country: String(o.country).toUpperCase(),
    layer: String(o.layer),
    criteria: criteriaFrom(o),
  }
  if (o['max-rings']) body.maxRings = Number(o['max-rings'])
  output(await hubFetch('/property/count', { method: 'POST', body }), flags)
}

async function listings(args: string[], flags: GlobalFlags): Promise<void> {
  const o = parseFlags(args)
  const q = new URLSearchParams()
  if (o.limit) q.set('limit', String(o.limit))
  if (o.country) q.set('country', String(o.country).toUpperCase())
  output(await hubFetch(`/property/listings${q.size ? `?${q}` : ''}`), flags)
}

/** Criteria flags → the portable Criteria object the hub compiles per portal. */
function criteriaFrom(o: Record<string, string>): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  if (o.channel) c.channel = o.channel
  if (o.type) c.propertyType = o.type
  if (o['house-subtypes']) c.houseSubtypes = String(o['house-subtypes']).split(',').map((s) => s.trim()).filter(Boolean)
  if (o['min-price']) c.minPrice = Number(o['min-price'])
  if (o['max-price']) c.maxPrice = Number(o['max-price'])
  if (o['min-beds']) c.minBedrooms = Number(o['min-beds'])
  if (o['max-beds']) c.maxBedrooms = Number(o['max-beds'])
  if (o['min-baths']) c.minBathrooms = Number(o['min-baths'])
  if (o['min-area']) c.minFloorArea = Number(o['min-area'])
  if (o['max-area']) c.maxFloorArea = Number(o['max-area'])
  if (o['min-plot']) c.minPlotArea = Number(o['min-plot'])
  if (o['max-plot']) c.maxPlotArea = Number(o['max-plot'])
  if (o['min-year']) c.minYearBuilt = Number(o['min-year'])
  if (o['max-year']) c.maxYearBuilt = Number(o['max-year'])
  if (o['min-mbit']) c.minInternetMbit = Number(o['min-mbit'])
  if (o['max-age-days']) c.maxDaysSinceAdded = Number(o['max-age-days'])
  if (o.keywords) c.keywords = String(o.keywords).split(',').map((s) => s.trim()).filter(Boolean)
  if (o.freehold) c.freeholdOnly = o.freehold !== 'false'
  if (o['exclude-commonhold']) c.excludeCommonhold = o['exclude-commonhold'] !== 'false'
  if (o.garden) c.mustHaveGarden = o.garden !== 'false'
  if (o.parking) c.mustHaveParking = o.parking !== 'false'
  if (o['exclude-schemes']) c.excludeSchemes = o['exclude-schemes'] !== 'false'
  if (o['exclude-auctions']) c.excludeAuctions = o['exclude-auctions'] !== 'false'
  if (o['exclude-new-build']) c.excludeNewBuild = o['exclude-new-build'] !== 'false'
  if (o['no-buyer-fee']) c.noBuyerFee = o['no-buyer-fee'] !== 'false'
  if (o['exclude-price-on-request']) c.excludePriceOnRequest = o['exclude-price-on-request'] !== 'false'
  return c
}
