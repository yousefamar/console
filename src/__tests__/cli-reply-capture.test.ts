// cli/src/reply-capture.ts — which broadcast messages are the reply to `con agent chat --id`.
import { describe, it, expect } from 'vitest'
import { ReplyCapture } from '../../cli/src/reply-capture'

const S = 'session_69'

describe('con agent chat --id reply capture', () => {
  it('a late replay of the previous turn is not the reply', () => {
    // 10 Oct 2026: the old "ready" + result arrived after the send and ended the capture.
    const c = new ReplyCapture(S, 5)
    expect(c.take({ type: 'text', sessionId: S, content: 'ready', absIndex: 3 })).toBe(false)
    expect(c.take({ type: 'result', sessionId: S, absIndex: 4 })).toBe(false)
    expect(c.take({ type: 'user_prompt', sessionId: S, content: 'say forge-ready', absIndex: 5 })).toBe(false)
    expect(c.take({ type: 'text_delta', sessionId: S, content: 'forge-' })).toBe(false)
    expect(c.take({ type: 'text', sessionId: S, content: 'forge-ready', absIndex: 7 })).toBe(false)
    expect(c.take({ type: 'result', sessionId: S, absIndex: 8 })).toBe(true)
    expect(c.reply).toBe('forge-ready')
  })

  it('other sessions are ignored, and deltas stand in when no text was logged', () => {
    const c = new ReplyCapture(S, 0)
    expect(c.take({ type: 'result', sessionId: 'other', absIndex: 99 })).toBe(false)
    c.take({ type: 'text_delta', sessionId: S, content: 'part ' })
    c.take({ type: 'text_delta', sessionId: S, content: 'two' })
    expect(c.take({ type: 'session_ended', sessionId: S })).toBe(true)
    expect(c.reply).toBe('part two')
  })
})
