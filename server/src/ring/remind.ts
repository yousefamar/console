// `remind [me] [in <duration> | at <time> | tomorrow …] <text>` — a one-shot
// reminder to Yousef's own WhatsApp (the `echo` channel) at the spoken time,
// or `default_in` from the schema note when none was spoken. The time phrase
// may lead ("remind me in 20 minutes to check the oven") or trail ("remind me
// to check the oven in 20 minutes"); the text is kept word for word.
//
// Scheduling is hub-native — persisted JSON + croner, re-armed at boot — not
// an agent cron: a reminder is pure software and must not wake a session.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Cron } from 'croner'
import { parseDuration } from '../glasses/timer.js'

export type ReminderWhen =
  | { kind: 'in'; seconds: number }
  /** A clock time. `explicit` = am/pm or 24 h given; a bare "at 5" picks the
   *  next of 05:00 / 17:00 that is still ahead. `dayOffset` 1 = tomorrow. */
  | { kind: 'at'; hour: number; minute: number; explicit: boolean; dayOffset: number }

export interface ParsedReminder {
  text: string
  when: ReminderWhen
  /** The time phrase as spoken; null when the default delay applied. */
  spoken: string | null
}

const ME = /^(?:me|myself)[,.]?\s+/i
const TRAILING_PUNCT = /[,.;:]+$/
const TIME_MARKERS = new Set(['in', 'after', 'at', 'tomorrow'])
/** How many words a leading time phrase may span ("in an hour and a half"). */
const LEAD_MAX_WORDS = 6

const HOUR_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}
const NAMED_TIMES: Record<string, { hour: number; minute: number }> = {
  noon: { hour: 12, minute: 0 }, midday: { hour: 12, minute: 0 }, midnight: { hour: 0, minute: 0 },
}
const PART_OF_DAY: Record<string, { hour: number; minute: number }> = {
  morning: { hour: 9, minute: 0 }, afternoon: { hour: 14, minute: 0 }, evening: { hour: 18, minute: 0 }, night: { hour: 20, minute: 0 },
}
const TOMORROW_DEFAULT = PART_OF_DAY.morning!

/** "5", "5pm", "5 pm", "5:30", "17.30", "five", "half past five", "quarter to
 *  six", "noon", "5 in the morning", "5 o'clock" — optionally followed by
 *  "tomorrow". Null when the words are not a clock time. */
