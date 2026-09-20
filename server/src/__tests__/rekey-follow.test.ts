// A live session that gets a NEW claudeSessionId (`con agent reload Al`, the
// pruned-transcript fresh respawn) drags everything keyed by the old csid with
// it: hub crons/listeners (reassignCron, since 3360883c) AND its live forks'
// parentClaudeSessionId (^plum-dove — three al-* ticket forks were left
// pointing at a dead id after one reload, so their wind-down digests would
// have folded into nothing).

import { describe, it, expect, vi } from 'vitest'

vi.mock('../manifest.js', async (o) => ({ ...(await o<typeof import('../manifest.js')>()), saveManifest: () => {} }))

vi.mock('../session.js', () => {
  let idc = 0
  class StubSession {
    listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
    id = `session_stub_${++idc}`
    status = 'idle'
    cwd: string; name?: string; claudeSessionId?: string; parentClaudeSessionId?: string
    constructor(opts: { cwd: string; name?: string; parentClaudeSessionId?: string }) {
      this.cwd = opts.cwd; this.name = opts.name; this.parentClaudeSessionId = opts.parentClaudeSessionId
    }
    on(ev: string, fn: (...a: unknown[]) => void) { (this.listeners[ev] ||= []).push(fn); return this }
    off(ev: string, fn: (...a: unknown[]) => void) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn); return this }
    emit(ev: string, ...a: unknown[]) { (this.listeners[ev] || []).forEach((f) => f(...a)); return true }
    sendMessage() {}
    logMessage() {}
    kill() {}
    startTodoWatch() {}
    getInfo() { return { id: this.id, status: this.status, parentClaudeSessionId: this.parentClaudeSessionId } }
  }
  return { Session: StubSession }
})

import { createSession, followRekey, type AgentContext } from '../routes/agents.js'

type Stub = { id: string; claudeSessionId?: string; parentClaudeSessionId?: string; emit: (ev: string, ...a: unknown[]) => void }

function ctxOf(sessions: Map<string, unknown>, reassignCron = vi.fn(() => 0)) {
  const sent: unknown[] = []
  const client = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) }
  const ctx = { sessions, clients: new Set([client]), cwd: '/tmp', log: () => {}, truncate: (s: string) => s, modelConfig: {}, reassignCron } as unknown as AgentContext
  return { ctx, sent, reassignCron }
}

function stub(sessions: Map<string, unknown>, ctx: AgentContext, init: Partial<Stub> & { name?: string }): Stub {
  const s = createSession(ctx, { prompt: 'go', cwd: '/tmp', name: init.name, parentClaudeSessionId: init.parentClaudeSessionId }) as unknown as Stub
  if (init.claudeSessionId) s.claudeSessionId = init.claudeSessionId
  return s
}

describe('followRekey', () => {
  it('re-parents every fork of the old csid onto the new one and re-keys crons', () => {
    const sessions = new Map<string, unknown>()
    const { ctx, sent, reassignCron } = ctxOf(sessions, vi.fn(() => 2))
    const al = stub(sessions, ctx, { name: 'AL', claudeSessionId: 'al-new' })
    const f1 = stub(sessions, ctx, { name: 'Gold hawk', claudeSessionId: 'f1', parentClaudeSessionId: 'al-old' })
    const f2 = stub(sessions, ctx, { name: 'Keen ant', claudeSessionId: 'f2', parentClaudeSessionId: 'al-old' })
    const other = stub(sessions, ctx, { name: 'Console (fork)', claudeSessionId: 'o1', parentClaudeSessionId: 'console-main' })
    const grandchild = stub(sessions, ctx, { name: 'Gold hawk (fork)', claudeSessionId: 'g1', parentClaudeSessionId: 'f1' })

    const moved = followRekey(ctx, 'al-old', 'al-new', 'AL')

    expect(moved).toEqual({ crons: 2, forks: 2 })
    expect(reassignCron).toHaveBeenCalledWith('al-old', 'al-new')
    expect(f1.parentClaudeSessionId).toBe('al-new')
    expect(f2.parentClaudeSessionId).toBe('al-new')
    expect(other.parentClaudeSessionId).toBe('console-main')
    expect(grandchild.parentClaudeSessionId).toBe('f1') // only DIRECT children re-home; lineage below them is intact
    expect(al.parentClaudeSessionId).toBeUndefined()
    // Clients learn the new tree.
    expect(sent.some((m) => (m as { type: string }).type === 'sessions_list')).toBe(true)
  })

  it('is a no-op (no broadcast) when nothing was keyed by the old csid', () => {
    const sessions = new Map<string, unknown>()
    const { ctx, sent } = ctxOf(sessions)
    stub(sessions, ctx, { name: 'Loner', claudeSessionId: 'x', parentClaudeSessionId: 'someone-else' })
    expect(followRekey(ctx, 'nobody', 'new', 'S')).toEqual({ crons: 0, forks: 0 })
    expect(sent.filter((m) => (m as { type: string }).type === 'sessions_list')).toHaveLength(0)
  })

  it('a session_init carrying rekeyedFrom (pruned-transcript respawn) re-parents its forks through createSession', () => {
    const sessions = new Map<string, unknown>()
    const { ctx, reassignCron } = ctxOf(sessions)
    const parent = stub(sessions, ctx, { name: 'Console general', claudeSessionId: 'p-old' })
    const fork = stub(sessions, ctx, { name: 'Console general (fork)', claudeSessionId: 'f', parentClaudeSessionId: 'p-old' })

    parent.claudeSessionId = 'p-new'
    parent.emit('hub_message', { type: 'session_init', sessionId: parent.id, claudeSessionId: 'p-new', rekeyedFrom: 'p-old', model: 'm', slashCommands: [], contextWindow: 1 })

    expect(fork.parentClaudeSessionId).toBe('p-new')
    expect(reassignCron).toHaveBeenCalledWith('p-old', 'p-new')
  })
})
