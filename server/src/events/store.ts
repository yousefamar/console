// Append-only event log: one JSONL file per UTC day under
// ~/.config/console/events/. A line is written synchronously BEFORE the event
// is dispatched, so an event can be logged-but-undispatched (recoverable) but
// never dispatched-but-unlogged. Small files, sync reads — the log is a
// forensic + replay surface, not a database.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { RETENTION_DAYS, topicMatches, type HubEvent } from './types.js'

const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export interface ListQuery {
  topic?: string
  source?: string
  since?: number
  until?: number
  limit?: number
}

export class EventStore {
  private lastMintedAt = 0

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  /** Same shape as webhook delivery ids; strictly monotone within a process. */
  mintId(at: number): string {
    this.lastMintedAt = Math.max(at, this.lastMintedAt + 1)
    return `${new Date(this.lastMintedAt).toISOString().replace(/:/g, '-')}-${randomBytes(2).toString('hex')}`
  }

  private fileFor(ms: number): string {
    return join(this.dir, `${dayOf(ms)}.jsonl`)
  }

  append(ev: HubEvent): void {
    appendFileSync(this.fileFor(ev.at), `${JSON.stringify(ev)}\n`)
  }

  /** Day files, newest first. */
  private days(): string[] {
    return readdirSync(this.dir).filter((f) => DAY_RE.test(f)).sort().reverse()
  }

  private readDay(file: string): HubEvent[] {
    const path = join(this.dir, file)
    if (!existsSync(path)) return []
    const out: HubEvent[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      try { out.push(JSON.parse(line) as HubEvent) } catch { /* torn final line after a crash */ }
    }
    return out
  }

  /** Newest first. Walks day files from the newest until `limit` is met or `since` is passed. */
  list(q: ListQuery = {}): HubEvent[] {
    const limit = Math.min(1000, Math.max(1, q.limit ?? 50))
    const out: HubEvent[] = []
    for (const file of this.days()) {
      const day = file.slice(0, 10)
      const dayStart = Date.parse(`${day}T00:00:00Z`)
      if (q.since !== undefined && dayStart + 86_400_000 <= q.since) break
      if (q.until !== undefined && dayStart > q.until) continue
      const evs = this.readDay(file).reverse()
      for (const ev of evs) {
        if (q.since !== undefined && ev.at < q.since) continue
        if (q.until !== undefined && ev.at > q.until) continue
        if (q.topic && !topicMatches(q.topic, ev.topic)) continue
        if (q.source && ev.source !== q.source) continue
        out.push(ev)
        if (out.length >= limit) return out
      }
    }
    return out
  }

  get(id: string): HubEvent | null {
    const m = /^(\d{4}-\d{2}-\d{2})T/.exec(id)
    if (!m) return null
    return this.readDay(`${m[1]}.jsonl`).find((e) => e.id === id) ?? null
  }

  /** `(topic, key)` pairs seen within the window — the dedup set is rebuilt from
   *  here on start, because a restart is exactly when sources redeliver. */
  recentKeys(windowMs: number, now = Date.now()): Map<string, number> {
    const out = new Map<string, number>()
    for (const ev of this.list({ since: now - windowMs, limit: 1000 })) {
      if (ev.key) out.set(`${ev.topic}\u0000${ev.key}`, ev.at)
    }
    return out
  }

  /** Delete day files older than the retention window. Returns what went. */
  prune(retentionDays = RETENTION_DAYS, now = Date.now()): string[] {
    const cutoff = dayOf(now - retentionDays * 86_400_000)
    const gone: string[] = []
    for (const file of this.days()) {
      if (file.slice(0, 10) < cutoff) { rmSync(join(this.dir, file), { force: true }); gone.push(file) }
    }
    return gone
  }

  // ── liveness heartbeat (for hub.started's downtime figure) ────────────────

  private get aliveFile(): string { return join(this.dir, 'alive.json') }

  heartbeat(now = Date.now()): void {
    const tmp = `${this.aliveFile}.tmp`
    writeFileSync(tmp, JSON.stringify({ at: now }))
    renameSync(tmp, this.aliveFile)
  }

  lastAlive(): number | null {
    try { return (JSON.parse(readFileSync(this.aliveFile, 'utf8')) as { at?: number }).at ?? null } catch { return null }
  }
}