export function parseClockTime(spoken: string): { hour: number; minute: number; explicit: boolean; dayOffset: number } | null {
  let s = spoken.trim().toLowerCase().replace(TRAILING_PUNCT, '').replace(/\s+/g, ' ')
  if (!s) return null
  let dayOffset = 0
  const tomorrow = /\s+tomorrow$/.exec(s) ?? /^tomorrow\s+(?:at\s+)?/.exec(s)
  if (tomorrow) { dayOffset = 1; s = s.replace(tomorrow[0], '').trim(); if (!s) return null }
  const named = NAMED_TIMES[s]
  if (named) return { ...named, explicit: true, dayOffset }

  let offsetMin = 0
  const rel = /^(half|quarter)\s+(past|to)\s+/.exec(s)
  if (rel) {
    offsetMin = (rel[1] === 'half' ? 30 : 15) * (rel[2] === 'to' ? -1 : 1)
    s = s.slice(rel[0].length)
  }
  const m = /^(\d{1,2}|[a-z]+)(?:[:.](\d{2}))?\s*(?:o'?clock)?\s*(a\.?m\.?|p\.?m\.?|in the (?:morning|afternoon|evening)|at night|tonight)?$/.exec(s)
  if (!m) return null
  const hour = /^\d/.test(m[1]!) ? Number(m[1]) : HOUR_WORDS[m[1]!]
  if (hour === undefined || hour > 23) return null
  const minute = m[2] !== undefined ? Number(m[2]) : 0
  if (minute > 59) return null
  if (rel && minute) return null
  const suffix = m[3] ?? ''
  // "17:30" and "05:00" are 24 h; "5", "5:30", "10:30" could be either half.
  let h = hour
  let explicit = hour > 12 || hour === 0 || m[1]!.startsWith('0')
  if (suffix) {
    if (hour > 12) return null
    explicit = true
    const pm = /^p|afternoon|evening|night|tonight/.test(suffix)
    if (pm && hour < 12) h += 12
    if (!pm && hour === 12) h = 0
  }
  let total = h * 60 + minute + offsetMin
  if (total < 0) total += 24 * 60
  return { hour: Math.floor(total / 60) % 24, minute: total % 60, explicit, dayOffset }
}

/** A bare hour for TOMORROW has no "next one ahead" to lean on: 1–6 means the
 *  afternoon (nobody books a 3 a.m. reminder), 7–12 the morning. */
function wakingHours(c: { hour: number; minute: number; explicit: boolean; dayOffset: number }): ReminderWhen {
  if (c.dayOffset > 0 && !c.explicit) return { kind: 'at', ...c, hour: c.hour >= 1 && c.hour <= 6 ? c.hour + 12 : c.hour, explicit: true }
  return { kind: 'at', ...c }
}

/** A time phrase in the words after its marker ("in"/"after" → duration,
 *  "at" → clock, "tomorrow" → morning unless a time follows). */
function parseTimePhrase(marker: string, tail: string): ReminderWhen | null {
  const t = tail.trim().replace(TRAILING_PUNCT, '')
  if (marker === 'in' || marker === 'after') {
    if (!t) return null
    const seconds = parseDuration(t)
    return seconds === null ? null : { kind: 'in', seconds }
  }
  if (marker === 'at') {
    const c = t ? parseClockTime(t) : null
    return c ? wakingHours(c) : null
  }
  // tomorrow [morning|afternoon|evening|night] [at <time>]
  const words = t.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return { kind: 'at', ...TOMORROW_DEFAULT, explicit: true, dayOffset: 1 }
  const part = PART_OF_DAY[words[0]!]
  const rest = part ? words.slice(1) : words
  if (!rest.length) return part ? { kind: 'at', ...part, explicit: true, dayOffset: 1 } : null
  if (rest[0] !== 'at') return null
  const c = parseClockTime(rest.slice(1).join(' '))
  if (!c || c.dayOffset) return null
  if (part && !c.explicit && c.hour <= 12) return { kind: 'at', hour: part.hour >= 12 && c.hour < 12 ? c.hour + 12 : c.hour, minute: c.minute, explicit: true, dayOffset: 1 }
  return wakingHours({ ...c, dayOffset: 1 })
}

/** The words after the verb → the reminder. `fuzzyVerb` = the verb itself was
 *  only a one-edit match ("rewind" ≈ "remind"), which is a claim only "me" or a
 *  parsed time phrase can back up — free text alone could be anything. */
export function parseReminder(rest: string, defaultSeconds: number, fuzzyVerb = false): ParsedReminder | null {
  let body = rest.trim()
  const me = ME.exec(body)
  if (me) body = body.slice(me[0].length)
  if (!body) return null
  const words = body.split(' ').filter(Boolean)

  // Leading: "in 20 minutes to …", "at 5pm to …", "tomorrow morning to …" —
  // the LONGEST run of words after the marker that still parses is the phrase
  // ("in an hour and a half to …", not "in an hour").
  const first = words[0]!.toLowerCase().replace(TRAILING_PUNCT, '')
  if (TIME_MARKERS.has(first)) {
    let best: { when: ReminderWhen; end: number } | null = null
    for (let k = first === 'tomorrow' ? 0 : 1; k <= Math.min(LEAD_MAX_WORDS, words.length - 1); k++) {
      const when = parseTimePhrase(first, words.slice(1, 1 + k).join(' '))
      if (when) best = { when, end: 1 + k }
    }
    if (best) {
      const text = words.slice(best.end).join(' ').replace(/^[,.;:]+\s*/, '').trim()
      // "remind me tomorrow" — a time and nothing to be reminded of.
      if (!text) return null
      return { text, when: best.when, spoken: words.slice(0, best.end).join(' ').replace(TRAILING_PUNCT, '') }
    }
  }

  // Trailing: "… to check the oven in 20 minutes", "… at 5", "… tomorrow at 9" —
  // the LEFTMOST marker whose whole tail parses wins, so "tomorrow at 5" is
  // read entire while "be at the station at 6" still lands on the last "at"
  // ("the station at 6" is no time). Nothing before the marker → no text.
  let trailing: { when: ReminderWhen; at: number } | null = null
  for (let i = words.length - 1; i >= 1; i--) {
    const w = words[i]!.toLowerCase()
    if (!TIME_MARKERS.has(w)) continue
    const when = parseTimePhrase(w, words.slice(i + 1).join(' '))
    if (when) trailing = { when, at: i }
  }
  if (trailing) {
    const text = words.slice(0, trailing.at).join(' ').replace(TRAILING_PUNCT, '').trim()
    if (!text) return null
    return { text, when: trailing.when, spoken: words.slice(trailing.at).join(' ').replace(TRAILING_PUNCT, '') }
  }

  if (fuzzyVerb && !me) return null
  return { text: body.replace(TRAILING_PUNCT, '').trim(), when: { kind: 'in', seconds: defaultSeconds }, spoken: null }
}

/** When the reminder fires, from the spoken time and the clock now. */
export function dueAt(when: ReminderWhen, now: Date): Date {
  if (when.kind === 'in') return new Date(now.getTime() + when.seconds * 1000)
  const at = (hour: number, days: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() + days)
    d.setHours(hour, when.minute, 0, 0)
    return d
  }
  if (when.dayOffset > 0) return at(when.hour, when.dayOffset)
  // A bare "at 5" is the next 05:00 or 17:00 still ahead; both gone → 05:00 tomorrow.
  const candidates = when.explicit ? [when.hour] : when.hour === 12 ? [12, 0] : [when.hour, when.hour + 12]
  for (const h of candidates) { const d = at(h, 0); if (d > now) return d }
  return at(candidates[0]!, 1)
}

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** "17:30", "tomorrow 09:00", "Mon 22 Sep 09:00" — relative to now. */
export function formatDue(due: Date, now: Date): string {
  if (sameDay(due, now)) return hhmm(due)
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1)
  if (sameDay(due, tomorrow)) return `tomorrow ${hhmm(due)}`
  return `${due.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${hhmm(due)}`
}

