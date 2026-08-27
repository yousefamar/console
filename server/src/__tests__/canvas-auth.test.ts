import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { decide, buildCanvasCookie, buildClearCanvasCookie } from '../auth-middleware.js'
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
        ? ({ id, email: 'yousefamar@gmail.com', createdAt: 0, lastUsedAt: 0 } as unknown as HubSession)
        : undefined,
  } as unknown as AuthStore
}

function fakeReq(opts: {
  url?: string
  method?: string
  bearer?: string
  cookie?: string
  remoteAddress?: string
  forwarded?: boolean
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.forwarded) headers['x-forwarded-for'] = '203.0.113.9'
  return {
    url: opts.url ?? '/canvas/index.html',
    method: opts.method ?? 'GET',
    headers,
    socket: { remoteAddress: opts.remoteAddress ?? '203.0.113.9' },
  } as unknown as IncomingMessage
}

describe('canvas auth gate (decide)', () => {
  it('rejects an unpublished canvas read with no credentials (the leak fix)', () => {
    const d = decide(fakeReq({ url: '/canvas/index.html' }), fakeStore())
    expect(d.allow).toBe(false)
  })

  it('rejects a canvas tab asset read with no credentials', () => {
    const d = decide(fakeReq({ url: '/canvas/tabs/foo/index.html' }), fakeStore())
    expect(d.allow).toBe(false)
  })

  it('accepts a canvas read with a valid canvas cookie (opaque-origin subresource)', () => {
    const d = decide(
      fakeReq({ url: '/canvas/tabs/foo/app.js', cookie: 'console_canvas=sess1' }),
      fakeStore({ validSession: 'sess1' }),
    )
    expect(d.allow).toBe(true)
    expect(d.reason).toBe('canvas-cookie')
  })

  it('rejects a canvas read with an invalid canvas cookie', () => {
    const d = decide(
      fakeReq({ url: '/canvas/index.html', cookie: 'console_canvas=stale' }),
      fakeStore({ validSession: 'sess1' }),
    )
    expect(d.allow).toBe(false)
  })

  it('accepts a canvas read with a valid session cookie (top-level SPA fetch)', () => {
    const d = decide(
      fakeReq({ url: '/canvas/index.html', cookie: 'console_session=sess1' }),
      fakeStore({ validSession: 'sess1' }),
    )
    expect(d.allow).toBe(true)
    expect(d.principal?.kind).toBe('session')
  })

  it('does NOT let the canvas cookie authenticate a non-canvas path', () => {
    const d = decide(
      fakeReq({ url: '/mail/threads', cookie: 'console_canvas=sess1' }),
      fakeStore({ validSession: 'sess1' }),
    )
    expect(d.allow).toBe(false)
  })

  it('does NOT let the canvas cookie authenticate a canvas mutation (DELETE)', () => {
    const d = decide(
      fakeReq({ url: '/canvas', method: 'DELETE', cookie: 'console_canvas=sess1' }),
      fakeStore({ validSession: 'sess1' }),
    )
    expect(d.allow).toBe(false)
  })

  it('leaves /public/canvas/<kind>/<slug>/ shares always-open (published path untouched)', () => {
    const d = decide(fakeReq({ url: '/public/canvas/tab/property-criteria/' }), fakeStore())
    expect(d.allow).toBe(true)
    expect(d.reason).toBe('public-namespace')
  })
})

describe('canvas cookie builders', () => {
  it('mints a SameSite=None; Secure; Path=/hub/canvas cookie when secure', () => {
    const c = buildCanvasCookie('sess1', true)
    expect(c).toContain('console_canvas=sess1')
    expect(c).toContain('SameSite=None')
    expect(c).toContain('Secure')
    expect(c).toContain('Path=/hub/canvas')
    expect(c).toContain('HttpOnly')
  })

  it('returns null over plain HTTP (SameSite=None requires Secure)', () => {
    expect(buildCanvasCookie('sess1', false)).toBeNull()
  })

  it('clear cookie expires it on the same path', () => {
    const c = buildClearCanvasCookie(true)
    expect(c).toContain('console_canvas=;')
    expect(c).toContain('Max-Age=0')
    expect(c).toContain('Path=/hub/canvas')
  })
})
