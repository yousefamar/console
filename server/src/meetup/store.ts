// Hub-authoritative Meetup events store. Keyed by event id, persisted atomically
// to ~/.config/console/meetup-events.json (tmp + rename, the manifest.ts pattern).
// Summary fields come from the area search; the `detail` sub-object (long
// description) is filled lazily when an event is opened. Events are time-bound,
// so `prune` drops anything that has already ended (run on load + each snapshot).

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { type MeetupEvent, type MeetupEventDetail, isExpired } from './types.js'

export class MeetupEventStore {
  private events = new Map<string, MeetupEvent>()

  constructor(private file: string) {
    this.load()
    this.prune(Date.now())
  }

  /** Insert/refresh area-search summaries; returns the rows that changed. */
  upsert(found: MeetupEvent[]): MeetupEvent[] {
    const changed: MeetupEvent[] = []
    for (const ev of found) {
      if (!ev.id) continue
      const prev = this.events.get(ev.id)
      // Preserve any previously-loaded detail across a summary refresh.
      const merged: MeetupEvent = prev?.detail ? { ...ev, detail: prev.detail } : ev
      this.events.set(ev.id, merged)
      changed.push(merged)
    }
    if (changed.length) this.save()
    return changed
  }

  get(id: string): MeetupEvent | undefined {
    return this.events.get(id)
  }

  setDetail(id: string, detail: MeetupEventDetail): MeetupEvent | undefined {
    const ev = this.events.get(id)
    if (!ev) return undefined
    ev.detail = detail
    this.save()
    return ev
  }

  all(): MeetupEvent[] {
    return [...this.events.values()]
  }

  count(): number {
    return this.events.size
  }

  /** Drop events that have already ended. Returns the number removed. */
  prune(nowMs: number): number {
    let removed = 0
    for (const [id, ev] of this.events) {
      if (isExpired(ev, nowMs)) {
        this.events.delete(id)
        removed++
      }
    }
    if (removed) this.save()
    return removed
  }

  /** Snapshot for the client mirror — summaries only (detail fetched on tap). */
  getSnapshot(): { events: MeetupEvent[] } {
    this.prune(Date.now())
    return { events: this.all().map(({ detail: _detail, ...summary }) => summary) }
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf8')) as { events?: MeetupEvent[] }
        for (const ev of data.events ?? []) if (ev.id) this.events.set(ev.id, ev)
      }
    } catch {
      // corrupt store — start empty
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ events: this.all() }), 'utf8')
    renameSync(tmp, this.file)
  }
}
