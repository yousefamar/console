import { describe, it, expect } from 'vitest'
import { classifyMaxLogin, maxLoginArgs, maxLoginEnv, PROBE_MODEL } from '../max-login.js'

const ok = JSON.stringify({ type: 'result', is_error: false, result: 'OK' })

describe('classifyMaxLogin', () => {
  it('OK from a clean exit is a working login', () => {
    expect(classifyMaxLogin(0, ok, '')).toEqual({ ok: true })
  })

  it('the 7 Oct failure reads as an auth failure', () => {
    const body = JSON.stringify({ is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' })
    const r = classifyMaxLogin(1, body, '')
    expect(r).toMatchObject({ ok: false, auth: true })
    expect(!r.ok && r.detail).toContain('OAuth session expired')
  })

  it('a rate limit is a failure but not an auth one', () => {
    const r = classifyMaxLogin(1, JSON.stringify({ is_error: true, result: 'API Error: usage limit reached' }), '')
    expect(r).toMatchObject({ ok: false, auth: false })
  })

  it('is_error wins over a zero exit, and non-JSON output is a failure', () => {
    expect(classifyMaxLogin(0, JSON.stringify({ is_error: true, result: 'OK' }), '').ok).toBe(false)
    expect(classifyMaxLogin(0, 'not json', 'Invalid API key · Please run /login').ok).toBe(false)
    expect(classifyMaxLogin(0, 'not json', 'Invalid API key · Please run /login')).toMatchObject({ auth: true })
  })
})

describe('the probe is first-party on the real login', () => {
  it('forces first-party through --settings, which outranks settings.json', () => {
    const args = maxLoginArgs()
    const s = JSON.parse(args[args.indexOf('--settings') + 1]!) as { env: Record<string, string> }
    expect(s.env.CLAUDE_CODE_USE_BEDROCK).toBe('0')
    // A bare id 400s on Bedrock, so an answer proves the subscription served it.
    expect(args[args.indexOf('--model') + 1]).toBe(PROBE_MODEL)
    expect(PROBE_MODEL.startsWith('us.anthropic.')).toBe(false)
  })

  it('keeps the real config dir and drops API keys and hub session wiring', () => {
    const env = maxLoginEnv({
      CLAUDE_CONFIG_DIR: '/home/amar/.claude', HOME: '/home/amar', PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't',
      CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CODE_CHILD_SESSION: '1',
    })
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/amar/.claude')
    expect(env.HOME).toBe('/home/amar')
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_CHILD_SESSION']) {
      expect(env[k]).toBeUndefined()
    }
  })
})
