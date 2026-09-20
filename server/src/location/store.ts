// GeofenceStore — fences + per-fence state in ~/.config/console/geofences.json
// (atomic whole-file writes), transitions appended to geofence-events.jsonl
// (append-only, never pruned). The last fix the watcher saw is persisted too,
// so a restart neither re-fires old transitions nor forgets where he was.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Fix, FenceState, Geofence, GeofenceEvent } from './geofence.js'

interface Persisted {
  fences: Geofence[]
  state: Record<string, FenceState>
  lastFix: Fix | null
}

export class GeofenceStore {
  private readonly file: string
  private readonly eventsFile: string
  private data: Persisted

  constructor(configDir: string) {
    mkdirSync(configDir, { recursive: true })
    this.file = join(configDir, 'geofences.json')
    this.eventsFile = join(configDir, 'geofence-events.jsonl')
    this.data = this.load()
  }

  private load(): Persisted {
    if (!existsSync(this.file)) return { fences: [], state: {}, lastFix: null }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Persisted>
      return { fences: raw.fences ?? [], state: raw.state ?? {}, lastFix: raw.lastFix ?? null }
    } catch {
      return { fences: [], state: {}, lastFix: null }
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }

  fences(): Geofence[] { return [...this.data.fences] }
  fence(id: string): Geofence | undefined { return this.data.fences.find((f) => f.id === id) }
  state(): Record<string, FenceState> { return { ...this.data.state } }
  lastFix(): Fix | null { return this.data.lastFix }

  upsert(fence: Geofence): Geofence {
    const i = this.data.fences.findIndex((f) => f.id === fence.id)
    if (i >= 0) {
      const prev = this.data.fences[i]!
      this.data.fences[i] = { ...fence, createdAt: prev.createdAt, createdBy: fence.createdBy ?? prev.createdBy }
      // geometry changed → forget the state so the next fix re-initialises silently
      if (prev.lat !== fence.lat || prev.lon !== fence.lon || prev.radius !== fence.radius) delete this.data.state[fence.id]
    } else {
      this.data.fences.push(fence)
    }
    this.save()
    return this.data.fences.find((f) => f.id === fence.id)!
  }

  remove(id: string): boolean {
    const before = this.data.fences.length
    this.data.fences = this.data.fences.filter((f) => f.id !== id)
    delete this.data.state[id]
    if (this.data.fences.length === before) return false
    this.save()
    return true
  }

  /** Drop fences past `expiresAt`; returns the removed ones. */
  pruneExpired(nowMs: number): Geofence[] {
    const gone = this.data.fences.filter((f) => f.expiresAt != null && f.expiresAt <= nowMs)
    if (!gone.length) return []
    for (const f of gone) { delete this.data.state[f.id] }
    this.data.fences = this.data.fences.filter((f) => !gone.includes(f))
    this.save()
    return gone
  }

  commit(state: Record<string, FenceState>, lastFix: Fix): void {
    this.data.state = state
    this.data.lastFix = lastFix
    this.save()
  }

  appendEvent(ev: GeofenceEvent): void {
    appendFileSync(this.eventsFile, JSON.stringify(ev) + '\n')
  }

  /** Newest first. */
  events(opts: { limit?: number; fenceId?: string | null } = {}): GeofenceEvent[] {
    const limit = opts.limit ?? 50
    if (!existsSync(this.eventsFile)) return []
    const lines = readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean)
    const out: GeofenceEvent[] = []
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const ev = JSON.parse(lines[i]!) as GeofenceEvent
        if (opts.fenceId && ev.fenceId !== opts.fenceId) continue
        out.push(ev)
      } catch { /* skip a torn line */ }
    }
    return out
  }
}
