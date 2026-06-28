// `con map flights <verb>` — render flight legs as animated great-circle arcs
// on the Map tab (its own toggle-able layer). Lives under `con map` because
// the Map tab is its home (second word = tab); the calendar-side search /
// watchlist tools stay under `con cal flights`.

import { readFileSync } from 'node:fs'
import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function mapFlights(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case undefined:
    case 'push':
    case 'add':
      return push(args, flags)
    case 'clear':
      return clear(flags)
    default:
      exitWithError('USAGE', "Usage: con map flights {push|clear}. Legs JSON via --legs/--file/--stdin.", flags)
  }
}

async function push(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  let raw = opts.legs
  if (!raw && opts.file) raw = readFileSync(opts.file, 'utf8')
  if (!raw && opts.stdin) raw = await readStdin()
  if (!raw) {
    exitWithError('USAGE', "Provide legs as --legs '<json>', --file <path>, or --stdin. JSON = array of {from,to,price?,date?,...}", flags)
  }
  let legs: unknown
  try { legs = JSON.parse(raw!) } catch { exitWithError('USAGE', 'legs must be valid JSON array', flags); return }
  const body: Record<string, unknown> = { legs }
  if (opts.name) body.name = opts.name
  if (opts.color) body.color = opts.color
  if (opts.fit === 'false') body.fit = false
  const result = await hubFetch('/flights/map', { method: 'POST', body })
  output(result, flags)
}

async function clear(flags: GlobalFlags): Promise<void> {
  const r = await hubFetch('/flights/map', { method: 'DELETE' })
  output(r, flags)
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) { resolve(''); return }
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { data += c })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}
