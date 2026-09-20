// con event — the hub's event bus: what topics exist, what has happened,
// publish your own. Pair with `con listen` to react.

import { hubFetch } from '../client.js'
import { output, exitWithError, isJsonMode, type GlobalFlags } from '../output.js'
import { parseFlags, unknownFlags } from './util.js'

interface HubEvent {
  id: string
  topic: string
  at: number
  source: string
  key?: string
  hops: number
  data: Record<string, unknown>
  ref?: string
}

interface TopicDoc {
  topic: string
  description: string
  fields: Record<string, string>
  logged?: boolean
  lastSeen: HubEvent | null
  count: number
}

export async function event(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'topics': return topicsCmd(args, flags)
    case 'log':
    case 'list': return logCmd(args, flags)
    case 'tail': return tailCmd(args, flags)
    case 'show': return showCmd(args, flags)
    case 'emit': return emitCmd(args, flags)
    case 'redeliver': return redeliverCmd(args, flags)
    case 'status': return output(await hubFetch('/events/status'), flags)
    default:
      exitWithError('USAGE', `Unknown event command: ${verb ?? ''}. Try: topics, log, tail, show, emit, redeliver, status.`, flags)
  }
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/London', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', '')
}

function oneLine(ev: HubEvent): string {
  const d = ev.data
  const summary = Object.entries(d).slice(0, 5).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}…` : v) : JSON.stringify(v)}`).join(' ')
  return `${fmtWhen(ev.at)}  ${ev.topic.padEnd(22)} ${ev.id}  ${summary}`
}

async function topicsCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const bad = unknownFlags(parseFlags(args), [])
  if (bad.length) { exitWithError('USAGE', `Unknown flag(s): ${bad.join(', ')}`, flags); return }
  const topics = await hubFetch<TopicDoc[]>('/events/topics')
  if (isJsonMode(flags)) { output(topics, flags); return }
  const lines: string[] = []
  for (const t of topics) {
    lines.push(`${t.topic}  (${t.count} seen${t.lastSeen ? `, last ${fmtWhen(t.lastSeen.at)}` : ''}${t.logged === false ? ', ring only' : ''})`)
    lines.push(`  ${t.description}`)
    const fields = Object.entries(t.fields)
    if (fields.length) lines.push(`  fields: ${fields.map(([k, v]) => (v ? `${k} (${v})` : k)).join(', ')}`)
    if (t.lastSeen) lines.push(`  example: ${JSON.stringify(t.lastSeen.data).slice(0, 200)}`)
    lines.push('')
  }
  process.stdout.write(lines.join('\n'))
}

async function logCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const bad = unknownFlags(opts, ['topic', 'since', 'until', 'source', 'limit'])
  if (bad.length) { exitWithError('USAGE', `Unknown flag(s): ${bad.join(', ')}`, flags); return }
  const positional = args.find((a) => !a.startsWith('--') && !Object.values(opts).includes(a))
  const events = await hubFetch<HubEvent[]>('/events', { params: { topic: opts.topic ?? positional, since: opts.since, until: opts.until, source: opts.source, limit: opts.limit } })
  if (isJsonMode(flags)) { output(events, flags); return }
  if (!events.length) { process.stdout.write('(no events)\n'); return }
  process.stdout.write(events.map(oneLine).join('\n') + '\n')
}

/** Poll-based live stream — the CLI has no ws dependency, and 1.5 s is plenty for watching a filter take shape. */
async function tailCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const bad = unknownFlags(opts, ['topic', 'source'])
  if (bad.length) { exitWithError('USAGE', `Unknown flag(s): ${bad.join(', ')}`, flags); return }
  const topic = opts.topic ?? args.find((a) => !a.startsWith('--') && !Object.values(opts).includes(a))
  let since = Date.now()
  const seen = new Set<string>()
  process.stderr.write(`tailing ${topic ?? '*'} — Ctrl-C to stop\n`)
  for (;;) {
    const events = await hubFetch<HubEvent[]>('/events', { params: { topic, source: opts.source, since: String(since - 2000), limit: '200' } })
    for (const ev of events.reverse()) {
      if (seen.has(ev.id)) continue
      seen.add(ev.id)
      since = Math.max(since, ev.at)
      process.stdout.write((isJsonMode(flags) ? JSON.stringify(ev) : oneLine(ev)) + '\n')
    }
    if (seen.size > 5000) seen.clear()
    await new Promise((r) => setTimeout(r, 1500))
  }
}

async function showCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args.find((a) => !a.startsWith('--'))
  if (!id) { exitWithError('USAGE', 'Usage: con event show <event-id>', flags); return }
  output(await hubFetch<HubEvent>(`/events/${encodeURIComponent(id)}`), flags)
}

async function emitCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const bad = unknownFlags(opts, ['data', 'key', 'ref'])
  if (bad.length) { exitWithError('USAGE', `Unknown flag(s): ${bad.join(', ')}`, flags); return }
  const topic = args.find((a) => !a.startsWith('--') && !Object.values(opts).includes(a))
  if (!topic) { exitWithError('USAGE', "Usage: con event emit <topic> [--data '{...}'] [--key <idempotency-key>] [--ref '<command to fetch the full thing>']", flags); return }
  let data: unknown = {}
  if (opts.data) {
    try { data = JSON.parse(opts.data) } catch { exitWithError('USAGE', '--data must be a JSON object', flags); return }
  }
  const r = await hubFetch<{ ok: boolean; event: HubEvent | null; dropped?: string }>('/events', { method: 'POST', body: { topic, data, key: opts.key, ref: opts.ref } })
  if (!isJsonMode(flags) && !r.event) { process.stdout.write(`dropped: ${r.dropped}\n`); return }
  output(r.event ?? r, flags)
}

async function redeliverCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const id = args.find((a) => !a.startsWith('--') && !Object.values(opts).includes(a))
  if (!id || !opts.listener) { exitWithError('USAGE', 'Usage: con event redeliver <event-id> --listener <listener-id>', flags); return }
  output(await hubFetch(`/events/${encodeURIComponent(id)}/redeliver`, { method: 'POST', body: { listener: opts.listener } }), flags)
}
