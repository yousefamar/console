import { readFileSync } from 'node:fs'
import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

// `con map layer <verb>` — agent-authored GeoJSON overlays for the Map tab.
export async function mapLayer(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'upsert': return layerUpsert(args, flags)
    case 'list': return layerList(flags)
    case 'get': return layerGet(args, flags)
    case 'remove': return layerRemove(args, flags)
    case 'clear': return layerClear(args, flags)
    default:
      exitWithError('USAGE', `Unknown 'con map layer' verb: ${verb}. Try upsert | list | get | remove | clear.`, flags)
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function layerUpsert(args: string[], flags: GlobalFlags): Promise<void> {
  const slug = args[0]
  if (!slug || slug.startsWith('--')) {
    return exitWithError('USAGE', 'con map layer upsert <group/name> --file <geojson> [--style <json>|--style-json <inline>] [--fit] [--by <name>]', flags)
  }
  const o = parseFlags(args.slice(1))
  if (!o.file) return exitWithError('USAGE', 'upsert requires --file <path-to-geojson>', flags)

  let geojson: unknown
  try {
    geojson = readJson(String(o.file))
  } catch (err) {
    return exitWithError('BAD_INPUT', `could not read/parse --file: ${(err as Error).message}`, flags)
  }

  let style: unknown
  if (o.style) {
    try { style = readJson(String(o.style)) } catch (err) { return exitWithError('BAD_INPUT', `bad --style file: ${(err as Error).message}`, flags) }
  } else if (o['style-json']) {
    try { style = JSON.parse(String(o['style-json'])) } catch (err) { return exitWithError('BAD_INPUT', `bad --style-json: ${(err as Error).message}`, flags) }
  }

  const body = { slug, geojson, style, fit: 'fit' in o ? true : undefined, by: o.by ? String(o.by) : undefined }
  output(await hubFetch('/map/layers', { method: 'POST', body }), flags)
}

async function layerList(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/map/layers'), flags)
}

async function layerGet(args: string[], flags: GlobalFlags): Promise<void> {
  const slug = args[0]
  if (!slug) return exitWithError('USAGE', 'con map layer get <group/name>', flags)
  output(await hubFetch(`/map/layers/${slug}`), flags)
}

async function layerRemove(args: string[], flags: GlobalFlags): Promise<void> {
  const slug = args[0]
  if (!slug) return exitWithError('USAGE', 'con map layer remove <group/name>', flags)
  output(await hubFetch(`/map/layers/${slug}`, { method: 'DELETE' }), flags)
}

async function layerClear(args: string[], flags: GlobalFlags): Promise<void> {
  const group = args[0] && !args[0].startsWith('--') ? args[0] : undefined
  output(await hubFetch('/map/layers', { method: 'DELETE', params: group ? { group } : undefined }), flags)
}
