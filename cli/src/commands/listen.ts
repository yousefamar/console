// con listen — event-driven rules that survive hub restarts. The event-side
// twin of `con cron`: cron = time, listen = something happened.

import { hubFetch } from '../client.js'
import { output, exitWithError, isJsonMode, type GlobalFlags } from '../output.js'
import { parseFlags, unknownFlags } from './util.js'

interface Listener {
  id: string
  name?: string
  owner: { claudeSessionId: string; agentKey?: string; cwd?: string }
  ownerName?: string
  createdAt: number
  on: string
  where: Array<{ path: string; op: string; value: string }>
  guard?: string
  coalesceMs: number
  cooldownMs: number
  hours?: string
  days?: string
  dropOutside?: boolean
  maxPerHour: number
  action: { type: string } & Record<string, unknown>
  times?: number
  timesTotal?: number
  expiresAt?: number
  pausedAt?: number
  pauseReason?: string
  disabledAt?: number
  consecutiveSkips: number
  stats: { matched: number; fired: number; guardSkipped: number; lastEventAt?: number; lastFiredAt?: number; lastOutcome?: string }
  pending?: { events: string[]; startedAt: number; dueAt: number }
  outcomes: Array<{ at: number; stage: string; events: string[]; detail?: string }>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTION_FLAGS = ['wake', 'run', 'post', 'notify', 'emit', 'card'] as const
const ADD_FLAGS = ['session', 'on', 'where', 'guard', 'guard-file', 'coalesce', 'cooldown', 'hours', 'days', 'drop-outside', 'max-per-hour', 'name',
  'once', 'times', 'expires', ...ACTION_FLAGS, 'as', 'method', 'header', 'body', 'data', 'to', 'assign', 'project']

export async function listen(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'list': case 'ls': return listCmd(args, flags)
    case 'add': return addCmd(args, flags)
    case 'show': return showCmd(args, flags)
    case 'log': return logCmd(args, flags)
    case 'test': return testCmd(args, flags)
    case 'pause': return verbCmd('pause', args, flags)
    case 'resume': return verbCmd('resume', args, flags)
    case 'flush': return verbCmd('flush', args, flags)
    case 'remove': case 'rm': case 'delete': return removeCmd(args, flags)
    default:
      exitWithError('USAGE', `Unknown listen command: ${verb ?? ''}. Try: list, add, show, log, test, pause, resume, flush, remove.`, flags)
  }
}

/** parseFlags keeps the last value of a repeated flag; --where and --header repeat. */
function collectRepeated(args: string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === `--${name}` && i + 1 < args.length) { out.push(args[++i]!); continue }
    if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3))
  }
  return out
}

function parseDuration(raw: string | undefined, flag: string, flags: GlobalFlags): number | undefined {
  if (raw === undefined) return undefined
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(raw.trim())
  if (!m) { exitWithError('USAGE', `--${flag} wants a duration like 30s, 10m, 2h (got "${raw}")`, flags); return undefined }
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h' | 'd']
  return Number(m[1]) * unit
}

