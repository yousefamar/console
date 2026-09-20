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
  expect?: {
    by?: string
    windowMs?: number
    after?: { on: string; where: Array<{ path: string; op: string; value: string }> }
    withinMs?: number
    then?: { type: string } & Record<string, unknown>
    pending: Array<{ armedAt: number; deadlineAt: number; triggerEventId?: string }>
    satisfied: number
    missed: number
    lastSatisfiedAt?: number
    lastMissedAt?: number
  }
  outcomes: Array<{ at: number; stage: string; events: string[]; detail?: string }>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTION_FLAGS = ['wake', 'run', 'post', 'notify', 'emit', 'card'] as const
const ADD_FLAGS = ['session', 'on', 'where', 'guard', 'guard-file', 'coalesce', 'cooldown', 'hours', 'days', 'drop-outside', 'max-per-hour', 'name',
  'once', 'times', 'expires', ...ACTION_FLAGS, 'as', 'fork', 'model', 'method', 'header', 'body', 'data', 'to', 'assign', 'project']

export async function listen(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'list': case 'ls': return listCmd(args, flags)
    case 'add': return addCmd(args, flags)
    case 'expect': return expectCmd(args, flags)
    case 'show': return showCmd(args, flags)
    case 'log': return logCmd(args, flags)
    case 'test': return testCmd(args, flags)
    case 'pause': return verbCmd('pause', args, flags)
    case 'resume': return verbCmd('resume', args, flags)
    case 'flush': return verbCmd('flush', args, flags)
    case 'remove': case 'rm': case 'delete': return removeCmd(args, flags)
    default:
      exitWithError('USAGE', `Unknown listen command: ${verb ?? ''}. Try: list, add, expect, show, log, test, pause, resume, flush, remove.`, flags)
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
    case 'wake': { const p = String(a.prompt ?? ''); return `wake${a.fork ? ` (fork${a.model ? ` ${a.model}` : ''})` : ''}${a.as ? ` @${a.as}` : ''}: ${p.length > 50 ? `${p.slice(0, 47)}…` : p}` }
    case 'run': return `run: ${a.cmd}`
    case 'post': return `post ${a.url}`
    case 'notify': return `notify: ${a.title}`
    case 'emit': return `emit ${a.topic}`
    case 'card': return `card ${a.project}: ${String(a.text).slice(0, 40)}`
    default: return a.type
  }
}

function clauses(where: Array<{ path: string; op: string; value: string }>): string {
  return where.map((c) => (c.op === 'in' ? `${c.path} in ${c.value}` : `${c.path}${c.op}${c.value}`)).join(' && ')
}

function whereText(l: Listener): string {
  return clauses(l.where)
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/London', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '')
}

/** `expect geo.enter where data.fence=office within 90m after geo.leave where data.fence=home` */
function ruleText(l: Listener): string {
  const on = `${l.on}${l.where.length ? ` where ${whereText(l)}` : ''}`
  const x = l.expect
  if (!x) return `${on}${l.guard ? ' [guard]' : ''}`
  let when: string
  if (x.by !== undefined) when = `${/^\d{12,}$/.test(x.by) ? `by ${fmtWhen(Number(x.by))}` : `by "${x.by}"`}${x.windowMs ? ` (window ${fmtDur(x.windowMs)})` : ''}`
  else when = `within ${fmtDur(x.withinMs ?? 0)}${x.after ? ` after ${x.after.on}${x.after.where.length ? ` where ${clauses(x.after.where)}` : ''}` : ''}`
  return `expect ${on} ${when}${l.guard ? ' [guard]' : ''}`
}

function state(l: Listener): string {
  if (l.disabledAt) return 'DISABLED'
  if (l.pausedAt) return 'paused'
  if (l.expect) return l.expect.pending.length ? `armed ${l.expect.pending.length}` : 'waiting'
  if (l.pending) return `pending ${l.pending.events.length}`
  return 'active'
}

