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
// Mutations broadcast a per-key PATCH (`{seq, changed, removed}`) computed by
// diffing against the previous snapshot, and a ring buffer of recent diffs
// backs `snapshotSince(seq)` so a briefly-offline client can catch up without
// re-downloading the full snapshot (~300KB for chat rooms — real money on
// mobile data). Clients that only understand full snapshots keep working:
// the `snapshot` RPC and the out-of-window fallback still return `{seq, data}`.
//
// Patch broadcasting is OPT-IN per store (`patchDeltas: true`) because it
// changes the `<name>.delta` wire shape and every consumer of that service
// must understand `{seq, partial, changed, removed}`. It also requires T to
// be a Record<string, row> map. Stores that don't opt in keep broadcasting
// the full `{seq, data}` snapshot (e.g. spotify — tiny payload, and its
// snapshot is a struct, not a keyed map).
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
  /** Broadcast per-key patches instead of full snapshots (requires T to be a
   *  Record<string, row> map, and every consumer of `<name>.delta` to handle
   *  the `{seq, partial, changed, removed}` shape). */
  patchDeltas?: boolean
}

/** Wire shape clients receive on `<name>.snapshot` RPCs and out-of-window
 *  `snapshotSince` fallbacks: the full snapshot. */
export interface SnapshotEnvelope<T> {
  seq: number
  data: T
}

/** Wire shape of `<name>.delta` broadcasts and in-window `snapshotSince`
 *  responses: only the keys that changed/vanished. `partial: true` marks it
 *  so consumers can discriminate from a full `{seq, data}` envelope. */
export interface SnapshotPatch {
  seq: number
  partial: true
  changed: Record<string, unknown>
  removed: string[]
}

export type SnapshotSinceResult<T> = SnapshotEnvelope<T> | SnapshotPatch

function isRecordMap(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Per-key shallow diff between two record maps. Rows are compared by JSON
 *  identity — rows are plain data throughout the hub, and mutators build
 *  replacement objects, so serialize-compare is both correct and cheap
 *  relative to the ~2s /sync cadence. */
export function diffRecordMaps(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): { changed: Record<string, unknown>; removed: string[] } {
  const changed: Record<string, unknown> = {}
  const removed: string[] = []
  for (const key of Object.keys(next)) {
    const b = next[key]
    const a = prev[key]
    if (a === undefined || JSON.stringify(a) !== JSON.stringify(b)) changed[key] = b
  }
  for (const key of Object.keys(prev)) {
    if (!(key in next)) removed.push(key)
  }
  return { changed, removed }
}

export class SnapshotStore<T> {
  private snapshot: T
  private seq = 0
  private readonly name: string
  private readonly path: string
  private readonly bus?: SyncBus
  private readonly log: (msg: string) => void
  private readonly patchDeltas: boolean

  constructor(opts: SnapshotStoreOptions<T>) {
    this.name = opts.name
    this.path = opts.path
    this.bus = opts.bus
    this.log = opts.log ?? (() => {})
    this.patchDeltas = opts.patchDeltas ?? false
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
    // Snapshot the pre-mutation state for diffing. Mutators may edit rows in
    // place (applySyncDelta mutates `draft`), so a reference copy of the map
    // isn't enough — clone before handing the draft out.
    const prev = this.patchDeltas && isRecordMap(this.snapshot)
      ? (structuredClone(this.snapshot) as Record<string, unknown>)
      : null
    const next = fn(this.snapshot)
    if (next === false) return
    if (next !== undefined) this.snapshot = next
    this.seq++
    this.persist()

    if (prev && isRecordMap(this.snapshot)) {
      const { changed, removed } = diffRecordMaps(prev, this.snapshot as Record<string, unknown>)
      const patch: SnapshotPatch = { seq: this.seq, partial: true, changed, removed }
      this.pushDiff(patch)
      this.bus?.broadcast(this.name, 'delta', patch)
    } else {
      // Non-map store: no patch protocol, broadcast the full snapshot.
      this.bus?.broadcast(this.name, 'delta', { seq: this.seq, data: this.snapshot })
    }
  }

  // Ring buffer of recent per-seq diffs backing snapshotSince(). 200 entries
  // ≈ 200 mutations of headroom; a client further behind gets the full
  // snapshot, which is always correct — the buffer is purely bandwidth relief.
  private static readonly DIFF_WINDOW = 200
  private readonly diffs: SnapshotPatch[] = []
  private pushDiff(patch: SnapshotPatch): void {
    this.diffs.push(patch)
    if (this.diffs.length > SnapshotStore.DIFF_WINDOW) this.diffs.shift()
  }

  /**
   * Catch-up lookup for `<name>.snapshotSince` RPCs. If `sinceSeq` is within
   * the diff window, returns one coalesced patch `{seq, partial, changed,
   * removed}` covering everything after it (later writes to a key win;
   * a remove after a change drops the change). Otherwise — client too far
   * behind, seq from a previous hub life, or no cursor — returns the full
   * `{seq, data}` snapshot.
   */
  snapshotSince(sinceSeq?: number): SnapshotSinceResult<T> {
    if (typeof sinceSeq !== 'number' || sinceSeq >= this.seq) {
      if (sinceSeq === this.seq) return { seq: this.seq, partial: true, changed: {}, removed: [] }
      return this.get()
    }
    const first = this.diffs[0]
    // Coverage check: we need every diff from sinceSeq+1 .. seq present.
    if (!first || first.seq > sinceSeq + 1) return this.get()
    const changed: Record<string, unknown> = {}
    const removedSet = new Set<string>()
    for (const d of this.diffs) {
      if (d.seq <= sinceSeq) continue
      for (const [k, v] of Object.entries(d.changed)) {
        changed[k] = v
        removedSet.delete(k)
      }
      for (const k of d.removed) {
        delete changed[k]
        removedSet.add(k)
      }
    }
    return { seq: this.seq, partial: true, changed, removed: [...removedSet] }
  }
}
