import { geocaching } from './geocaching.js'
import { basemap } from './basemap.js'
import { exitWithError, type GlobalFlags } from '../output.js'

// `con map <subfeature> <verb>` — the Map tab groups location + geocaching +
// offline basemap. Mirrors `con cal flights <verb>` (second word = the tab).
export async function map(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'geocaching': return geocaching(args[0], args.slice(1), flags)
    case 'basemap': return basemap(args[0], args.slice(1), flags)
    default:
      exitWithError('USAGE', `Unknown map command: ${verb}. Try 'con map geocaching status' or 'con map basemap update'.`, flags)
  }
}