function expectStats(l: Listener): string {
  const x = l.expect!
  const next = x.pending.length ? Math.min(...x.pending.map((p) => p.deadlineAt)) : undefined
  return `satisfied ${x.satisfied}, missed ${x.missed}${next !== undefined ? `; next deadline ${fmtWhen(next)}` : ''}${l.stats.lastOutcome ? `; ${l.stats.lastOutcome}` : ''}`
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
    const rule = ruleText(l)
    const gates = [l.coalesceMs ? `coalesce ${fmtDur(l.coalesceMs)}` : '', l.cooldownMs ? `cooldown ${fmtDur(l.cooldownMs)}` : '', l.hours ?? '', l.days ?? ''].filter(Boolean).join(', ')
    const life = lifetime(l)
    const action = l.expect ? `else ${describeAction(l.action)}${l.expect.then ? `; then ${describeAction(l.expect.then)}` : ''}` : describeAction(l.action)
    const stats = l.expect ? expectStats(l) : `matched ${l.stats.matched}, fired ${l.stats.fired}, guard-skipped ${l.stats.guardSkipped}; last fired ${fmtAgo(l.stats.lastFiredAt)}${l.stats.lastOutcome ? `; ${l.stats.lastOutcome}` : ''}`
    return `${l.id}  ${state(l).padEnd(11)} @${(l.owner.agentKey ?? l.ownerName ?? l.owner.claudeSessionId.slice(0, 8)).padEnd(28)} ${rule}${life ? `  [${life}]` : ''}\n      → ${action}${gates ? `  (${gates})` : ''}\n      ${stats}${l.name ? `  "${l.name}"` : ''}`
  })
  process.stdout.write(lines.join('\n') + '\n')
}

