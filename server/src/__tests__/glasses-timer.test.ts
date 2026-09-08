import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GlassesHub } from '../glasses-hub.js'
import { handleGlassesRoutes } from '../routes/glasses.js'
import type { PushServer } from '../push.js'
import type { GlassesConfig } from '../glasses/config.js'
import { parseDuration, formatDuration, COUNTDOWN_MAX_SECONDS } from '../glasses/timer.js'

// Card ^wavy-crow: the glasses' native countdown (0x07, BLE_REQ_PUT_COUNTDOWN_TIMER).
// Layout + evidence in docs/g1-protocol.md §21. The seconds field is a DURATION
// (the firmware decrements it locally), so every entry point speaks durations.

describe('parseDuration', () => {
  it.each([
    ['10m', 600],
    ['10 min', 600],
    ['10 minutes', 600],
    ['1h30m', 5400],
    ['1h 30m', 5400],
    ['1 hour 30 minutes', 5400],
    ['90 seconds', 90],
    ['90s', 90],
    ['2h', 7200],
    ['1:30', 90],
    ['1:30:00', 5400],
    ['12:30', 750],
    ['10', 600],                       // bare number = minutes
    ['ten minutes', 600],
    ['twenty five minutes', 1500],
    ['an hour', 3600],
    ['an hour and a half', 5400],
    ['half an hour', 1800],
    ['for 10 minutes', 600],           // ring lead-in
    ['a timer for ten minutes', 600],
    ['the countdown to 5 minutes', 300],
    ['10 minutes.', 600],              // STT trailing punctuation
    ['99:59:59', COUNTDOWN_MAX_SECONDS],
  ])('%s → %d s', (spoken, secs) => {
    expect(parseDuration(spoken)).toBe(secs)
  })

  it.each([
    [''],
    ['the mood'],                      // "set the mood" is not a timer
    ['to leave'],
    ['0'],
    ['0 minutes'],
    ['100:00:00'],                     // past what the lens formats as hh
    ['10 bananas'],
  ])('%j is not a duration', (spoken) => {
    expect(parseDuration(spoken)).toBeNull()
  })
})

describe('formatDuration', () => {
  it('shows mm:ss under an hour and h:mm:ss above', () => {
    expect(formatDuration(600)).toBe('10:00')
    expect(formatDuration(90)).toBe('01:30')
    expect(formatDuration(5400)).toBe('1:30:00')
    expect(formatDuration(COUNTDOWN_MAX_SECONDS)).toBe('99:59:59')
  })
})

/** A GlassesHub wired to a fake APK — captures every rpc_request (locks the hub↔APK method name). */
function fakeApkHub(reply: (method: string, params: Record<string, unknown>) => unknown, connected = true) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = []
  let h!: GlassesHub
  const push = {
    clientCount: () => (connected ? 1 : 0),
    broadcastRaw: (raw: string) => {
      const f = JSON.parse(raw) as { id: string; method: string; params: Record<string, unknown> }
      sent.push({ method: f.method, params: f.params })
      setTimeout(() => {
        h.handleMessage(undefined as never, { type: 'rpc_response', id: f.id, ok: true, result: reply(f.method, f.params) })
      }, 0)
    },
  } as unknown as PushServer
  h = new GlassesHub(push, () => {})
  return { hub: h, sent }
}

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
const settle = () => new Promise((r) => setTimeout(r, 10))

describe('GlassesHub.countdownTimer — hub↔APK contract', () => {
  it('start sends seconds + enable:true and relays the ack', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ ok: true, status: 0xC9, ack: '07c9', seconds: 600, enable: true }))
    const ack = await h.countdownTimer(600)
    expect(sent).toEqual([{ method: 'countdownTimer', params: { seconds: 600, enable: true } }])
    expect(ack.ok).toBe(true)
  })

  it('cancel sends enable:false and no seconds', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ ok: true, seconds: 0, enable: false }))
    await h.countdownTimer(null)
    expect(sent).toEqual([{ method: 'countdownTimer', params: { enable: false } }])
  })
})

describe('POST /glasses/timer', () => {
  it('parses a spoken duration and replies with the ack + display', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ ok: true, status: 0xC9, ack: '07c9', seconds: 600, enable: true }))
    const { request, response, readBody, res } = fakeHttp('/glasses/timer', { duration: '10 minutes' })
    handleGlassesRoutes(request, response, '/glasses/timer', h, readBody, NO_CONFIG)
    await settle()
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, seconds: 600, display: '10:00' })
    expect(sent).toEqual([{ method: 'countdownTimer', params: { seconds: 600, enable: true } }])
  })

  it('accepts raw seconds', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ ok: true }))
    const { request, response, readBody } = fakeHttp('/glasses/timer', { seconds: 90 })
    handleGlassesRoutes(request, response, '/glasses/timer', h, readBody, NO_CONFIG)
    await settle()
    expect(sent[0]!.params).toEqual({ seconds: 90, enable: true })
  })

  it('a duration that does not parse is a 400 and never reaches the glasses', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ ok: true }))
    const { request, response, readBody, res } = fakeHttp('/glasses/timer', { duration: 'the mood' })
    handleGlassesRoutes(request, response, '/glasses/timer', h, readBody, NO_CONFIG)
    await settle()
    expect(res.status).toBe(400)
    expect(sent).toHaveLength(0)
  })

  it('a duration past 99:59:59 is a 400', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ ok: true }))
    const { request, response, readBody, res } = fakeHttp('/glasses/timer', { seconds: COUNTDOWN_MAX_SECONDS + 1 })
    handleGlassesRoutes(request, response, '/glasses/timer', h, readBody, NO_CONFIG)
    await settle()
    expect(res.status).toBe(400)
    expect(sent).toHaveLength(0)
  })

  it('no APK → 503, checked AFTER validation so a typo is still a 400', async () => {
    const { hub: h } = fakeApkHub(() => ({ ok: true }), false)
    const ok = fakeHttp('/glasses/timer', { duration: '5m' })
    handleGlassesRoutes(ok.request, ok.response, '/glasses/timer', h, ok.readBody, NO_CONFIG)
    await settle()
    expect(ok.res.status).toBe(503)
  })

  it('/glasses/timer/cancel sends enable:false', async () => {
    const { hub: h, sent } = fakeApkHub(() => ({ ok: true, seconds: 0, enable: false }))
    const { request, response, readBody, res } = fakeHttp('/glasses/timer/cancel', {})
    handleGlassesRoutes(request, response, '/glasses/timer/cancel', h, readBody, NO_CONFIG)
    await settle()
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, display: null })
    expect(sent).toEqual([{ method: 'countdownTimer', params: { enable: false } }])
  })
})
