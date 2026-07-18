import { describe, it, expect, afterEach, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { decideWsUpgrade } from '../auth-middleware.js'
import type { AuthStore, HubToken, HubSession } from '../auth-store.js'

// Minimal fake of the two AuthStore methods the middleware touches.
function fakeStore(opts: { validToken?: string; validSession?: string } = {}): AuthStore {
  return {
    validateHubToken: (plaintext: string): HubToken | null =>
      opts.validToken && plaintext === opts.validToken
        ? ({ id: 't1', name: 'apk', scope: 'apk', hash: 'x', createdAt: 0 } as unknown as HubToken)
        : null,
    findHubSession: (id: string): HubSession | undefined =>
      opts.validSession && id === opts.validSession
        ? ({ id, email: 'yousefamar@gmail.com', createdAt: 0, expiresAt: Date.now() + 10_000 } as unknown as HubSession)
        : undefined,
  } as unknown as AuthStore
}

function fakeReq(opts: {
  url?: string
  origin?: string
  bearer?: string
  cookie?: string
  remoteAddress?: string
  forwarded?: boolean
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.origin) headers.origin = opts.origin
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.forwarded) headers['x-forwarded-for'] = '203.0.113.9'
  return {
    url: opts.url ?? '/push',
    method: 'GET',
    headers,
    socket: { remoteAddress: opts.remoteAddress ?? '203.0.113.9' },
  } as unknown as IncomingMessage
}

const originAllowed = (o: string | undefined) => o === 'https://con.amar.io'

describe('decideWsUpgrade', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('rejects an upgrade with no credentials from off-host', () => {
    const d = decideWsUpgrade(fakeReq({}), fakeStore(), originAllowed)
    expect(d.allow).toBe(false)
    expect(d.reason).toBe('no-credentials')
  })

  it('accepts a valid bearer (APK PushService path)', () => {
    const d = decideWsUpgrade(
      fakeReq({ bearer: 'good-token' }),
      fakeStore({ validToken: 'good-token' }),
      originAllowed,
    )
    expect(d.allow).toBe(true)
    expect(d.principal?.kind).toBe('bearer')
  })

  it('rejects an invalid bearer', () => {
    const d = decideWsUpgrade(fakeReq({ bearer: 'bad' }), fakeStore({ validToken: 'good' }), originAllowed)
    expect(d.allow).toBe(false)
    expect(d.reason).toBe('bearer-invalid')
  })

  it('accepts a browser with allowed origin + valid session cookie', () => {
    const d = decideWsUpgrade(
      fakeReq({ origin: 'https://con.amar.io', cookie: 'console_session=sess1' }),
      fakeStore({ validSession: 'sess1' }),
      originAllowed,
    )
    expect(d.allow).toBe(true)
    expect(d.principal?.kind).toBe('session')
  })

  it('rejects a browser from a disallowed origin even with a valid cookie', () => {
    const d = decideWsUpgrade(
      fakeReq({ origin: 'https://evil.example', cookie: 'console_session=sess1' }),
      fakeStore({ validSession: 'sess1' }),
      originAllowed,
    )
    expect(d.allow).toBe(false)
    expect(d.reason).toBe('ws-origin-not-allowed')
  })

  it('rejects an allowed-origin browser with no session cookie', () => {
    const d = decideWsUpgrade(
      fakeReq({ origin: 'https://con.amar.io' }),
      fakeStore(),
      originAllowed,
    )
    expect(d.allow).toBe(false)
  })

  it('accepts true loopback with no credentials (CLI/Al)', () => {
    const d = decideWsUpgrade(
      fakeReq({ remoteAddress: '127.0.0.1' }),
      fakeStore(),
      originAllowed,
    )
    expect(d.allow).toBe(true)
    expect(d.principal?.kind).toBe('loopback')
  })

  it('rejects Caddy-proxied loopback (X-Forwarded-For present) with no credentials', () => {
    const d = decideWsUpgrade(
      fakeReq({ remoteAddress: '127.0.0.1', forwarded: true }),
      fakeStore(),
      originAllowed,
    )
    expect(d.allow).toBe(false)
  })

  it('exempts /stt until the native app ships its bearer', () => {
    const d = decideWsUpgrade(fakeReq({ url: '/stt' }), fakeStore(), originAllowed)
    expect(d.allow).toBe(true)
    expect(d.reason).toBe('ws-stt-exempt-v38-apk')
  })

  it('rejects cookie+bearer together (confused deputy)', () => {
    const d = decideWsUpgrade(
      fakeReq({ bearer: 'good', cookie: 'console_session=sess1' }),
      fakeStore({ validToken: 'good', validSession: 'sess1' }),
      originAllowed,
    )
    expect(d.allow).toBe(false)
    expect(d.reason).toBe('cookie-and-bearer')
  })
})