export function describeWhen(when: ReminderWhen): string {
  if (when.kind === 'in') {
    const s = when.seconds
    if (s < 60) return `in ${s}s`
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60)
    return `in ${h ? `${h}h` : ''}${m || !h ? `${m}m` : ''}`
  }
  return `${when.dayOffset ? 'tomorrow ' : ''}at ${pad(when.hour)}:${pad(when.minute)}${when.explicit ? '' : ` or ${pad((when.hour + 12) % 24)}:${pad(when.minute)}`}`
}

/** The WhatsApp line. The text is Yousef's own words after "remind me": "to
 *  not leave the ring…" reads as "Reminder to not leave the ring…", a "that …"
 *  clause drops its connector. Late (hub was down) → says when it was due. */
export function formatReminder(text: string, opts: { due?: Date; now?: Date } = {}): string {
  const t = text.trim().replace(/^that\s+/i, '')
  const line = /^to\s/i.test(t) ? `Reminder ${t}` : `Reminder: ${t}`
  const late = opts.due && opts.now && opts.now.getTime() - opts.due.getTime() > LATE_AFTER_MS
  return late ? `${line} (was due ${hhmm(opts.due!)})` : line
}

const LATE_AFTER_MS = 5 * 60_000

export interface Reminder {
  id: string
  text: string
  dueAt: number
  createdAt: number
  recordingId?: string
  firedAt?: number
  attempts: number
  /** Last delivery error; cleared on success. */
  error?: string
  cancelledAt?: number
}

interface ReminderDeps {
  /** Send the line to Yousef (WhatsApp). Throws when the socket is down. */
  deliver: (message: string) => Promise<unknown>
  notify: (msg: { title: string; body: string; id: string }) => void
  log: (msg: string) => void
  now?: () => Date
}

const RETRY_MS = 5 * 60_000
const MAX_ATTEMPTS = 6
const KEEP_FIRED = 200

/** Persisted one-shot reminders, armed with croner and re-armed at boot; a
 *  reminder that came due while the hub was down fires on start, marked late.
 *  A failed send retries every RETRY_MS up to MAX_ATTEMPTS; the push goes out
 *  on the first attempt regardless, so the phone hears it even with WhatsApp
 *  down. */
