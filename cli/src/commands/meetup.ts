import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function meetup(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'status': return muStatus(flags)
    case 'fetch': return muFetch(args, flags)
    case 'events': return muEvents(flags)
    case 'event': return muEvent(args, flags)
    default:
      exitWithError('USAGE', `Unknown 'con map meetup' verb: ${verb}. Try status | fetch | events | event.`, flags)
  }
}

async function muStatus(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/meetup/status'), flags)
}

async function muFetch(args: string[], flags: GlobalFlags): Promise<void> {
  const o = parseFlags(args)
  const body: {
    bbox?: number[]
    lat?: number
    lon?: number
    radiusMiles?: number
    query?: string
    type?: string
    days?: number
    pages?: number
  } = {}
  if (o.bbox) {
    body.bbox = String(o.bbox).split(',').map(Number)
  } else if (o.lat && o.lon) {
    body.lat = Number(o.lat)
    body.lon = Number(o.lon)
    body.radiusMiles = o.radius ? Number(o.radius) : 10
  } else {
    return exitWithError('USAGE', 'Provide --bbox s,w,n,e  or  --lat <n> --lon <n> [--radius <miles>]', flags)
  }
  if (o.query) body.query = String(o.query)
  if (o.type) body.type = String(o.type)
  if (o.days) body.days = Number(o.days)
  if (o.pages) body.pages = Number(o.pages)
  output(await hubFetch('/meetup/fetch-area', { method: 'POST', body }), flags)
}

async function muEvents(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/meetup/events'), flags)
}

async function muEvent(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args[0]
  if (!id) return exitWithError('USAGE', 'con map meetup event <id>', flags)
  output(await hubFetch(`/meetup/event/${encodeURIComponent(id)}`), flags)
}
