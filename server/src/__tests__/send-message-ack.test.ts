// `send_message` over the hub WS must answer the SENDER: `message_sent` when a
// live session took the prompt, `hub_error` otherwise — naming the successor
// when the id is merely from before a hub restart. Before this, an unknown id
// got a hub_error the CLI never read, and `con agent send` printed sent:true
// while the message evaporated (AL → CEO, 15 Sep 2026).

import { describe, it, expect, vi } from 'vitest'
import type { WebSocket } from 'ws'

vi.mock('../manifest.js', async (o) => ({ ...(await o<typeof import('../manifest.js')>()), saveManifest: () => {} }))
vi.mock('../read-state.js', () => ({
  getLastReadIndex: () => 0, setLastReadIndex: () => {}, pinRead: () => {}, unpinRead: () => false, isReadPinned: () => false,
}))

import { handleClientMessage, type AgentContext } from '../routes/agents.js'
import type { Session } from '../session.js'

function fakeSession(over: Record<string, unknown>) {
  const sent: string[] = []
  return {
    formerIds: [], status: 'idle', messageLogLength: 0, needsAttention: null, pendingApprovalRequest: undefined,
    sent,
    sendMessage(c: string) { sent.push(c) },
    logMessage() {}, hasSeenDedupeKey: () => false, cancelTransientResume() {},
    ...over,
  } as unknown as Session & { sent: string[] }
}

function fakeWs() {
  const out: Array<Record<string, unknown>> = []
  const ws = { readyState: 1, send: (d: string) => { out.push(JSON.parse(d)) } } as unknown as WebSocket
  return { ws, out }
}

function ctxOf(...ss: Session[]): AgentContext {
  return {
    sessions: new Map(ss.map((s) => [s.id, s])), clients: new Set(), cwd: '/tmp', log: () => {}, truncate: (s: string) => s, modelConfig: {},
  } as unknown as AgentContext
}

const ceo = fakeSession({ id: 'session_15_1789460773338', claudeSessionId: 'csid-ceo', name: 'CEO', agentKey: 'ceo', formerIds: ['session_15_1789152050911'] })

describe('send_message replies to the sender', () => {
  it('acks a delivered prompt with message_sent', () => {
    const { ws, out } = fakeWs()
    handleClientMessage(ctxOf(ceo), ws, { type: 'send_message', sessionId: ceo.id, content: 'hello' })
    expect(ceo.sent).toEqual(['hello'])
    expect(out).toContainEqual({ type: 'message_sent', sessionId: ceo.id })
  })

  it('answers a pre-restart id with hub_error naming the successor, delivering nothing', () => {
    const { ws, out } = fakeWs()
    const target = fakeSession({ ...ceo, sent: [] })
    handleClientMessage(ctxOf(target), ws, { type: 'send_message', sessionId: 'session_15_1789152050911', content: 'hello' })
    expect(target.sent).toEqual([])
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('hub_error')
    expect(out[0]!.message).toContain('Session not found: session_15_1789152050911')
    expect(out[0]!.message).toContain('session_15_1789460773338 (CEO)')
    expect(out[0]!.message).toContain('"ceo"')
  })

  it('answers a never-seen id with a plain hub_error', () => {
    const { ws, out } = fakeWs()
    handleClientMessage(ctxOf(ceo), ws, { type: 'send_message', sessionId: 'session_99_1', content: 'hello' })
    expect(out).toEqual([{ type: 'hub_error', message: 'Session not found: session_99_1' }])
  })

  it('acks a deduplicated redelivery too (the prompt already landed)', () => {
    const { ws, out } = fakeWs()
    const s = fakeSession({ id: 'session_2_2', claudeSessionId: 'csid-2', hasSeenDedupeKey: () => true })
    handleClientMessage(ctxOf(s), ws, { type: 'send_message', sessionId: s.id, content: 'again', dedupeKey: 'k1' })
    expect(s.sent).toEqual([])
    expect(out).toEqual([{ type: 'message_sent', sessionId: s.id }])
  })
})
