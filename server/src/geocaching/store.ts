// Hub-authoritative geocache store. Keyed by GC code, persisted atomically to
// ~/.config/console/geocaches.json (tmp + rename, the manifest.ts pattern).
// Summary fields come from the area search; the `detail` sub-object is filled
// lazily when a cache is opened. The client mirrors this into Dexie via SyncBus.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Geocache, GeocacheDetail } from './types.js'

export class GeocacheStore {
  private caches = new Map<string, Geocache>()

  constructor(private file: string) {
    this.load()
  }

  /** Insert/refresh area-search summaries; returns the rows that changed. */
  upsertSummaries(found: Geocache[]): Geocache[] {
    const changed: Geocache[] = []
    for (const c of found) {
      if (!c.code) continue
      const prev = this.caches.get(c.code)
      // Preserve any previously-loaded detail across a summary refresh.
      const merged: Geocache = prev?.detail ? { ...c, detail: prev.detail } : c
      this.caches.set(c.code, merged)
      changed.push(merged)
    }
    if (changed.length) this.save()
    return changed
  }

  get(code: string): Geocache | undefined {
    return this.caches.get(code)
  }

  setDetail(code: string, detail: GeocacheDetail): Geocache | undefined {
    const c = this.caches.get(code)
    if (!c) return undefined
    c.detail = detail
    this.save()
    return c
  }

  all(): Geocache[] {
    return [...this.caches.values()]
  }

  count(): number {
    return this.caches.size
  }

  /** Snapshot for the client mirror — summaries only (detail is fetched on tap). */
  getSnapshot(): { caches: Geocache[] } {
    return { caches: this.all().map(({ detail: _detail, ...summary }) => summary) }
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf8')) as { caches?: Geocache[] }
        for (const c of data.caches ?? []) if (c.code) this.caches.set(c.code, c)
      }
    } catch {
      // corrupt store — start empty
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ caches: this.all() }), 'utf8')
    renameSync(tmp, this.file)
  }
}
