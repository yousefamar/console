import { geocaching } from './geocaching.js'
import { mapLayer } from './map-layer.js'
import { mapFlights } from './map-flights.js'
import { exitWithError, type GlobalFlags } from '../output.js'

// `con map <subfeature> <verb>` — the Map tab groups location, geocaching,
// agent-authored layers, and flight arcs. Mirrors `con cal flights <verb>`
// (second word = tab).
export async function map(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'geocaching': return geocaching(args[0], args.slice(1), flags)
    case 'layer': return mapLayer(args[0], args.slice(1), flags)
    case 'flights': return mapFlights(args[0], args.slice(1), flags)
    default:
      exitWithError('USAGE', `Unknown map command: ${verb}. Try 'con map geocaching status', 'con map layer list', or 'con map flights push'.`, flags)
  }
}
