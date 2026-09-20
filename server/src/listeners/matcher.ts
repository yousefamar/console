// `where` matchers and active-window arithmetic. Pure functions; no clock of
// their own. Matchers are deliberately NOT an expression language — anything
// a key=value clause cannot say belongs in a guard script.

import type { HubEvent } from '../events/types.js'
import type { WhereClause, WhereOp } from './types.js'

const OPS: WhereOp[] = ['!=', '>=', '<=', '^=', '=', '~', '>', '<']
const WHERE_RE = /^([A-Za-z0-9_][A-Za-z0-9_.\-]*)\s*(!=|>=|<=|\^=|=|~|>|<|\s+in\s+)\s*(.*)$/s

/** `data.room=!abc` → clause; throws on nonsense so `con listen add` fails loudly. */
export function parseWhere(raw: string): WhereClause {
  const m = WHERE_RE.exec(raw.trim())
  if (!m) throw new Error(`bad --where "${raw}": expected <path><op><value> with op one of ${OPS.join(' ')} or " in "`)
  const op = (m[2]!.trim() === 'in' ? 'in' : m[2]!.trim()) as WhereOp
  const value = m[3]!
  if (op === '~') {
    try { compileRegex(value) } catch (e) { throw new Error(`bad regex in --where "${raw}": ${(e as Error).message}`) }
  }
  if ((op === '>' || op === '<' || op === '>=' || op === '<=') && Number.isNaN(Number(value))) {
    throw new Error(`--where "${raw}": ${op} needs a numeric value`)
  }
  return { path: m[1]!, op, value }
}

/** `/body/flags` for flags (`/^gm\b/i`), otherwise a bare case-sensitive pattern. */
export function compileRegex(value: string): RegExp {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(value)
  return m ? new RegExp(m[1]!, m[2]) : new RegExp(value)
}

export function formatWhere(c: WhereClause): string {
  return c.op === 'in' ? `${c.path} in ${c.value}` : `${c.path}${c.op}${c.value}`
}

/** Dotted lookup; `data.headers.x-github-event` works because segments may carry dashes. */
export function pathGet(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function asString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

export function clauseMatches(ev: HubEvent, c: WhereClause): boolean {
  const raw = pathGet(ev, c.path)
  const s = asString(raw)
  switch (c.op) {
    case '=': return s !== undefined && s === c.value
    case '!=': return s !== c.value
    case '^=': return s !== undefined && s.startsWith(c.value)
    case '~': { if (s === undefined) return false; try { return compileRegex(c.value).test(s) } catch { return false } }
    case 'in': return s !== undefined && c.value.split('|').map((x) => x.trim()).includes(s)
    case '>': case '<': case '>=': case '<=': {
      const n = typeof raw === 'number' ? raw : Number(s)
      const v = Number(c.value)
      if (Number.isNaN(n) || Number.isNaN(v)) return false
      return c.op === '>' ? n > v : c.op === '<' ? n < v : c.op === '>=' ? n >= v : n <= v
    }
  }
}

export function whereMatches(ev: HubEvent, clauses: WhereClause[]): boolean {
  return clauses.every((c) => clauseMatches(ev, c))
}

// ── active windows (Europe/London) ─────────────────────────────────────────

const TZ = 'Europe/London'
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS_RE = /^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/

function localParts(ms: number): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date(ms))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const h = Number(get('hour')) % 24
  return { minutes: h * 60 + Number(get('minute')), weekday: DAY_NAMES.indexOf(get('weekday')) }
}

export function parseHours(raw: string): { from: number; to: number } {
  const m = HOURS_RE.exec(raw.trim())
  if (!m) throw new Error(`bad --hours "${raw}": expected HH:MM-HH:MM (Europe/London)`)
  const from = Number(m[1]) * 60 + Number(m[2] ?? 0)
  const to = Number(m[3]) * 60 + Number(m[4] ?? 0)
  if (from > 24 * 60 || to > 24 * 60) throw new Error(`bad --hours "${raw}"`)
  return { from, to }
}

/** `Mon-Fri`, `Sat,Sun`, `Mon,Wed-Fri` → set of weekday indexes (0 = Sun). */
export function parseDays(raw: string): Set<number> {
  const out = new Set<number>()
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map((s) => DAY_NAMES.findIndex((d) => d.toLowerCase() === s.trim().slice(0, 3).toLowerCase()))
    if (a === undefined || a < 0 || (b !== undefined && b < 0)) throw new Error(`bad --days "${raw}": use Mon-Fri or Sat,Sun`)
    if (b === undefined) { out.add(a); continue }
    for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break }
  }
  return out
}

export function inWindow(ms: number, hours?: string, days?: string): boolean {
  const { minutes, weekday } = localParts(ms)
  if (days && !parseDays(days).has(weekday)) return false
  if (hours) {
    const { from, to } = parseHours(hours)
    // `22:00-06:00` wraps past midnight.
    return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to
  }
  return true
}

/** Next instant (≥ ms) inside the window, stepping by 5 min up to 8 days; null = never opens. */
export function nextWindowStart(ms: number, hours?: string, days?: string): number | null {
  if (inWindow(ms, hours, days)) return ms
  const step = 5 * 60_000
  for (let t = ms - (ms % step) + step; t <= ms + 8 * 86_400_000; t += step) {
    if (inWindow(t, hours, days)) return t
  }
  return null
}
