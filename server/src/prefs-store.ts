// User preference store — cross-device sync via the hub.
//
// Persists to ~/.config/console/prefs.json. Simple key/value JSON document;
// the SPA reads the whole blob on boot via GET /config and writes individual
// keys via PUT /config (server-side merge). Good fit for user-controlled
// state that should follow the user across browsers/devices — DnD flag,
// calendar visibility, pane order — not for derived state or caches.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type PrefsValue = string | number | boolean | null | PrefsValue[] | { [k: string]: PrefsValue }

export class PrefsStore {
  private prefs: Record<string, PrefsValue> = {}

  constructor(private path: string) {
    this.prefs = this.load()
  }

  getAll(): Record<string, PrefsValue> {
    return { ...this.prefs }
  }

  get<T extends PrefsValue = PrefsValue>(key: string): T | undefined {
    return this.prefs[key] as T | undefined
  }

  // Shallow merge — callers PUT a partial object and it replaces matching
  // top-level keys. Nested objects are overwritten whole, not deep-merged;
  // SPA is expected to read-modify-write when that matters.
  merge(patch: Record<string, PrefsValue>): Record<string, PrefsValue> {
    this.prefs = { ...this.prefs, ...patch }
    this.save()
    return this.getAll()
  }

  set(key: string, value: PrefsValue): void {
    this.prefs[key] = value
    this.save()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.prefs, null, 2), 'utf8')
    } catch (err) {
      console.error('[prefs] Failed to save:', (err as Error).message)
    }
  }

  private load(): Record<string, PrefsValue> {
    try {
      const data = readFileSync(this.path, 'utf8')
      return JSON.parse(data) as Record<string, PrefsValue>
    } catch {
      return {}
    }
  }
}
