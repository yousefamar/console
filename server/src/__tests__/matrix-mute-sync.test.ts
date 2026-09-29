import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatrixSync } from '../matrix/sync.js'
import { parseSnoozeUntil } from '../routes/matrix.js'

const ME = '@u:example'
const ROOM = '!muted:x'

function makeSync(syncResponse: Record<string, unknown>) {
  const auth = { getMatrixConfig: () => ({ homeserver: 'https://matrix.example', accessToken: 'tok', userId: ME }) }
  const matrix = {
    sync: async () => syncResponse,
    getPushRules: async () => ({ global: { room: [{ rule_id: ROOM, enabled: true, actions: [] }] } }),
  }
  const crypto = { isReady: () => true, processSyncCrypto: async () => {} }
  const chatRoomsStore = {
    snapshot: () => ({ seq: 1, data: { '!known:x': { id: '!known:x', name: 'Known' } } }),
    getRoom: (id: string) => (id === '!known:x' ? { id, name: 'Known' } : undefined),
    applySyncDelta: vi.fn(),
    setMutedRoomIds: vi.fn(),
    setRoomUnread: vi.fn(),
    setRoomSnoozedUntil: vi.fn(),
    removeRoom: vi.fn(),
  }
  const dir = mkdtempSync(join(tmpdir(), 'mx-mute-'))
  const sync = new MatrixSync(
    matrix as any, crypto as any, auth as any,
    { broadcast: () => {} } as any, { broadcast: () => {} } as any,
    join(dir, 'state.json'),
    () => {},
    chatRoomsStore as any,
  )
  return { sync, dir, chatRoomsStore }
}

describe('MatrixSync mute plumbing (^tall-ant)', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('an m.push_rules change in a tick reaches the snapshot (setMutedRoomIds), rooms in the delta or not', async () => {
    const pushRules = { type: 'm.push_rules', content: { global: { room: [{ rule_id: ROOM, enabled: true, actions: [] }] } } }
    const { sync, dir: d, chatRoomsStore } = makeSync({ next_batch: 's2', account_data: { events: [pushRules] }, rooms: { join: {} } })
    dir = d
    ;(sync as any).state.nextBatch = 's1' // not the initial sync
    await (sync as any).tick()
    expect(chatRoomsStore.setMutedRoomIds).toHaveBeenCalledTimes(1)
    expect([...chatRoomsStore.setMutedRoomIds.mock.calls[0]![0] as Set<string>]).toEqual([ROOM])
  })

  it('a tick without push-rule changes leaves the snapshot mutes alone', async () => {
    const { sync, dir: d, chatRoomsStore } = makeSync({ next_batch: 's2', rooms: { join: {} } })
    dir = d
    ;(sync as any).state.nextBatch = 's1'
    await (sync as any).tick()
    expect(chatRoomsStore.setMutedRoomIds).not.toHaveBeenCalled()
  })

  it('the boot seed pushes the parsed set into the snapshot too', async () => {
    const { sync, dir: d, chatRoomsStore } = makeSync({})
    dir = d
    await (sync as any).refreshPushRules()
    expect([...chatRoomsStore.setMutedRoomIds.mock.calls[0]![0] as Set<string>]).toEqual([ROOM])
  })

  it('markUnread / snooze 404 on a room the snapshot never saw instead of silently succeeding', async () => {
    const { sync, dir: d, chatRoomsStore } = makeSync({})
    dir = d
    await expect(sync.markUnread({ roomId: '!nope:x' })).rejects.toMatchObject({ status: 404 })
    await expect(sync.snooze({ roomId: '!nope:x', untilMs: 5 })).rejects.toMatchObject({ status: 404 })
    expect(chatRoomsStore.setRoomUnread).not.toHaveBeenCalled()
    await sync.markUnread({ roomId: '!known:x' })
    await sync.snooze({ roomId: '!known:x', untilMs: 5 })
    expect(chatRoomsStore.setRoomUnread).toHaveBeenCalledWith('!known:x')
    expect(chatRoomsStore.setRoomSnoozedUntil).toHaveBeenCalledWith('!known:x', 5)
  })
})

describe('parseSnoozeUntil', () => {
  const now = 1_000_000
  it('relative, ISO and epoch forms', () => {
    expect(parseSnoozeUntil('+30m', now)).toBe(now + 30 * 60_000)
    expect(parseSnoozeUntil('+2H', now)).toBe(now + 2 * 3_600_000)
    expect(parseSnoozeUntil('+1d', now)).toBe(now + 86_400_000)
    expect(parseSnoozeUntil('2026-09-30T07:00:00Z', now)).toBe(Date.parse('2026-09-30T07:00:00Z'))
    expect(parseSnoozeUntil('1790595834000', now)).toBe(1790595834000)
    expect(parseSnoozeUntil(1790595834000, now)).toBe(1790595834000)
  })
  it('absent / none / 0 clear the snooze; garbage is rejected', () => {
    for (const v of [undefined, null, '', 0, 'none', 'CLEAR', '0']) expect(parseSnoozeUntil(v, now)).toBeUndefined()
    for (const v of ['tomorrow', '+5w', -1, {}]) expect(parseSnoozeUntil(v, now)).toBeNull()
  })
})
