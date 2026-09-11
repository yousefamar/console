// Per-thread WhatsApp message history — the antecedent the inbound envelope
// was missing.
//
// An envelope used to carry exactly one message. Owner replies route to the
// PARENT AL session, but sends to the owner may come from a conversation
// fork (relaying Nica), so the parent read "Tell her yeet" with no idea who
// "her" was (2026-09-11). This module records every inbound and outbound
// message per thread (ring buffer, last 50) so the envelope can show the
// recent exchange across all of a contact's identifiers (phone + @lid are one
// thread) and name which session sent each outbound line.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { normalize } from './users.js'

const PER_THREAD = 50
const TEXT_MAX = 300

function historyFile(): string {
  return process.env.CONSOLE_WA_HISTORY_FILE || join(homedir(), '.config', 'console', 'wa-history.json')
}

export interface HistoryEntry {
  ts: number
  dir: 'in' | 'out'
  /** Normalised thread id (digits for DMs, group id for groups). */
  jid: string
  /** Resolved username of the counterpart (sender for in, recipient for out). */
  user: string | null
  /** Sender's WhatsApp push name (inbound only). */
  name?: string
  text: string
  /** Outbound only: agentKey of the session that sent it ('al' = parent AL). */
  via?: string
  /** WhatsApp message id — lets the envelope exclude the message it carries. */
  id?: string
}

interface HistoryFile {
  version: 1
  threads: Record<string, HistoryEntry[]>
}

let state: HistoryFile | null = null

function load(): HistoryFile {
  if (state) return state
  try {
    if (existsSync(historyFile())) {
      const parsed = JSON.parse(readFileSync(historyFile(), 'utf-8')) as HistoryFile
      if (parsed.version === 1 && parsed.threads) return (state = parsed)
    }
  } catch (err) {
    console.error('[al/wa-history] load failed:', (err as Error)?.message)
  }
  return (state = { version: 1, threads: {} })
}

function save(): void {
  if (!state) return
  try {
    const file = historyFile()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, file)
  } catch (err) {
    console.error('[al/wa-history] save failed:', (err as Error)?.message)
  }
}

/** Drop the in-memory cache so the next call re-reads the file (tests). */
export function resetHistoryCache(): void {
  state = null
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s*\n\s*/g, ' ').trim()
  return oneLine.length > TEXT_MAX ? oneLine.slice(0, TEXT_MAX - 1) + '…' : oneLine
}

export function record(entry: HistoryEntry): void {
  const s = load()
  const jid = normalize(entry.jid)
  const list = s.threads[jid] ?? (s.threads[jid] = [])
  list.push({ ...entry, jid, text: truncate(entry.text) })
  if (list.length > PER_THREAD) list.splice(0, list.length - PER_THREAD)
  save()
}

/** The last `limit` entries across every identifier of one thread (phone +
 *  @lid, group id…), oldest first, minus the message the envelope carries. */
export function recentThread(ids: string[], opts: { excludeId?: string; limit?: number } = {}): HistoryEntry[] {
  const s = load()
  const seen = new Set<string>()
  const out: HistoryEntry[] = []
  for (const raw of ids) {
    const jid = normalize(raw)
    if (seen.has(jid)) continue
    seen.add(jid)
    for (const e of s.threads[jid] ?? []) {
      if (opts.excludeId && e.id === opts.excludeId) continue
      out.push(e)
    }
  }
  out.sort((a, b) => a.ts - b.ts)
  return out.slice(-(opts.limit ?? 6))
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Display name for a thread counterpart: resolved username, else push name,
 *  else the bare jid. */
export function counterpartLabel(e: Pick<HistoryEntry, 'user' | 'name' | 'jid'>): string {
  return e.user ? capitalise(e.user) : e.name || e.jid
}

/** 'AL' for the parent, 'AL(nica fork)' for a conversation fork (agentKey
 *  `al-nica`), any other agentKey verbatim. */
export function viaLabel(via: string | undefined): string {
  if (!via || via === 'al') return 'AL'
  if (via.startsWith('al-')) return `AL(${via.slice(3)} fork)`
  return via
}

export function formatTime(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const n = new Date(now)
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  if (sameDay) return hm
  const mon = d.toLocaleString('en-GB', { month: 'short' })
  return `${String(d.getDate()).padStart(2, '0')} ${mon} ${hm}`
}

/** One envelope line per entry: 'HH:MM Nica: …' / 'HH:MM AL→Nica: …' /
 *  'HH:MM AL(nica fork)→Yousef: …'. */
export function formatHistoryLine(e: HistoryEntry, now = Date.now()): string {
  const who = counterpartLabel(e)
  const speaker = e.dir === 'in' ? who : `${viaLabel(e.via)}→${who}`
  return `${formatTime(e.ts, now)} ${speaker}: ${e.text}`
}
