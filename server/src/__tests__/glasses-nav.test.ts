import { describe, it, expect } from 'vitest'
import { parseNavStep } from '../routes/glasses.js'

// The hub gates nav steps on the firmware's buffer sizes (docs/g1-protocol.md §18)
// so a refused frame is a 422 with a reason, not a silent BLE ack with status 1.
describe('parseNavStep', () => {
  it('accepts a full step and defaults the optional fields', () => {
    const step = parseNavStep({ direction: 5, road: 'High St', distance: '200 m' })
    expect(step).toEqual({ direction: 5, road: 'High St', distance: '200 m', eta: '', remaining: '', speed: '', x: 0, y: 0 })
  })

  it('rejects directions outside the 35 pictograms', () => {
    expect(parseNavStep({ direction: 0, road: 'A' })).toMatch(/1\.\.35/)
    expect(parseNavStep({ direction: 36, road: 'A' })).toMatch(/1\.\.35/)
    expect(parseNavStep({ direction: '5.5', road: 'A' })).toMatch(/1\.\.35/)
    expect(parseNavStep({ road: 'A' })).toMatch(/1\.\.35/)
  })

  it('needs at least a road or a distance', () => {
    expect(parseNavStep({ direction: 1 })).toMatch(/road or distance/)
  })

  it('enforces the byte limits in UTF-8, not characters', () => {
    expect(parseNavStep({ direction: 1, road: 'x'.repeat(63) })).toMatchObject({ direction: 1 })
    expect(parseNavStep({ direction: 1, road: 'x'.repeat(64) })).toMatch(/road exceeds 63/)
    expect(parseNavStep({ direction: 1, road: 'é'.repeat(32) })).toMatch(/road exceeds 63/)   // 64 bytes
    expect(parseNavStep({ direction: 1, road: 'A', distance: 'x'.repeat(24) })).toMatch(/distance exceeds 23/)
    expect(parseNavStep({ direction: 1, road: 'A', eta: 'x'.repeat(24) })).toMatch(/eta exceeds 23/)
    expect(parseNavStep({ direction: 1, road: 'A', remaining: 'x'.repeat(24) })).toMatch(/remaining exceeds 23/)
    expect(parseNavStep({ direction: 1, road: 'A', speed: 'x'.repeat(24) })).toMatch(/speed exceeds 23/)
  })

  it('keeps the panoramic marker inside the 488x136 map', () => {
    expect(parseNavStep({ direction: 1, road: 'A', x: 488, y: 136 })).toMatchObject({ x: 488, y: 136 })
    expect(parseNavStep({ direction: 1, road: 'A', x: 489 })).toMatch(/x must be/)
    expect(parseNavStep({ direction: 1, road: 'A', y: -1 })).toMatch(/x must be/)
    expect(parseNavStep({ direction: 1, road: 'A', x: 1.5 })).toMatch(/x must be/)
  })
})

import { handleGlassesRoutes } from '../routes/glasses.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

function fakeRes() {
  const out: { code?: number; body?: string } = {}
  const res = {
    writeHead(code: number) { out.code = code; return res },
    end(body?: string) { out.body = body; res.done?.() },
    done: undefined as undefined | (() => void),
  }
  // The 503 path ends synchronously inside the handler's IIFE — resolve at once if it already did.
  return { res: res as unknown as ServerResponse, out, wait: () => new Promise<void>((r) => { if (out.body !== undefined) r(); else res.done = r }) }
}

async function call(path: string, body: unknown, hub: Record<string, unknown>) {
  const { res, out, wait } = fakeRes()
  const req = { method: 'POST', url: path } as IncomingMessage
  const handled = handleGlassesRoutes(req, res, path, hub as never, async () => JSON.stringify(body), { get: () => ({}) } as never)
  if (handled) await wait()
  return { handled, ...out, json: out.body ? JSON.parse(out.body) : undefined }
}

describe('POST /glasses/nav/*', () => {
  it('503s when the APK is not connected, before reading the body', async () => {
    const r = await call('/glasses/nav/step', { direction: 1, road: 'A' }, { hasClient: () => false })
    expect(r.code).toBe(503)
  })

  it('422s a refused step before any RPC', async () => {
    let called = false
    const r = await call('/glasses/nav/step', { direction: 1, road: 'x'.repeat(64) }, { hasClient: () => true, navStep: async () => { called = true } })
    expect(r.code).toBe(422)
    expect(r.json.error).toMatch(/road exceeds/)
    expect(called).toBe(false)
  })

  it('relays the firmware ack for a valid step and passes the parsed step through', async () => {
    let got: unknown
    const r = await call('/glasses/nav/step', { direction: 5, road: 'High St', distance: '200 m', eta: '12 min' },
      { hasClient: () => true, navStep: async (s: unknown) => { got = s; return { ok: true, status: 0, ack: '0a06000501' } } })
    expect(r.code).toBe(200)
    expect(r.json).toEqual({ ok: true, status: 0, ack: '0a06000501' })
    expect(got).toMatchObject({ direction: 5, road: 'High St', distance: '200 m', eta: '12 min', remaining: '', speed: '', x: 0, y: 0 })
  })

  it('gates arrived and map on the firmware sizes', async () => {
    const hub = { hasClient: () => true, navArrived: async () => ({ ok: true }), navMap: async () => ({ ok: true }) }
    expect((await call('/glasses/nav/arrived', { status: 3, prompt: 'x' }, hub)).code).toBe(422)
    expect((await call('/glasses/nav/arrived', { status: 2, prompt: 'x'.repeat(64) }, hub)).code).toBe(422)
    expect((await call('/glasses/nav/arrived', { status: 2, prompt: 'Arrived' }, hub)).code).toBe(200)
    expect((await call('/glasses/nav/map', { planes: Buffer.alloc(10).toString('base64') }, hub)).code).toBe(422)
    expect((await call('/glasses/nav/map', { planes: Buffer.alloc(4624).toString('base64') }, hub)).code).toBe(200)
    expect((await call('/glasses/nav/map', { panoramic: true, planes: Buffer.alloc(16592).toString('base64') }, hub)).code).toBe(200)
  })

  it('leaves unknown nav verbs to the 404 fallthrough', async () => {
    const r = await call('/glasses/nav/dance', {}, { hasClient: () => true })
    expect(r.handled).toBe(false)
  })
})