function fmtAgo(ms: number | undefined): string {
  if (!ms) return '-'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172_800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86_400)}d ago`
}

function fmtDur(ms: number): string {
  if (!ms) return '0'
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

function describeAction(a: Listener['action']): string {
  switch (a.type) {
    case 'wake': { const p = String(a.prompt ?? ''); return `wake${a.as ? ` @${a.as}` : ''}: ${p.length > 50 ? `${p.slice(0, 47)}…` : p}` }
    case 'run': return `run: ${a.cmd}`
    case 'post': return `post ${a.url}`
    case 'notify': return `notify: ${a.title}`
    case 'emit': return `emit ${a.topic}`
    case 'card': return `card ${a.project}: ${String(a.text).slice(0, 40)}`
    default: return a.type
  }
}

function whereText(l: Listener): string {
  return l.where.map((c) => (c.op === 'in' ? `${c.path} in ${c.value}` : `${c.path}${c.op}${c.value}`)).join(' && ')
}

function state(l: Listener): string {
  if (l.disabledAt) return 'DISABLED'
  if (l.pausedAt) return 'paused'
  if (l.pending) return `pending ${l.pending.events.length}`
  return 'active'
}

function lifetime(l: Listener): string {
  const parts: string[] = []
  if (l.times !== undefined) parts.push(l.timesTotal === 1 ? 'once' : `${l.times} of ${l.timesTotal ?? l.times} left`)
  if (l.expiresAt) { const ms = l.expiresAt - Date.now(); parts.push(ms > 0 ? `expires in ${fmtDur(Math.round(ms / 1000) * 1000)}` : 'expired') }
  return parts.join(', ')
}

/** `2h`, `30m`, `1d` or an ISO datetime → epoch ms. */
function parseExpires(raw: string, flags: GlobalFlags): number | undefined {
  const rel = /^\+?(\d+)\s*(s|m|h|d)$/.exec(raw.trim())
  if (rel) return Date.now() + Number(rel[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 's' | 'm' | 'h' | 'd']
  const t = Date.parse(raw)
  if (Number.isNaN(t)) { exitWithError('USAGE', `--expires wants a duration (2h, 30m, 1d) or an ISO datetime (got "${raw}")`, flags); return undefined }
  return t
}

async function listCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const bad = unknownFlags(opts, ['mine', 'session', 'topic'])
  if (bad.length) { exitWithError('USAGE', `Unknown flag(s): ${bad.join(', ')}`, flags); return }
  const session = opts.mine === 'true' ? process.env.CONSOLE_CLAUDE_SESSION_ID : opts.session
  const listeners = await hubFetch<Listener[]>('/listeners', { params: { session, topic: opts.topic } })
  if (isJsonMode(flags)) { output(listeners, flags); return }
  if (!listeners.length) { process.stdout.write('(no listeners)\n'); return }
  const lines = listeners.map((l) => {
    const rule = `${l.on}${l.where.length ? ` where ${whereText(l)}` : ''}${l.guard ? ' [guard]' : ''}`
    const gates = [l.coalesceMs ? `coalesce ${fmtDur(l.coalesceMs)}` : '', l.cooldownMs ? `cooldown ${fmtDur(l.cooldownMs)}` : '', l.hours ?? '', l.days ?? ''].filter(Boolean).join(', ')
    const life = lifetime(l)
    return `${l.id}  ${state(l).padEnd(11)} @${(l.owner.agentKey ?? l.ownerName ?? l.owner.claudeSessionId.slice(0, 8)).padEnd(28)} ${rule}${life ? `  [${life}]` : ''}\n      → ${describeAction(l.action)}${gates ? `  (${gates})` : ''}\n      matched ${l.stats.matched}, fired ${l.stats.fired}, guard-skipped ${l.stats.guardSkipped}; last fired ${fmtAgo(l.stats.lastFiredAt)}${l.stats.lastOutcome ? `; ${l.stats.lastOutcome}` : ''}${l.name ? `  "${l.name}"` : ''}`
  })
  process.stdout.write(lines.join('\n') + '\n')
}

async function addCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const bad = unknownFlags(opts, ADD_FLAGS)
  if (bad.length) { exitWithError('USAGE', `Unknown flag(s): ${bad.join(', ')}. See con help listen.`, flags); return }
  const usage = 'Usage: con listen add --session <claudeSessionId> --on <topic|glob> [--where <path><op><value>]… [--guard "<cmd>"] [--coalesce 30s] [--cooldown 10m] [--hours 07:00-23:00] [--days Mon-Fri] [--drop-outside] [--max-per-hour N] [--once | --times N] [--expires 2h|<iso>] [--name "…"] ACTION\n  ACTION = --wake "<prompt>" [--as <agentKey>] | --run "<cmd>" | --post <url> [--method M] [--header k:v]… | --notify "<title>" [--body "…"] | --emit <topic> [--data \'{…}\'] | --card <project> --body "<text>" [--to Backlog] [--assign key]'
  const claudeSessionId = opts.session ?? process.env.CONSOLE_CLAUDE_SESSION_ID ?? ''
  if (!claudeSessionId) { exitWithError('USAGE', `--session is required (your claudeSessionId; \`ps -o args= -p $PPID\` shows --session-id).\n${usage}`, flags); return }
  if (claudeSessionId !== 'al' && !UUID_RE.test(claudeSessionId)) { exitWithError('USAGE', `--session must be a claudeSessionId (UUID) or "al". Got: ${claudeSessionId}`, flags); return }
  if (!opts.on) { exitWithError('USAGE', `--on <topic> is required. \`con event topics\` lists them.\n${usage}`, flags); return }

  const chosen = ACTION_FLAGS.filter((f) => opts[f] !== undefined)
  if (chosen.length !== 1) { exitWithError('USAGE', `Exactly one action flag is required (got ${chosen.length ? chosen.join(', ') : 'none'}).\n${usage}`, flags); return }
  let action: Record<string, unknown>
  switch (chosen[0]) {
    case 'wake': action = { type: 'wake', prompt: opts.wake, ...(opts.as ? { as: opts.as } : {}) }; break
    case 'run': action = { type: 'run', cmd: opts.run }; break
    case 'post': {
      const headers: Record<string, string> = {}
      for (const h of collectRepeated(args, 'header')) { const i = h.indexOf(':'); if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim() }
      action = { type: 'post', url: opts.post, ...(opts.method ? { method: opts.method } : {}), headers }
      break
    }
    case 'notify': action = { type: 'notify', title: opts.notify, ...(opts.body ? { body: opts.body } : {}) }; break
    case 'emit': {
      let data: unknown
      if (opts.data) { try { data = JSON.parse(opts.data) } catch { exitWithError('USAGE', '--data must be a JSON object', flags); return } }
      action = { type: 'emit', topic: opts.emit, ...(data ? { data } : {}) }
      break
    }
    case 'card': action = { type: 'card', project: opts.card, text: opts.body, ...(opts.to ? { column: opts.to } : {}), ...(opts.assign ? { assign: opts.assign } : {}) }; break
    default: exitWithError('USAGE', usage, flags); return
  }

  let guard = opts.guard
  if (!guard && opts['guard-file']) {
    const { readFileSync } = await import('node:fs')
    guard = readFileSync(opts['guard-file'], 'utf8')
  }
  const coalesce = parseDuration(opts.coalesce, 'coalesce', flags)
  const cooldown = parseDuration(opts.cooldown, 'cooldown', flags)
  if ((opts.coalesce && coalesce === undefined) || (opts.cooldown && cooldown === undefined)) return
  if (opts.once !== undefined && opts.times !== undefined) { exitWithError('USAGE', '--once and --times are the same knob; pass one', flags); return }
  const times = opts.once === 'true' ? 1 : opts.times !== undefined ? Number(opts.times) : undefined
  if (times !== undefined && (!Number.isInteger(times) || times < 1)) { exitWithError('USAGE', '--times wants a whole number ≥ 1', flags); return }
  const expiresAt = opts.expires ? parseExpires(opts.expires, flags) : undefined
  if (opts.expires && expiresAt === undefined) return

  const body = {
    owner: { claudeSessionId, ...(process.env.CONSOLE_AGENT_KEY ? { agentKey: process.env.CONSOLE_AGENT_KEY } : {}), cwd: process.cwd() },
    on: opts.on,
    where: collectRepeated(args, 'where'),
    ...(guard ? { guard } : {}),
    ...(coalesce !== undefined ? { coalesce } : {}),
    ...(cooldown !== undefined ? { cooldown } : {}),
    ...(opts.hours ? { hours: opts.hours } : {}),
    ...(opts.days ? { days: opts.days } : {}),
    ...(opts['drop-outside'] === 'true' ? { dropOutside: true } : {}),
    ...(opts['max-per-hour'] ? { maxPerHour: Number(opts['max-per-hour']) } : {}),
    ...(opts.name ? { name: opts.name } : {}),
    ...(times !== undefined ? { times } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    action,
  }
  const l = await hubFetch<Listener>('/listeners', { method: 'POST', body })
  if (isJsonMode(flags)) { output(l, flags); return }
  const life = lifetime(l)
  process.stdout.write(`${l.id}  on ${l.on}${l.where.length ? ` where ${whereText(l)}` : ''} → ${describeAction(l.action)}${life ? `  [${life}]` : ''}\n`)
  process.stdout.write(`coalesce ${fmtDur(l.coalesceMs)}, cooldown ${fmtDur(l.cooldownMs)}, max ${l.maxPerHour}/h${l.hours ? `, ${l.hours}` : ''}${l.days ? ` ${l.days}` : ''}. Try it: con listen test ${l.id}\n`)
}

