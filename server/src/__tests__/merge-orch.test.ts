// Integration tests for the merge ORCHESTRATION (the stateful flow that was
// previously only live-verified): mergeFork. Driven with a stubbed
// AgentContext — fake sessions (event emitters that record injected messages).
// Parent resolution is FORK LINEAGE ONLY (parentClaudeSessionId) — the org
// manager-edge path died with the role registry.
//
// saveManifest writes to the REAL hub manifest; override it so tests can't
// clobber the running hub's session list.

import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('../manifest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../manifest.js')>()),
  saveManifest: () => {},
}))

import { mergeFork, type AgentContext } from '../routes/agents.js'

// --- stubs -----------------------------------------------------------------

class TestSession extends EventEmitter {
  sent: string[] = []
  queued: string[] = []
  killed = false
  status: 'running' | 'idle' | 'ended' = 'idle'
  claudeSessionId?: string
  agentKey?: string
  name?: string
  cwd = '/tmp'
  parentClaudeSessionId?: string
  /** If set, sendMessage auto-emits this as the next turn (for captureNextTurn). */
  reply: string | null = null
  constructor(public id: string, init: Partial<TestSession> = {}) { super(); Object.assign(this, init) }
  sendMessage(content: string) {
    this.sent.push(content)
    if (this.reply != null) {
      const r = this.reply
      queueMicrotask(() => {
        this.emit('hub_message', { type: 'text_delta', sessionId: this.id, content: r })
        this.emit('hub_message', { type: 'result', sessionId: this.id })
      })
    }
  }
  logMessage() {}
  queueMessage(content: string) { this.queued.push(content) }
  kill() { this.killed = true }
  getInfo() { return { id: this.id, status: this.status, agentKey: this.agentKey, name: this.name } }
}

function ctxOf(sessions: Map<string, TestSession>): AgentContext {
  return { sessions, clients: new Set(), cwd: '/tmp', log: () => {}, truncate: (s: string) => s, modelConfig: {} } as unknown as AgentContext
}

describe('mergeFork', () => {
  it('captures the fork summary, injects it into the parent, kills the fork', async () => {
    const parent = new TestSession('s-p', { claudeSessionId: 'c-p', name: 'Parent' })
    const fork = new TestSession('s-f', { claudeSessionId: 'c-f', name: 'Parent (fork)', parentClaudeSessionId: 'c-p', reply: 'I learned X and did Y.' })
    const ctx = ctxOf(new Map([['s-p', parent], ['s-f', fork]]))
    const res = await mergeFork(ctx, 's-f', 2000)
    expect(res.ok).toBe(true)
    expect(res.summary).toContain('learned X')
    expect(parent.sent.some((s) => s.includes('[MERGE') && s.includes('learned X'))).toBe(true)
    expect(fork.killed).toBe(true)
    expect(ctx.sessions.has('s-f')).toBe(false)
  })

  it("absorb: 'queue' hands the digest to the parent's queue (turn-end if busy, at once if idle) instead of steering it (^cool-newt, ^gray-koi)", async () => {
    const parent = new TestSession('s-p', { claudeSessionId: 'c-p', name: 'Parent' })
    const fork = new TestSession('s-f', { claudeSessionId: 'c-f', name: 'Parent (fork)', parentClaudeSessionId: 'c-p', reply: 'card done, worktree removed.' })
    const ctx = ctxOf(new Map([['s-p', parent], ['s-f', fork]]))
    const res = await mergeFork(ctx, 's-f', 2000, { absorb: 'queue' })
    expect(res.ok).toBe(true)
    expect(parent.sent).toEqual([]) // no stdin write behind the queue's back
    expect(parent.queued).toHaveLength(1)
    expect(parent.queued[0]).toContain('card done')
    expect(fork.killed).toBe(true)
  })

  it("re-parents the merged fork's own live forks onto the parent — grandchildren must not keep a dead csid (^plum-dove)", async () => {
    const parent = new TestSession('s-p', { claudeSessionId: 'c-p', name: 'Parent' })
    const fork = new TestSession('s-f', { claudeSessionId: 'c-f', name: 'Parent (fork)', parentClaudeSessionId: 'c-p', reply: 'done.' })
    const grandchild = new TestSession('s-g', { claudeSessionId: 'c-g', name: 'Fork (fork)', parentClaudeSessionId: 'c-f' })
    const unrelated = new TestSession('s-u', { claudeSessionId: 'c-u', name: 'Other (fork)', parentClaudeSessionId: 'c-other' })
    const ctx = ctxOf(new Map([['s-p', parent], ['s-f', fork], ['s-g', grandchild], ['s-u', unrelated]]))
    const res = await mergeFork(ctx, 's-f', 2000)
    expect(res.ok).toBe(true)
    expect(grandchild.parentClaudeSessionId).toBe('c-p')
    expect(unrelated.parentClaudeSessionId).toBe('c-other')
  })

  it('refuses a non-fork (no parent lineage)', async () => {
    const p = new TestSession('s-p', { claudeSessionId: 'c-p', agentKey: 'worker' })
    const res = await mergeFork(ctxOf(new Map([['s-p', p]])), 's-p', 300)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not a fork/i)
  })

  it('refuses a busy fork', async () => {
    const parent = new TestSession('s-p', { claudeSessionId: 'c-p' })
    const fork = new TestSession('s-f', { claudeSessionId: 'c-f', parentClaudeSessionId: 'c-p', status: 'running' })
    const res = await mergeFork(ctxOf(new Map([['s-p', parent], ['s-f', fork]])), 's-f', 300)
    expect(res.error).toMatch(/busy/i)
  })

  it('refuses when the parent session is not live', async () => {
    const fork = new TestSession('s-f', { claudeSessionId: 'c-f', parentClaudeSessionId: 'c-gone', reply: 'x' })
    const res = await mergeFork(ctxOf(new Map([['s-f', fork]])), 's-f', 300)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not live/i)
    expect(fork.killed).toBe(false)
  })

  it('leaves the fork ALIVE if it produces no summary (timeout)', async () => {
    const parent = new TestSession('s-p', { claudeSessionId: 'c-p' })
    const fork = new TestSession('s-f', { claudeSessionId: 'c-f', parentClaudeSessionId: 'c-p' }) // reply=null → no turn
    const ctx = ctxOf(new Map([['s-p', parent], ['s-f', fork]]))
    const res = await mergeFork(ctx, 's-f', 250)
    expect(res.ok).toBe(false)
    expect(fork.killed).toBe(false)
    expect(ctx.sessions.has('s-f')).toBe(true)
  })
})
