import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore, diffRecordMaps, type SnapshotPatch, type SnapshotEnvelope } from '../snapshot-store.js'

type Rooms = Record<string, { name: string; unread: number }>

describe('diffRecordMaps', () => {
  it('detects added, changed, removed keys', () => {
    const prev = { a: { v: 1 }, b: { v: 2 }, c: { v: 3 } }
    const next = { a: { v: 1 }, b: { v: 20 }, d: { v: 4 } }
    const { changed, removed } = diffRecordMaps(prev, next)
    expect(Object.keys(changed).sort()).toEqual(['b', 'd'])
    expect(changed.b).toEqual({ v: 20 })
    expect(removed).toEqual(['c'])
  })

  it('returns empty diff for identical maps', () => {
    const m = { a: { v: 1 } }
    const { changed, removed } = diffRecordMaps(m, { ...m })
    expect(changed).toEqual({})
    expect(removed).toEqual([])
  })
})

describe('SnapshotStore patch deltas', () => {
  let dir: string
  let broadcasts: Array<{ service: string; op: string; data: unknown }>
  let store: SnapshotStore<Rooms>

  const fakeBus = {
    broadcast: (service: string, op: string, data: unknown) => {
      broadcasts.push({ service, op, data })
    },
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snapstore-'))
    broadcasts = []
    store = new SnapshotStore<Rooms>({
      name: 'chat-rooms',
      path: join(dir, 'rooms.json'),
      defaultValue: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bus: fakeBus as any,
      patchDeltas: true,
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('broadcasts per-key patches, not full snapshots', () => {
    store.update((d) => { d.r1 = { name: 'one', unread: 0 } })
    store.update((d) => { d.r2 = { name: 'two', unread: 3 } })

    expect(broadcasts).toHaveLength(2)
    const p2 = broadcasts[1].data as SnapshotPatch
    expect(p2.partial).toBe(true)
    expect(Object.keys(p2.changed)).toEqual(['r2'])
    expect(p2.removed).toEqual([])
    expect(p2.seq).toBe(2)
  })

  it('detects in-place mutation of existing rows', () => {
    store.update((d) => { d.r1 = { name: 'one', unread: 0 } })
    store.update((d) => { d.r1.unread = 5 })
    const p = broadcasts[1].data as SnapshotPatch
    expect(Object.keys(p.changed)).toEqual(['r1'])
    expect((p.changed.r1 as { unread: number }).unread).toBe(5)
  })

  it('reports removals', () => {
    store.update((d) => { d.r1 = { name: 'one', unread: 0 } })
    store.update((d) => { delete d.r1 })
    const p = broadcasts[1].data as SnapshotPatch
    expect(p.changed).toEqual({})
    expect(p.removed).toEqual(['r1'])
  })

  it('snapshotSince coalesces diffs: later change wins, remove-after-change drops the change', () => {
    store.update((d) => { d.r1 = { name: 'one', unread: 0 } })  // seq 1
    store.update((d) => { d.r2 = { name: 'two', unread: 1 } })  // seq 2
    store.update((d) => { d.r2.unread = 9 })                     // seq 3
    store.update((d) => { delete d.r1 })                         // seq 4

    const res = store.snapshotSince(1) as SnapshotPatch
    expect(res.partial).toBe(true)
    expect(res.seq).toBe(4)
    expect(Object.keys(res.changed)).toEqual(['r2'])
    expect((res.changed.r2 as { unread: number }).unread).toBe(9)
    expect(res.removed).toEqual(['r1'])
  })

  it('snapshotSince at current seq returns an empty patch', () => {
    store.update((d) => { d.r1 = { name: 'one', unread: 0 } })
    const res = store.snapshotSince(1) as SnapshotPatch
    expect(res.partial).toBe(true)
    expect(res.changed).toEqual({})
    expect(res.removed).toEqual([])
  })

  it('snapshotSince with no cursor or future seq returns full snapshot', () => {
    store.update((d) => { d.r1 = { name: 'one', unread: 0 } })
    const noCursor = store.snapshotSince(undefined) as SnapshotEnvelope<Rooms>
    expect('data' in noCursor).toBe(true)
    expect(noCursor.data.r1).toBeDefined()
    // A seq from a previous hub life (greater than current) → full snapshot.
    const future = store.snapshotSince(99) as SnapshotEnvelope<Rooms>
    expect('data' in future).toBe(true)
  })

  it('snapshotSince falls back to full snapshot past the ring window', () => {
    for (let i = 0; i < 205; i++) {
      store.update((d) => { d[`r${i}`] = { name: `n${i}`, unread: 0 } })
    }
    // seq 1 rolled out of the 200-entry window
    const res = store.snapshotSince(1) as SnapshotEnvelope<Rooms>
    expect('data' in res).toBe(true)
    expect(Object.keys(res.data)).toHaveLength(205)
    // A recent seq is still patchable
    const patch = store.snapshotSince(204) as SnapshotPatch
    expect(patch.partial).toBe(true)
    expect(Object.keys(patch.changed)).toEqual(['r204'])
  })

  it('seq stays monotonic and persists across reload', () => {
    store.update((d) => { d.r1 = { name: 'one', unread: 0 } })
    store.update((d) => { d.r1.unread = 1 })
    const reloaded = new SnapshotStore<Rooms>({
      name: 'chat-rooms',
      path: join(dir, 'rooms.json'),
      defaultValue: {},
    })
    expect(reloaded.get().seq).toBe(2)
    expect(reloaded.get().data.r1.unread).toBe(1)
  })

  it('without patchDeltas broadcasts full snapshots (legacy shape)', () => {
    const legacy = new SnapshotStore<Rooms>({
      name: 'spotify-like',
      path: join(dir, 'legacy.json'),
      defaultValue: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bus: fakeBus as any,
    })
    broadcasts = []
    legacy.update((d) => { d.x = { name: 'x', unread: 0 } })
    const env = broadcasts[0].data as SnapshotEnvelope<Rooms>
    expect('data' in env).toBe(true)
    expect((env as unknown as SnapshotPatch).partial).toBeUndefined()
  })

  it('aborted update (mutator returns false) emits nothing and keeps seq', () => {
    store.update((d) => { d.r1 = { name: 'one', unread: 0 } })
    broadcasts = []
    store.update(() => false)
    expect(broadcasts).toHaveLength(0)
    expect(store.get().seq).toBe(1)
  })
})
