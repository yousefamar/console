// ============================================================================
// SnapshotStore — generic hub-owned, persisted, broadcast-on-mutate store.
//
// The pattern Console wants for any "the hub is the source of truth, every
// device should converge to it" piece of state. Wraps:
//   1. JSON-on-disk persistence (atomic .tmp + rename, matching the
//      finance-*.json / cal-state.json / mail-state.json pattern already
//      used throughout the hub — no new deps).
//   2. A monotonic `seq` counter bumped on every mutation. Clients track
//      `lastSeenSeq` so they can ask for "everything since X".
//   3. SyncBus broadcast on every change. Subscribers consume `<name>.delta`
//      and apply the new snapshot or patch.
//
// Today every mutation broadcasts the full snapshot — fine for small stores
// (chat rooms = ~300KB). For larger stores we can introduce a patch format
// later; the seq counter is already in place to make that incremental.
//
// Usage:
//   const store = new SnapshotStore<MyShape>({
//     name: 'chat-rooms',          // SyncBus service name + filename
//     path: join(cfgDir, 'chat-rooms.json'),
//     defaultValue: {},
//     bus: syncBus,
//     log,
//   })
//   store.update((draft) => { draft[id] = newRoom })
//   const { seq, data } = store.get()
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SyncBus } from './sync-bus.js'

export interface SnapshotStoreOptions<T> {
  /** SyncBus service name + on-disk filename root. */
  name: string
  /** Absolute file path the snapshot is persisted to. */
  path: string
  /** Initial value when the file doesn't exist yet. */
  defaultValue: T
  /** Optional bus for broadcasting `<name>.delta` events on mutation. */
  bus?: SyncBus
  /** Optional logger. */
  log?: (msg: string) => void
}

/** Wire shape clients receive on `<name>.delta` and `<name>.snapshot` RPCs. */
export interface SnapshotEnvelope<T> {
  seq: number
  data: T
}

export class SnapshotStore<T> {
  private snapshot: T
  private seq = 0
  private readonly name: string
  private readonly path: string
  private readonly bus?: SyncBus
  private readonly log: (msg: string) => void

  constructor(opts: SnapshotStoreOptions<T>) {
    this.name = opts.name
    this.path = opts.path
    this.bus = opts.bus
    this.log = opts.log ?? (() => {})
    this.snapshot = this.load(opts.defaultValue)
  }

  private load(defaultValue: T): T {
    if (!existsSync(this.path)) return structuredClone(defaultValue)
    try {
      const raw = readFileSync(this.path, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      // Accept both wrapped `{seq, data}` (the format we write) and legacy
      // unwrapped objects so adopters can migrate existing JSON files in
      // place without a manual conversion step.
      if (parsed && typeof parsed === 'object' && 'seq' in (parsed as any) && 'data' in (parsed as any)) {
        const env = parsed as SnapshotEnvelope<T>
        this.seq = Number(env.seq) || 0
        return env.data
      }
      return parsed as T
    } catch (e) {
      this.log(`[snapshot:${this.name}] load failed, starting fresh: ${(e as Error).message}`)
      return structuredClone(defaultValue)
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify({ seq: this.seq, data: this.snapshot }))
    renameSync(tmp, this.path)
  }

  /** Read the current snapshot. */
  get(): SnapshotEnvelope<T> {
    return { seq: this.seq, data: this.snapshot }
  }

  /**
   * Apply a mutator. The mutator may mutate `draft` in place, or return a
   * replacement snapshot. Returning `false` aborts the write — useful when
   * the mutator runs idempotency checks and finds nothing to do.
   *
   * Persist + broadcast happen together so any client observing a `seq` bump
   * can trust the new snapshot is on disk.
   */
  update(fn: (draft: T) => T | void | false): void {
    const next = fn(this.snapshot)
    if (next === false) return
    if (next !== undefined) this.snapshot = next
    this.seq++
    this.persist()
    this.bus?.broadcast(this.name, 'delta', { seq: this.seq, data: this.snapshot })
  }

  /**
   * Snapshot lookup for `<name>.snapshot` RPCs. `sinceSeq` is reserved for a
   * future patch protocol; today we always return the full snapshot, which
   * a client compares against its own seq to decide whether to ingest.
   */
  snapshotSince(_sinceSeq?: number): SnapshotEnvelope<T> {
    return this.get()
  }
}
