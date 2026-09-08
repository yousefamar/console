import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GlassesHub } from '../glasses-hub.js'
import { describeRunningApp, handleGlassesRoutes } from '../routes/glasses.js'
import type { PushServer } from '../push.js'
import type { GlassesConfig } from '../glasses/config.js'

// Card ^glad-vole: the hub owns 0x4B message ids so a pushed card can later be
// dismissed with 0x4C. See docs/g1-protocol.md §19.

function hub(): GlassesHub {
  const push = { clientCount: () => 0, broadcastRaw: () => {} } as unknown as PushServer
  return new GlassesHub(push, () => {})
}

/**
 * A GlassesHub wired to a fake APK: every rpc_request is captured, and the
 * `reply` hook decides what the "phone" answers. Locks the hub↔APK method
 * names — a rename on either side silently breaks dismissal otherwise, and
 * there is no compiler between the two.
 */
function fakeApkHub(reply: (method: string, params: Record<string, unknown>) => unknown) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = []
  let h!: GlassesHub
  const push = {
    clientCount: () => 1,
    broadcastRaw: (raw: string) => {
      const f = JSON.parse(raw) as { id: string; method: string; params: Record<string, unknown> }
      sent.push({ method: f.method, params: f.params })
      // Answer on the next tick, like a real phone would.
      setTimeout(() => {
        h.handleMessage(undefined as never, {
          type: 'rpc_response', id: f.id, ok: true, result: reply(f.method, f.params),
        })
      }, 0)
    },
  } as unknown as PushServer
  h = new GlassesHub(push, () => {})
  return { hub: h, sent }
}

/** Minimal req/res pair for driving handleGlassesRoutes without a socket. */
function fakeHttp(path: string, body: unknown) {
  const res = { status: 0, body: '' }
  const request = { method: 'POST', url: path } as IncomingMessage
  const response = {
    writeHead: (status: number) => { res.status = status },
    end: (chunk?: string) => { res.body = chunk ?? '' },
  } as unknown as ServerResponse
  const readBody = async () => JSON.stringify(body)
  return { request, response, readBody, res }
}

const NO_CONFIG = { get: () => ({}), merge: (x: unknown) => x } as unknown as GlassesConfig

describe('GlassesHub.allocMsgId', () => {
  it('starts at 1 and increments — 0 is never handed out', () => {
    const h = hub()
    expect(h.allocMsgId()).toBe(1)
    expect(h.allocMsgId()).toBe(2)
  })

  it('wraps 255 back to 1, staying inside the one-byte wire field', () => {
    const h = hub()
    const seen = new Set<number>()
    for (let i = 0; i < 255; i++) seen.add(h.allocMsgId())
    expect(seen.size).toBe(255)
    expect(Math.min(...seen)).toBe(1)
    expect(Math.max(...seen)).toBe(255)
    // 256th allocation is back at the start, not 0 and not 256.
    expect(h.allocMsgId()).toBe(1)
  })
})

describe('hub → APK RPC contract', () => {
  it('notify sends the hub-allocated msgId and hands it back', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ ok: true }))
    const first = await h.notify({ appIdentifier: 'io.amar.console', title: 'T', subtitle: '', message: 'M' })
    expect(sent[0]!.method).toBe('notify')
    expect(sent[0]!.params.msgId).toBe(first.msgId)
    // Consecutive pushes get distinct ids, so both remain dismissible.
    const second = await h.notify({ appIdentifier: 'io.amar.console', title: 'T2', subtitle: '', message: '' })
    expect(second.msgId).not.toBe(first.msgId)
  })

  it('dismiss targets the same id under the notifyDismiss method', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ ok: true }))
    const { msgId } = await h.notify({ appIdentifier: 'io.amar.console', title: 'T', subtitle: '', message: '' })
    await h.dismissNotification(msgId)
    expect(sent[1]).toEqual({ method: 'notifyDismiss', params: { msgId } })
  })

  it('systemStatus returns what the glasses answered', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ runningApp: 0, idle: true }))
    expect(await h.systemStatus()).toEqual({ runningApp: 0, idle: true })
    expect(sent[0]!.method).toBe('systemStatus')
  })

  it('unpair always carries confirm — the APK refuses it otherwise', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ ok: true }))
    await h.unpairGlasses()
    expect(sent[0]).toEqual({ method: 'unpairGlasses', params: { confirm: true } })
  })
})

describe('route guards', () => {
  it('unpair without confirm is a 400 and never reaches the glasses', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ ok: true }))
    const { request, response, readBody, res } = fakeHttp('/glasses/unpair', {})
    handleGlassesRoutes(request, response, '/glasses/unpair', h, readBody, NO_CONFIG)
    await new Promise((r) => setTimeout(r, 5))
    expect(res.status).toBe(400)
    expect(sent).toHaveLength(0)
  })

  it('dismiss rejects an out-of-range msgId (the wire field is one byte)', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ ok: true }))
    const { request, response, readBody, res } = fakeHttp('/glasses/notify/dismiss', { msgId: 300 })
    handleGlassesRoutes(request, response, '/glasses/notify/dismiss', h, readBody, NO_CONFIG)
    await new Promise((r) => setTimeout(r, 5))
    expect(res.status).toBe(400)
    expect(sent).toHaveLength(0)
  })

  it('dismiss with a valid id reaches the glasses and echoes it', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ ok: true }))
    const { request, response, readBody, res } = fakeHttp('/glasses/notify/dismiss', { msgId: 7 })
    handleGlassesRoutes(request, response, '/glasses/notify/dismiss', h, readBody, NO_CONFIG)
    await new Promise((r) => setTimeout(r, 10))
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, msgId: 7 })
    expect(sent).toEqual([{ method: 'notifyDismiss', params: { msgId: 7 } }])
  })
})

describe('describeRunningApp', () => {
  it('names the two ids the firmware defines', () => {
    expect(describeRunningApp(0)).toBe('idle')
    expect(describeRunningApp(0xFF)).toBe('none')
  })

  it('reports an unmapped feature id verbatim rather than guessing', () => {
    expect(describeRunningApp(3)).toBe('app 3')
  })

  it('says unknown when nothing has asked the glasses yet', () => {
    expect(describeRunningApp(null)).toBe('unknown')
  })
})
