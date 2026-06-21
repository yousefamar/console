import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function geocaching(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'status': return gcStatus(flags)
    case 'config': return gcConfig(args, flags)
    case 'fetch': return gcFetch(args, flags)
    case 'caches': return gcCaches(flags)
    case 'cache': return gcCache(args, flags)
    default:
      exitWithError('USAGE', `Unknown 'con map geocaching' verb: ${verb}. Try status | config | fetch | caches | cache.`, flags)
  }
}

async function gcStatus(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/geocaching/status'), flags)
}

async function gcConfig(args: string[], flags: GlobalFlags): Promise<void> {
  const o = parseFlags(args)
  const body: { username?: string; password?: string; cookie?: string } = {}
  if (o.username) body.username = String(o.username)
  if (o.password) body.password = String(o.password)
  if (o.cookie) body.cookie = String(o.cookie)
  if (Object.keys(body).length === 0) {
    return exitWithError('USAGE', 'Provide --username and --password, or --cookie <gspkauth>', flags)
  }
  output(await hubFetch('/geocaching/credentials', { method: 'POST', body }), flags)
}

async function gcFetch(args: string[], flags: GlobalFlags): Promise<void> {
  const o = parseFlags(args)
  const body: { bbox?: number[]; lat?: number; lon?: number; radiusKm?: number; max?: number } = {}
  if (o.bbox) {
    body.bbox = String(o.bbox).split(',').map(Number)
  } else if (o.lat && o.lon) {
    body.lat = Number(o.lat)
    body.lon = Number(o.lon)
    body.radiusKm = o.radius ? Number(o.radius) : 5
  } else {
    return exitWithError('USAGE', 'Provide --bbox s,w,n,e  or  --lat <n> --lon <n> [--radius <km>]', flags)
  }
  if (o.max) body.max = Number(o.max)
  output(await hubFetch('/geocaching/fetch-area', { method: 'POST', body }), flags)
}

async function gcCaches(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/geocaching/caches'), flags)
}

async function gcCache(args: string[], flags: GlobalFlags): Promise<void> {
  const code = args[0]
  if (!code) return exitWithError('USAGE', 'con map geocaching cache <GC-code>', flags)
  output(await hubFetch(`/geocaching/cache/${encodeURIComponent(code)}`), flags)
}
