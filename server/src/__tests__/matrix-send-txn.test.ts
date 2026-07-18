import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatrixSync } from '../matrix/sync.js'

// sendRoomEvent only touches: auth.getMatrixConfig(), matrix.getRoomState(),
// crypto.isReady(), and global fetch. Fake the first three, spy the fetch.

const HOMESERVER = 'https://matrix.example'

function makeSync() {
  const auth = {
    getMatrixConfig: () => ({ homeserver: HOMESERVER, accessToken: 'tok', userId: '@u:example' }),
  }
  const matrix = {
    // Unencrypted room: no m.room.encryption state event.
    getRoomState: async () => [{ type: 'm.room.create' }],
  }
  const crypto = { isReady: () => false }
  const dir = mkdtempSync(join(tmpdir(), 'mx-txn-'))
  const sync = new MatrixSync(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    matrix as any, crypto as any, auth as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { broadcast: () => {} } as any, { broadcast: () => {} } as any,
    join(dir, 'state.json'),
    () => {},
  )
  return { sync, dir }
}

describe('sendRoomEvent txnId idempotency', () => {
  let dir: string
  let sync: MatrixSync
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;({ sync, dir } = makeSync())
    fetchSpy = vi.fn(async (url: string | URL) => ({
      ok: true,
      text: async () => JSON.stringify({ event_id: `$evt-${String(url).split('/').pop()}` }),
    }))
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  it('uses the client-supplied txnId verbatim in the PUT url', async () => {
    await sync.sendRoomEvent({ roomId: '!r:x', type: 'm.room.message', content: { body: 'hi' }, txnId: 'apk-abc123' })
    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).toContain('/send/m.room.message/apk-abc123')
  })

  it('same txnId twice → one homeserver call, same event_id', async () => {
    const args = { roomId: '!r:x', type: 'm.room.message', content: { body: 'hi' }, txnId: 'apk-dup' }
    const first = await sync.sendRoomEvent(args)
    const second = await sync.sendRoomEvent(args)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(second.event_id).toBe(first.event_id)
  })

  it('different txnIds send independently', async () => {
    await sync.sendRoomEvent({ roomId: '!r:x', type: 'm.room.message', content: { body: 'a' }, txnId: 'apk-1' })
    await sync.sendRoomEvent({ roomId: '!r:x', type: 'm.room.message', content: { body: 'b' }, txnId: 'apk-2' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('no txnId still mints one per call (legacy behaviour)', async () => {
    await sync.sendRoomEvent({ roomId: '!r:x', type: 'm.room.message', content: { body: 'a' } })
    await sync.sendRoomEvent({ roomId: '!r:x', type: 'm.room.message', content: { body: 'a' } })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const u1 = String(fetchSpy.mock.calls[0][0])
    const u2 = String(fetchSpy.mock.calls[1][0])
    expect(u1).not.toBe(u2)
  })

  it('rejects malformed txnIds (falls back to minting) rather than URL-injecting', async () => {
    await sync.sendRoomEvent({ roomId: '!r:x', type: 'm.room.message', content: { body: 'a' }, txnId: 'bad/../txn id' })
    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).not.toContain('bad')
    expect(url).toMatch(/\/send\/m\.room\.message\/hub\d+\./)
  })

  it('a failed send is NOT cached — retry with same txnId reaches the homeserver', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'gateway' })
    await expect(
      sync.sendRoomEvent({ roomId: '!r:x', type: 'm.room.message', content: { body: 'x' }, txnId: 'apk-retry' }),
    ).rejects.toThrow('send failed')
    const ok = await sync.sendRoomEvent({ roomId: '!r:x', type: 'm.room.message', content: { body: 'x' }, txnId: 'apk-retry' })
    expect(ok.event_id).toBeTruthy()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
