// Expectation deadlines. `--by` is a cron expression, an ISO datetime, or a
// relative `+2h`; croner computes the next tick (Europe/London, like every
// other listener clock). The engine keeps only `pending[].deadlineAt` on disk
// and re-derives timers from it.

import { Cron } from 'croner'
import type { Expectation, Listener } from './types.js'
import { formatWhere } from './matcher.js'

const TZ = 'Europe/London'

/** Normalise `--by`: relative → absolute epoch string; cron/ISO validated. Throws on nonsense. */
export function parseBy(raw: string, now: number): string {
  const s = raw.trim()
  const rel = /^\+(\d+)\s*(s|m|h|d)$/.exec(s)
  if (rel) return String(now + Number(rel[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 's' | 'm' | 'h' | 'd'])
  if (/^\d{12,}$/.test(s)) return s
  if (s.split(/\s+/).length >= 5) {
    try { new Cron(s, { timezone: TZ }) } catch (e) { throw new Error(`--by "${s}" is not a valid cron expression: ${(e as Error).message}`) }
    return s
  }
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw new Error(`--by wants a 5-field cron ("10 19 * * 2"), an ISO datetime, or +<duration> (got "${raw}")`)
  return String(t)
}

export function isOneShotBy(by: string): boolean {
  return /^\d{12,}$/.test(by)
}

/** Next deadline strictly after `from`, or undefined when a one-shot has passed. */
export function nextDeadline(by: string, from: number): number | undefined {
  if (isOneShotBy(by)) { const t = Number(by); return t > from ? t : undefined }
  return new Cron(by, { timezone: TZ }).nextRun(new Date(from))?.getTime()
}

export function describeBy(by: string): string {
  if (isOneShotBy(by)) return `by ${new Date(Number(by)).toLocaleString('en-GB', { timeZone: TZ, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '')}`
  return `by "${by}"`
}

export function fmtDur(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

/** One line: what must happen, by when — for lists, envelopes and logs. */
export function describeExpect(l: Listener): string {
  const x = l.expect!
  const onText = `${l.on}${l.where.length ? ` where ${l.where.map(formatWhere).join(' && ')}` : ''}`
  if (x.by !== undefined) return `expect ${onText} ${describeBy(x.by)}${x.windowMs ? ` (window ${fmtDur(x.windowMs)})` : ''}`
  const afterText = x.after ? ` after ${x.after.on}${x.after.where.length ? ` where ${x.after.where.map(formatWhere).join(' && ')}` : ''}` : ''
  return `expect ${onText} within ${fmtDur(x.withinMs ?? 0)}${afterText}`
}

export function isAbsolute(x: Expectation): boolean {
  return x.by !== undefined
}
