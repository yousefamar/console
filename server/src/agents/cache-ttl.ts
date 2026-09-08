// Per-session prompt-cache TTL policy + the ledger that proves it paid off.
//
// Claude Code reads CLAUDE_CODE_PROMPT_CACHE_TTL ("5m" | "1h") at process start
// and runs every request of that process on it; unset = 5m on Bedrock. A 1h
// write costs 2× a 5m write, so 1h only wins when the next request lands
// between 5 and 60 minutes later — a session being worked (a card fork, a
// conversation Yousef keeps returning to), not one woken once by a cron. The
// hub decides at spawn time from what it knows about the session; the ledger
// counts the CLI's reported `cache_creation.ephemeral_{1h,5m}_input_tokens`
// per day so the split is measurable after a week.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type CacheTtl = '5m' | '1h'

export type CacheTtlReason =
  | 'pinned'      // caller fixed it for the session's lifetime (ticket forks)
  | 'woken'       // hibernated session brought back by a message
  | 'mid-turn'    // spawning a session whose turn is unfinished (restart resume)
  | 'recent'      // respawn of a session active within the last N minutes
  | 'idle'        // respawn of a session idle longer than that
  | 'fresh'       // brand-new session, no history to judge by

export interface CacheTtlInput {
  pin?: CacheTtl | null
  /** The spawn is a hibernation wake (the message that woke it is pending). */
  wake?: boolean
  /** Turn unfinished at spawn time: manifest `wasRunning`, live `midTurn`, or `status === 'running'`. */
  midTurn?: boolean
  /** The session has sent at least one message in its life (a fresh instance has not). */
  everActive?: boolean
  lastActivityAt?: number
  now?: number
  recentMs: number
}

export const DEFAULT_RECENT_MINUTES = 30

/** Decide the TTL for one spawn. Order matters: a pin beats everything; a
 *  wake is 5m even though sendMessage has already stamped activity + midTurn
 *  on the instance (hibernation means it sat idle ≥30 min — the exact case
 *  the 5m cache is for). */
export function resolveCacheTtl(i: CacheTtlInput): { ttl: CacheTtl; reason: CacheTtlReason } {
  if (i.pin) return { ttl: i.pin, reason: 'pinned' }
  if (i.wake) return { ttl: '5m', reason: 'woken' }
  if (i.midTurn) return { ttl: '1h', reason: 'mid-turn' }
  if (!i.everActive) return { ttl: '5m', reason: 'fresh' }
  const now = i.now ?? Date.now()
  if (i.lastActivityAt !== undefined && now - i.lastActivityAt < i.recentMs) return { ttl: '1h', reason: 'recent' }
  return { ttl: '5m', reason: 'idle' }
}

export interface CacheTtlDay {
  day: string
  /** Cache-write tokens the CLI reported per TTL class. */
  written1h: number
  written5m: number
  /** Cache-read tokens (all classes — the API does not split reads). */
  read: number
  spawns1h: number
  spawns5m: number
}

interface LedgerFile { days: Record<string, Omit<CacheTtlDay, 'day'>> }

/** Per-day counters, persisted atomically. Keyed by LOCAL calendar day so the
 *  readout lines up with the Cost Explorer chart beside it. */
export class CacheTtlLedger {
  private data: LedgerFile = { days: {} }
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private file: string, private now: () => number = Date.now) {
    if (existsSync(file)) {
      try { this.data = JSON.parse(readFileSync(file, 'utf-8')) as LedgerFile } catch { this.data = { days: {} } }
      if (!this.data.days) this.data.days = {}
    }
  }

  private dayKey(): string {
    const d = new Date(this.now())
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  private bucket(): Omit<CacheTtlDay, 'day'> {
    const k = this.dayKey()
    return (this.data.days[k] ??= { written1h: 0, written5m: 0, read: 0, spawns1h: 0, spawns5m: 0 })
  }

  recordSpawn(ttl: CacheTtl): void {
    const b = this.bucket()
    if (ttl === '1h') b.spawns1h++
    else b.spawns5m++
    this.schedule()
  }

  /** From a CLI `result` message's `usage`. Older CLIs omit `cache_creation`;
   *  their writes are all 5m (the only TTL they could produce). */
  recordUsage(usage: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } }): void {
    const b = this.bucket()
    const c = usage.cache_creation
    if (c) {
      b.written1h += c.ephemeral_1h_input_tokens ?? 0
      b.written5m += c.ephemeral_5m_input_tokens ?? 0
    } else {
      b.written5m += usage.cache_creation_input_tokens ?? 0
    }
    b.read += usage.cache_read_input_tokens ?? 0
    this.schedule()
  }

  /** The last `days` local days, newest first, incl. empty days as zeros. */
  summary(days: number): { days: CacheTtlDay[]; totals: Omit<CacheTtlDay, 'day'> } {
    const out: CacheTtlDay[] = []
    const totals = { written1h: 0, written5m: 0, read: 0, spawns1h: 0, spawns5m: 0 }
    const p = (n: number) => String(n).padStart(2, '0')
    for (let i = 0; i < days; i++) {
      const d = new Date(this.now())
      d.setDate(d.getDate() - i)
      const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      const b = this.data.days[key] ?? { written1h: 0, written5m: 0, read: 0, spawns1h: 0, spawns5m: 0 }
      out.push({ day: key, ...b })
      totals.written1h += b.written1h; totals.written5m += b.written5m; totals.read += b.read
      totals.spawns1h += b.spawns1h; totals.spawns5m += b.spawns5m
    }
    return { days: out, totals }
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, 2_000)
  }

  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data))
      renameSync(tmp, this.file)
    } catch { /* best effort — counters are advisory */ }
  }
}

// ---- Session ↔ hub seam. Session imports this module; index.ts installs the
// hub's prefs reader + ledger once at boot. Kept module-level so Session has
// no constructor dependency on either.

export interface CacheTtlHooks {
  /** Minutes of inactivity within which a respawn still counts as "worked". */
  recentMinutes: () => number
  onSpawn?: (ttl: CacheTtl, reason: CacheTtlReason, sessionLabel: string) => void
  onUsage?: (usage: Parameters<CacheTtlLedger['recordUsage']>[0]) => void
}

let hooks: CacheTtlHooks = { recentMinutes: () => DEFAULT_RECENT_MINUTES }

export function setCacheTtlHooks(h: CacheTtlHooks): void { hooks = h }
export function cacheTtlHooks(): CacheTtlHooks { return hooks }
