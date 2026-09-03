// ^gold-hare (opsec rem #63): the Atoms voice callbacks must pass the hub's
// auth wall, not bypass it. /voice/delegate was an unauthenticated write
// primitive into Al's live session for ~86 days because the exemption list
// claimed a signature check that nothing implemented.
import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { decide, isAlwaysOpenPath } from '../auth-middleware.js'
import type { AuthStore, HubToken } from '../auth-store.js'
import { voiceCallbackHeaders, webhooksNeedingAuth, isSafeCallId, normalisePhone } from '../al/voice.js'

const VOICE_TOKEN = 'voice-plaintext-secret'

function fakeStore(): AuthStore {
  return {
    validateHubToken: (plaintext: string): HubToken | null =>
      plaintext === VOICE_TOKEN
        ? ({ id: 'v1', name: 'atoms-voice', scope: 'voice', hash: 'x', createdAt: 0 } as unknown as HubToken)
        : null,
    findHubSession: () => undefined,
  } as unknown as AuthStore
}

function req(opts: { url: string; method: string; bearer?: string }): IncomingMessage {
  const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.9' } // via Caddy, never loopback
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  return {
    url: opts.url,
    method: opts.method,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

describe('voice callbacks are gated, not exempt', () => {
  it('only /voice/health stays always-open', () => {
    expect(isAlwaysOpenPath('/voice/health', 'GET')).toBe(true)
    expect(isAlwaysOpenPath('/voice/delegate', 'POST')).toBe(false)
    expect(isAlwaysOpenPath('/voice/delegate', 'GET')).toBe(false)
    expect(isAlwaysOpenPath('/voice/webhook', 'POST')).toBe(false)
  })

  it('delegate with the voice bearer is allowed as a bearer principal', () => {
    const d = decide(req({ url: '/voice/delegate', method: 'POST', bearer: VOICE_TOKEN }), fakeStore())
    expect(d.allow).toBe(true)
    expect(d.reason).toBe('bearer')
    expect(d.principal?.kind).toBe('bearer')
  })

  it('delegate without a bearer is refused (the rem #63 shape, incl. the ?request= GET form)', () => {
    expect(decide(req({ url: '/voice/delegate', method: 'POST' }), fakeStore()).allow).toBe(false)
    expect(decide(req({ url: '/voice/delegate?request=hi', method: 'GET' }), fakeStore()).allow).toBe(false)
    expect(decide(req({ url: '/voice/webhook', method: 'POST' }), fakeStore()).allow).toBe(false)
  })

  it('a wrong bearer is refused', () => {
    const d = decide(req({ url: '/voice/delegate', method: 'POST', bearer: 'nope' }), fakeStore())
    expect(d.allow).toBe(false)
    expect(d.reason).toBe('bearer-invalid')
  })
})

describe('what the hub installs on the Atoms side', () => {
  it('tool/webhook headers carry the bearer when a token exists, and fail closed without one', () => {
    expect(voiceCallbackHeaders('tok')).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer tok' })
    expect(voiceCallbackHeaders(null)).toEqual({ 'Content-Type': 'application/json' })
  })

  it('webhooksNeedingAuth picks our webhook record only when its header is missing or stale', () => {
    const ours = { _id: 'a', url: 'https://al.amar.io/voice/webhook' }
    const current = { _id: 'b', url: 'https://al.amar.io/voice/webhook', headers: { Authorization: 'Bearer tok' } }
    const stale = { _id: 'c', url: 'https://al.amar.io/voice/webhook', headers: { authorization: 'Bearer old' } }
    const other = { _id: 'd', url: 'https://example.com/hook' }
    const noId = { url: 'https://al.amar.io/voice/webhook' }
    expect(webhooksNeedingAuth([ours, current, stale, other, noId], 'tok')).toEqual(['a', 'c'])
  })
})

describe('caller-supplied values that reach the filesystem or the envelope', () => {
  it('normalisePhone accepts phone shapes and drops everything else', () => {
    expect(normalisePhone('+447776912442')).toBe('+447776912442')
    expect(normalisePhone('+44 7776 912-442')).toBe('+447776912442')
    expect(normalisePhone('0118 (966) 1234')).toBe('01189661234')
    expect(normalisePhone('alice@example.com')).toBe('')
    expect(normalisePhone('../../etc/passwd')).toBe('')
    expect(normalisePhone('12345')).toBe('')
    expect(normalisePhone(447776912442)).toBe('')
    expect(normalisePhone(undefined)).toBe('')
  })

  it('isSafeCallId refuses anything path-shaped', () => {
    expect(isSafeCallId('69d2ed523fa8bf28a792530f')).toBe(true)
    expect(isSafeCallId('call_ABC-123')).toBe(true)
    expect(isSafeCallId('../../x')).toBe(false)
    expect(isSafeCallId('a/b')).toBe(false)
    expect(isSafeCallId('')).toBe(false)
    expect(isSafeCallId(undefined)).toBe(false)
  })
})
