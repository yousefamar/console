import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatrixSync } from '../matrix/sync.js'

const HOMESERVER = 'https://matrix.example'
const ME = '@u:example'
const ROOM = '!r:x'

function makeSync(opts: { bridged?: boolean; target?: Record<string, unknown> | Error } = {}) {
  const auth = { getMatrixConfig: () => ({ homeserver: HOMESERVER, accessToken: 'tok', userId: ME }) }
  const target = opts.target ?? { type: 'm.room.message', sender: ME, content: { msgtype: 'm.text', body: 'old' } }
  const matrix = {
    getRoomState: async () => [{ type: 'm.room.create' }],
    getEvent: async () => { if (target instanceof Error) throw target; return target },
  }
  const crypto = { isReady: () => false }
  const chatRoomsStore = {
    snapshot: () => ({ data: opts.bridged ? { [ROOM]: { networkIcon: 'whatsapp' } } : {} }),
  }
  const dir = mkdtempSync(join(tmpdir(), 'mx-edit-'))
  const sync = new MatrixSync(
    matrix as any, crypto as any, auth as any,
    { broadcast: () => {} } as any, { broadcast: () => {} } as any,
    join(dir, 'state.json'),
    () => {},
    chatRoomsStore as any,
  )
  return { sync, dir }
}

/** Feed a bridge verdict through the same path tick() uses. */
function deliverStatus(sync: MatrixSync, eventId: string, content: Record<string, unknown>) {
  ;(sync as any).noteBridgeSendStatus({
    type: 'com.beeper.message_send_status',
    content: { 'm.relates_to': { rel_type: 'm.reference', event_id: eventId }, ...content },
  })
}

describe('MatrixSync.editMessage', () => {
  let dir: string
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ event_id: '$edit1' }) }))
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  it('sends an m.replace with the SPA content shape (fallback body prefixed " * ")', async () => {
    const { sync, dir: d } = makeSync()
    dir = d
    const res = await sync.editMessage({ roomId: ROOM, eventId: '$orig', body: 'new text' })
    expect(res).toEqual({ event_id: '$edit1' })
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body as string)
    expect(sent).toEqual({
      msgtype: 'm.text',
      body: ' * new text',
      'm.new_content': { msgtype: 'm.text', body: 'new text' },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
    })
  })

  it('carries html on both the outer content and m.new_content', async () => {
    const { sync, dir: d } = makeSync()
    dir = d
    await sync.editMessage({ roomId: ROOM, eventId: '$orig', body: 'new', html: '<b>new</b>' })
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body as string)
    expect(sent.format).toBe('org.matrix.custom.html')
    expect(sent.formatted_body).toBe(' * <b>new</b>')
    expect(sent['m.new_content'].formatted_body).toBe('<b>new</b>')
  })

  it("refuses to edit someone else's message and never hits the homeserver", async () => {
    const { sync, dir: d } = makeSync({ target: { type: 'm.room.message', sender: '@them:example', content: {} } })
    dir = d
    await expect(sync.editMessage({ roomId: ROOM, eventId: '$theirs', body: 'x' })).rejects.toThrow(/not your message/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('surfaces a missing target as "event not found"', async () => {
    const { sync, dir: d } = makeSync({ target: new Error('404 M_NOT_FOUND') })
    dir = d
    await expect(sync.editMessage({ roomId: ROOM, eventId: '$gone', body: 'x' })).rejects.toThrow(/event not found/)
  })

  it('refuses non-message events (reactions, state)', async () => {
    const { sync, dir: d } = makeSync({ target: { type: 'm.reaction', sender: ME, content: {} } })
    dir = d
    await expect(sync.editMessage({ roomId: ROOM, eventId: '$react', body: 'x' })).rejects.toThrow(/not a message/)
  })

  it('unbridged room: returns as soon as the homeserver accepts, no bridge field', async () => {
    const { sync, dir: d } = makeSync({ bridged: false })
    dir = d
    const res = await sync.editMessage({ roomId: ROOM, eventId: '$orig', body: 'x', waitMs: 5000 })
    expect(res.bridge).toBeUndefined()
  })

  it('bridged room: waits for the bridge verdict and attaches it', async () => {
    const { sync, dir: d } = makeSync({ bridged: true })
    dir = d
    const p = sync.editMessage({ roomId: ROOM, eventId: '$orig', body: 'x', waitMs: 5000 })
    await new Promise((r) => setTimeout(r, 10))
    deliverStatus(sync, '$edit1', { status: 'PENDING', network: 'whatsapp' }) // ignored
    deliverStatus(sync, '$edit1', { status: 'FAIL_PERMANENT', reason: 'm.too_old', error: 'message is too old to edit', network: 'whatsapp' })
    const res = await p
    expect(res.bridge).toEqual({ status: 'FAIL_PERMANENT', reason: 'm.too_old', error: 'message is too old to edit', network: 'whatsapp' })
  })

  it('bridged room: a verdict that lands before the PUT returns is not lost', async () => {
    const { sync, dir: d } = makeSync({ bridged: true })
    dir = d
    let release!: () => void
    fetchSpy.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ ok: true, text: async () => JSON.stringify({ event_id: '$edit1' }) })
    }))
    const p = sync.editMessage({ roomId: ROOM, eventId: '$orig', body: 'x', waitMs: 5000 })
    await new Promise((r) => setTimeout(r, 10))
    deliverStatus(sync, '$edit1', { status: 'SUCCESS', network: 'whatsapp' })
    release()
    const res = await p
    expect(res.bridge?.status).toBe('SUCCESS')
  })

  it('bridged room: no verdict within waitMs → resolves without a bridge field', async () => {
    const { sync, dir: d } = makeSync({ bridged: true })
    dir = d
    const res = await sync.editMessage({ roomId: ROOM, eventId: '$orig', body: 'x', waitMs: 30 })
    expect(res.event_id).toBe('$edit1')
    expect(res.bridge).toBeUndefined()
  })

  it('statuses for unrelated sends are not buffered when nothing is armed', async () => {
    const { sync, dir: d } = makeSync({ bridged: true })
    dir = d
    deliverStatus(sync, '$stray', { status: 'SUCCESS' })
    expect((sync as any).earlyBridgeStatuses.size).toBe(0)
  })
})