async function showCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args.find((a) => !a.startsWith('--'))
  if (!id) { exitWithError('USAGE', 'Usage: con listen show <id>', flags); return }
  output(await hubFetch<Listener>(`/listeners/${encodeURIComponent(id)}`), flags)
}

async function logCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const id = args.find((a) => !a.startsWith('--') && !Object.values(opts).includes(a))
  if (!id) { exitWithError('USAGE', 'Usage: con listen log <id> [--limit N]', flags); return }
  const l = await hubFetch<Listener>(`/listeners/${encodeURIComponent(id)}`)
  const limit = Number(opts.limit ?? 20) || 20
  const rows = l.outcomes.slice(-limit).reverse()
  if (isJsonMode(flags)) { output(rows, flags); return }
  if (!rows.length) { process.stdout.write('(no outcomes yet)\n'); return }
  for (const o of rows) process.stdout.write(`${new Date(o.at).toISOString()}  ${o.stage.padEnd(14)} ${o.events.length} event(s)${o.detail ? `  ${o.detail}` : ''}  [${o.events.slice(0, 3).join(', ')}${o.events.length > 3 ? ', …' : ''}]\n`)
}

async function testCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const bad = unknownFlags(opts, ['event', 'topic', 'data'])
  if (bad.length) { exitWithError('USAGE', `Unknown flag(s): ${bad.join(', ')}`, flags); return }
  const id = args.find((a) => !a.startsWith('--') && !Object.values(opts).includes(a))
  if (!id) { exitWithError('USAGE', "Usage: con listen test <id> [--event <event-id> | --topic <t> --data '{…}']  (default: the newest event on the listener's topic)", flags); return }
  let data: unknown
  if (opts.data) { try { data = JSON.parse(opts.data) } catch { exitWithError('USAGE', '--data must be a JSON object', flags); return } }
  const r = await hubFetch<{ event: string; stage: string; detail: string; envelope?: string }>(`/listeners/${encodeURIComponent(id)}/test`, { method: 'POST', body: { event: opts.event, topic: opts.topic, data } })
  if (isJsonMode(flags)) { output(r, flags); return }
  process.stdout.write(`event ${r.event}: ${r.stage} — ${r.detail}\n`)
  if (r.envelope) process.stdout.write(`\n${r.envelope}\n`)
}

async function verbCmd(verb: 'pause' | 'resume' | 'flush', args: string[], flags: GlobalFlags): Promise<void> {
  const id = args.find((a) => !a.startsWith('--'))
  if (!id) { exitWithError('USAGE', `Usage: con listen ${verb} <id>`, flags); return }
  output(await hubFetch(`/listeners/${encodeURIComponent(id)}/${verb}`, { method: 'POST' }), flags)
}

async function removeCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args.find((a) => !a.startsWith('--'))
  if (!id) { exitWithError('USAGE', 'Usage: con listen remove <id> [--force]  (--force = remove a listener owned by ANOTHER session; the owner is told)', flags); return }
  const force = parseFlags(args).force === 'true'
  output(await hubFetch<{ removed: boolean }>(`/listeners/${encodeURIComponent(id)}${force ? '?force=1' : ''}`, { method: 'DELETE' }), flags)
}