async function addCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const bad = unknownFlags(opts, ADD_FLAGS)
  if (bad.length) { exitWithError('USAGE', `Unknown flag(s): ${bad.join(', ')}. See con help listen.`, flags); return }
  const usage = 'Usage: con listen add --session <claudeSessionId> --on <topic|glob> [--where <path><op><value>]… [--guard "<cmd>"] [--coalesce 30s] [--cooldown 10m] [--hours 07:00-23:00] [--days Mon-Fri] [--drop-outside] [--max-per-hour N] [--once | --times N] [--expires 2h|<iso>] [--name "…"] ACTION\n  ACTION = --wake "<prompt>" [--as <agentKey>] [--fork [--model haiku]] | --run "<cmd>" | --post <url> [--method M] [--header k:v]… | --notify "<title>" [--body "…"] | --emit <topic> [--data \'{…}\'] | --card <project> --body "<text>" [--to Backlog] [--assign key]\n  --fork wakes a FRESH single-turn fork of the target (closed when its turn ends) instead of the target itself — its context stays clean; --model pins the fork\'s model.'
  const claudeSessionId = opts.session ?? process.env.CONSOLE_CLAUDE_SESSION_ID ?? ''
  if (!claudeSessionId) { exitWithError('USAGE', `--session is required (your claudeSessionId; \`ps -o args= -p $PPID\` shows --session-id).\n${usage}`, flags); return }
  if (claudeSessionId !== 'al' && !UUID_RE.test(claudeSessionId)) { exitWithError('USAGE', `--session must be a claudeSessionId (UUID) or "al". Got: ${claudeSessionId}`, flags); return }
  if (!opts.on) { exitWithError('USAGE', `--on <topic> is required. \`con event topics\` lists them.\n${usage}`, flags); return }

  const chosen = ACTION_FLAGS.filter((f) => opts[f] !== undefined)
  if (chosen.length !== 1) { exitWithError('USAGE', `Exactly one action flag is required (got ${chosen.length ? chosen.join(', ') : 'none'}).\n${usage}`, flags); return }
  let action: Record<string, unknown>
  switch (chosen[0]) {
    case 'wake': {
      if (opts.model && opts.fork !== 'true') { exitWithError('USAGE', '--model only applies with --fork (the target session keeps its own model)', flags); return }
      action = { type: 'wake', prompt: opts.wake, ...(opts.as ? { as: opts.as } : {}), ...(opts.fork === 'true' ? { fork: true } : {}), ...(opts.model ? { model: opts.model } : {}) }
      break
    }
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

const EXPECT_USAGE = `Usage: con listen expect --on <topic> [--where <path><op><value>]… WHEN --else <ACTION> [--then <ACTION>] [--guard "<cmd>"] [--hours 07:00-23:00] [--days Mon-Fri] [--max-per-hour N] [--once | --times N] [--expires 2h|<iso>] [--name "…"] [--session <csid>]
  WHEN    = --by <cron|iso|+dur> [--window 3h]                absolute: at every tick, satisfied iff a matching --on event arrived in the window before it (default window: since the previous tick)
          | --within 90m [--after <topic> [--where …]…]       relative: each --after event arms a deadline; a matching --on event before it disarms. No --after = armed once, now (a one-shot wait)
  ACTION  = wake "<prompt>" [--as key] | run "<cmd>" | post <url> [--method M] [--header k:v]… | notify "<title>" [--body "…"] | emit <topic> [--data '{…}'] | card <project> "<text>" [--to Col] [--assign key]
  --where binds to the --on or --after before it; action options bind to the --else or --then before them. Cron is Europe/London.`

const EXPECT_ACTION_TYPES = ['wake', 'run', 'post', 'notify', 'emit', 'card'] as const
const ACTION_OPT_FLAGS = new Set(['as', 'method', 'header', 'body', 'data', 'to', 'assign'])
const EXPECT_SIMPLE_FLAGS = new Set(['session', 'on', 'by', 'window', 'after', 'within', 'guard', 'guard-file', 'hours', 'days', 'max-per-hour', 'name', 'times', 'expires'])
const EXPECT_BOOL_FLAGS = new Set(['once'])

interface ParsedAction { type: string; arg: string; arg2?: string; opts: Record<string, string>; headers: string[] }

/** Position-aware parse: `--where` follows its topic, action options follow their `--else`/`--then`. */
function parseExpectArgs(args: string[], flags: GlobalFlags): { opts: Record<string, string>; where: string[]; afterWhere: string[]; els?: ParsedAction; then?: ParsedAction } | undefined {
  const opts: Record<string, string> = {}
  const where: string[] = []
  const afterWhere: string[] = []
  let whereTarget: string[] = where
  let els: ParsedAction | undefined
  let then: ParsedAction | undefined
  let current: ParsedAction | undefined
  const fail = (msg: string) => { exitWithError('USAGE', `${msg}\n${EXPECT_USAGE}`, flags); return undefined }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('--')) return fail(`Unexpected argument "${a}".`)
    let name = a.slice(2)
    let inline: string | undefined
    const eq = name.indexOf('=')
    if (eq !== -1) { inline = name.slice(eq + 1); name = name.slice(0, eq) }
    const next = (): string | undefined => {
      if (inline !== undefined) return inline
      if (i + 1 < args.length) return args[++i]!
      return undefined
    }
    if (name === 'else' || name === 'then') {
      const type = next()
      if (!type || !(EXPECT_ACTION_TYPES as readonly string[]).includes(type)) return fail(`--${name} wants an action type (${EXPECT_ACTION_TYPES.join(' | ')}), got "${type ?? ''}".`)
      const arg = i + 1 < args.length && !args[i + 1]!.startsWith('--') ? args[++i]! : undefined
      if (arg === undefined) return fail(`--${name} ${type} needs its argument (${type === 'card' ? 'project and text' : type === 'post' ? 'a URL' : type === 'emit' ? 'a topic' : 'text'}).`)
      const act: ParsedAction = { type, arg, opts: {}, headers: [] }
      if (type === 'card') {
        const text = i + 1 < args.length && !args[i + 1]!.startsWith('--') ? args[++i]! : undefined
        if (text === undefined) return fail(`--${name} card <project> "<text>" — the text is missing.`)
        act.arg2 = text
      }
      if (name === 'else') { if (els) return fail('--else given twice.'); els = act } else { if (then) return fail('--then given twice.'); then = act }
      current = act
      continue
    }
    if (name === 'where') {
      const v = next(); if (v === undefined) return fail('--where needs a clause.')
      whereTarget.push(v); continue
    }
    if (name === 'on') { const v = next(); if (v === undefined) return fail('--on needs a topic.'); opts.on = v; whereTarget = where; continue }
    if (name === 'after') { const v = next(); if (v === undefined) return fail('--after needs a topic.'); opts.after = v; whereTarget = afterWhere; continue }
    if (ACTION_OPT_FLAGS.has(name)) {
      const v = next(); if (v === undefined) return fail(`--${name} needs a value.`)
      if (!current) return fail(`--${name} must follow the --else or --then action it belongs to.`)
      if (name === 'header') current.headers.push(v); else current.opts[name] = v
      continue
    }
    if (EXPECT_BOOL_FLAGS.has(name)) { opts[name] = inline ?? 'true'; continue }
    if (EXPECT_SIMPLE_FLAGS.has(name)) {
      const v = next(); if (v === undefined) return fail(`--${name} needs a value.`)
      opts[name] = v; continue
    }
    return fail(`Unknown flag --${name}.`)
  }
  return { opts, where, afterWhere, els, then }
}

function buildAction(p: ParsedAction, flags: GlobalFlags): Record<string, unknown> | undefined {
  switch (p.type) {
    case 'wake': return { type: 'wake', prompt: p.arg, ...(p.opts.as ? { as: p.opts.as } : {}) }
    case 'run': return { type: 'run', cmd: p.arg }
    case 'post': {
      const headers: Record<string, string> = {}
      for (const h of p.headers) { const i = h.indexOf(':'); if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim() }
      return { type: 'post', url: p.arg, ...(p.opts.method ? { method: p.opts.method } : {}), headers }
    }
    case 'notify': return { type: 'notify', title: p.arg, ...(p.opts.body ? { body: p.opts.body } : {}) }
    case 'emit': {
      let data: unknown
      if (p.opts.data) { try { data = JSON.parse(p.opts.data) } catch { exitWithError('USAGE', '--data must be a JSON object', flags); return undefined } }
      return { type: 'emit', topic: p.arg, ...(data ? { data } : {}) }
    }
    case 'card': return { type: 'card', project: p.arg, text: p.arg2, ...(p.opts.to ? { column: p.opts.to } : {}), ...(p.opts.assign ? { assign: p.opts.assign } : {}) }
    default: return undefined
  }
}

