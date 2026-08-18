import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

// `con map gmaps <verb>` — Google Maps Platform search + directions, proxied by
// the hub (the Cloud key never leaves the server). Second word = tab.
export async function gmaps(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'status': return gmStatus(flags)
    case 'credentials': return gmCredentials(args, flags)
    case 'search': return gmSearch(args, flags)
    case 'directions': return gmDirections(args, flags)
    default:
      exitWithError('USAGE', `Unknown 'con map gmaps' verb: ${verb}. Try status | credentials | search | directions.`, flags)
  }
}

async function gmStatus(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/gmaps/status'), flags)
}

async function gmCredentials(args: string[], flags: GlobalFlags): Promise<void> {
  const o = parseFlags(args)
  if (o.clear) {
    output(await hubFetch('/gmaps/credentials', { method: 'DELETE' }), flags)
    return
  }
  const apiKey = o.key ? String(o.key) : undefined
  if (!apiKey) return exitWithError('USAGE', 'con map gmaps credentials --key <google-maps-platform-key> | --clear', flags)
  output(await hubFetch('/gmaps/credentials', { method: 'POST', body: { apiKey } }), flags)
}

async function gmSearch(args: string[], flags: GlobalFlags): Promise<void> {
  const o = parseFlags(args)
  // query = positional words joined, or --query
  const positional = args.filter((a) => !a.startsWith('--'))
  const q = o.query ? String(o.query) : positional.join(' ').trim()
  if (!q) return exitWithError('USAGE', 'con map gmaps search "<query>" [--lat <n> --lon <n> --radius <m>]', flags)
  const params = new URLSearchParams({ q })
  if (o.lat && o.lon) {
    params.set('lat', String(Number(o.lat)))
    params.set('lon', String(Number(o.lon)))
    if (o.radius) params.set('radius', String(Number(o.radius)))
  }
  output(await hubFetch(`/gmaps/search?${params.toString()}`), flags)
}

async function gmDirections(args: string[], flags: GlobalFlags): Promise<void> {
  const o = parseFlags(args)
  const from = o.from ? String(o.from).split(',').map(Number) : null
  const to = o.to ? String(o.to).split(',').map(Number) : null
  if (!from || from.length !== 2 || !to || to.length !== 2) {
    return exitWithError(
      'USAGE',
      'con map gmaps directions --from <lat,lon> --to <lat,lon> [--mode DRIVE|WALK|BICYCLE|TRANSIT] [--departure <RFC3339>]',
      flags,
    )
  }
  const mode = o.mode ? String(o.mode).toUpperCase() : undefined
  output(
    await hubFetch('/gmaps/directions', {
      method: 'POST',
      body: {
        origin: { lat: from[0], lon: from[1] },
        destination: { lat: to[0], lon: to[1] },
        mode,
        alternatives: true,
        departureTime: o.departure ? String(o.departure) : undefined,
      },
    }),
    flags,
  )
}