export class RingReminders {
  private readonly file: string
  private reminders: Reminder[] = []
  private jobs = new Map<string, Cron>()
  private retries = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(configDir: string, private deps: ReminderDeps) {
    const dir = join(configDir, 'ring')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'reminders.json')
    this.load()
  }

  start(): void {
    for (const r of this.pending()) this.arm(r)
    this.deps.log(`[ring] ${this.pending().length} reminder(s) armed`)
  }

  stop(): void {
    for (const j of this.jobs.values()) j.stop()
    this.jobs.clear()
    for (const t of this.retries.values()) clearTimeout(t)
    this.retries.clear()
  }

  add(text: string, dueAt: number, recordingId?: string): Reminder {
    const r: Reminder = { id: randomBytes(4).toString('hex'), text, dueAt, createdAt: this.now().getTime(), attempts: 0, ...(recordingId ? { recordingId } : {}) }
    this.reminders.push(r)
    this.persist()
    this.arm(r)
    return r
  }

  cancel(id: string): boolean {
    const r = this.reminders.find((x) => x.id === id && !x.firedAt && !x.cancelledAt)
    if (!r) return false
    r.cancelledAt = this.now().getTime()
    this.disarm(id)
    this.persist()
    return true
  }

  /** Not yet fired or cancelled, soonest first. */
  pending(): Reminder[] {
    return this.reminders.filter((r) => !r.firedAt && !r.cancelledAt).sort((a, b) => a.dueAt - b.dueAt)
  }

  /** Everything kept, newest due first. */
  list(limit = 50): Reminder[] {
    return [...this.reminders].sort((a, b) => b.dueAt - a.dueAt).slice(0, limit)
  }

  /** Deliver one now (the scheduled fire, a boot-time catch-up, or a retry). */
  async fire(id: string): Promise<void> {
    const r = this.reminders.find((x) => x.id === id)
    if (!r || r.firedAt || r.cancelledAt) return
    this.disarm(id)
    const now = this.now()
    const line = formatReminder(r.text, { due: new Date(r.dueAt), now })
    if (r.attempts === 0) this.deps.notify({ id: `ring-reminder:${r.id}`, title: 'Reminder', body: r.text })
    r.attempts++
    try {
      await this.deps.deliver(line)
      r.firedAt = now.getTime()
      delete r.error
      this.deps.log(`[ring] reminder ${r.id} sent: ${line}`)
    } catch (e) {
      r.error = (e as Error).message
      if (r.attempts < MAX_ATTEMPTS) {
        this.deps.log(`[ring] reminder ${r.id} not sent (${r.error}) — retry ${r.attempts}/${MAX_ATTEMPTS - 1} in ${RETRY_MS / 60_000} min`)
        this.retries.set(r.id, setTimeout(() => { this.retries.delete(r.id); void this.fire(r.id) }, RETRY_MS))
      } else {
        r.firedAt = now.getTime()
        this.deps.log(`[ring] reminder ${r.id} given up after ${r.attempts} attempts: ${r.error}`)
        this.deps.notify({ id: `ring-reminder:${r.id}`, title: 'Reminder not sent to WhatsApp', body: `${r.text} — ${r.error}` })
      }
    }
    this.prune()
    this.persist()
  }

  private arm(r: Reminder): void {
    if (r.dueAt <= this.now().getTime()) { void this.fire(r.id); return }
    try {
      this.jobs.set(r.id, new Cron(new Date(r.dueAt), { protect: true }, () => { void this.fire(r.id) }))
    } catch (e) {
      this.deps.log(`[ring] reminder ${r.id} could not be armed: ${(e as Error).message}`)
    }
  }

  private disarm(id: string): void {
    this.jobs.get(id)?.stop()
    this.jobs.delete(id)
    const t = this.retries.get(id)
    if (t) { clearTimeout(t); this.retries.delete(id) }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /** Fired/cancelled ones are history; keep the last KEEP_FIRED of them. */
  private prune(): void {
    const done = this.reminders.filter((r) => r.firedAt || r.cancelledAt).sort((a, b) => b.dueAt - a.dueAt)
    if (done.length <= KEEP_FIRED) return
    const drop = new Set(done.slice(KEEP_FIRED).map((r) => r.id))
    this.reminders = this.reminders.filter((r) => !drop.has(r.id))
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { reminders?: Reminder[] }
      this.reminders = Array.isArray(raw.reminders) ? raw.reminders : []
    } catch (e) {
      this.deps.log(`[ring] reminders load failed: ${(e as Error).message}`)
    }
  }

  private persist(): void {
    try {
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ reminders: this.reminders }, null, 2))
      renameSync(tmp, this.file)
    } catch (e) {
      this.deps.log(`[ring] reminders save failed: ${(e as Error).message}`)
    }
  }
}