async function expectCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const parsed = parseExpectArgs(args, flags)
  if (!parsed) return
  const { opts, where, afterWhere, els, then } = parsed
  const claudeSessionId = opts.session ?? process.env.CONSOLE_CLAUDE_SESSION_ID ?? ''
  if (!claudeSessionId) { exitWithError('USAGE', `--session is required (your claudeSessionId; \`ps -o args= -p $PPID\` shows --session-id).\n${EXPECT_USAGE}`, flags); return }
  if (claudeSessionId !== 'al' && !UUID_RE.test(claudeSessionId)) { exitWithError('USAGE', `--session must be a claudeSessionId (UUID) or "al". Got: ${claudeSessionId}`, flags); return }
  if (!opts.on) { exitWithError('USAGE', `--on <topic> is required — the event you expect.\n${EXPECT_USAGE}`, flags); return }
  if (!els) { exitWithError('USAGE', `--else <action> is required — what to do when it does not happen.\n${EXPECT_USAGE}`, flags); return }
  if (opts.by === undefined && opts.within === undefined) { exitWithError('USAGE', `Pick a deadline: --by <cron|iso|+dur> (absolute) or --within <duration> (relative).\n${EXPECT_USAGE}`, flags); return }
  const window = parseDuration(opts.window, 'window', flags)
  const within = parseDuration(opts.within, 'within', flags)
  if ((opts.window && window === undefined) || (opts.within && within === undefined)) return
  const elseAction = buildAction(els, flags); if (!elseAction) return
  const thenAction = then ? buildAction(then, flags) : undefined
  if (then && !thenAction) return

  let guard = opts.guard
  if (!guard && opts['guard-file']) {
    const { readFileSync } = await import('node:fs')
    guard = readFileSync(opts['guard-file'], 'utf8')
  }
  if (opts.once !== undefined && opts.times !== undefined) { exitWithError('USAGE', '--once and --times are the same knob; pass one', flags); return }
  const times = opts.once === 'true' ? 1 : opts.times !== undefined ? Number(opts.times) : undefined
  if (times !== undefined && (!Number.isInteger(times) || times < 1)) { exitWithError('USAGE', '--times wants a whole number ≥ 1', flags); return }
  const expiresAt = opts.expires ? parseExpires(opts.expires, flags) : undefined
  if (opts.expires && expiresAt === undefined) return

  const body = {
    owner: { claudeSessionId, ...(process.env.CONSOLE_AGENT_KEY ? { agentKey: process.env.CONSOLE_AGENT_KEY } : {}), cwd: process.cwd() },
    on: opts.on,
    where,
    ...(guard ? { guard } : {}),
    ...(opts.hours ? { hours: opts.hours } : {}),
    ...(opts.days ? { days: opts.days } : {}),
    ...(opts['max-per-hour'] ? { maxPerHour: Number(opts['max-per-hour']) } : {}),
    ...(opts.name ? { name: opts.name } : {}),
    ...(times !== undefined ? { times } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    expect: {
      ...(opts.by !== undefined ? { by: opts.by } : {}),
      ...(window !== undefined ? { window } : {}),
      ...(opts.after ? { after: opts.after } : {}),
      ...(afterWhere.length ? { afterWhere } : {}),
      ...(within !== undefined ? { within } : {}),
      ...(thenAction ? { then: thenAction } : {}),
    },
    action: elseAction,
  }
  const l = await hubFetch<Listener>('/listeners', { method: 'POST', body })
  if (isJsonMode(flags)) { output(l, flags); return }
  const life = lifetime(l)
  process.stdout.write(`${l.id}  ${ruleText(l)}${life ? `  [${life}]` : ''}\n`)
  process.stdout.write(`  else ${describeAction(l.action)}${l.expect?.then ? `; then ${describeAction(l.expect.then)}` : ''}\n`)
  process.stdout.write(`  ${expectStats(l)}. Dry-run an event: con listen test ${l.id} --topic ${l.on} --data '{…}'; judge now: con listen flush ${l.id}\n`)
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
