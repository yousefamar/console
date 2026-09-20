// Listener persistence — one JSON file, atomic tmp+rename, debounced like the
// cron scheduler's. Everything the engine needs after a restart is in here:
// the rules, pending coalesce batches, the outcome journal, the ceiling
// window. Timers are the only in-memory state and are re-derived.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Listener } from './types.js'

const SAVE_DEBOUNCE_MS = 500

export class ListenerStore {
  listeners: Listener[] = []
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly file: string, private readonly log: (m: string) => void = () => {}) {
    this.load()
  }

  mintId(): string {
    let id: string
    do { id = `L${randomBytes(4).toString('base64url').slice(0, 6)}` } while (this.listeners.some((l) => l.id === id))
    return id
  }

  get(id: string): Listener | undefined {
    return this.listeners.find((l) => l.id === id)
  }

  persist(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.persistSync() }, SAVE_DEBOUNCE_MS)
  }

  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    this.persistSync()
  }

  persistSync(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ listeners: this.listeners }, null, 2))
      renameSync(tmp, this.file)
    } catch (e) {
      this.log(`[listeners] save failed: ${(e as Error).message}`)
    }
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { listeners?: Listener[] }
      this.listeners = Array.isArray(raw.listeners) ? raw.listeners : []
      for (const l of this.listeners) {
        l.firedAt ??= []
        l.outcomes ??= []
        l.stats ??= { matched: 0, fired: 0, guardSkipped: 0 }
        l.consecutiveSkips ??= 0
        l.where ??= []
      }
    } catch (e) {
      this.log(`[listeners] load failed: ${(e as Error).message}`)
    }
  }
}
