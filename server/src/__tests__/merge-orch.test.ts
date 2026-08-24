// Integration tests for the merge ORCHESTRATION (the stateful flow that was
// previously only live-verified): mergeFork. Driven with a stubbed
// AgentContext — fake sessions (event emitters that record injected messages)
// + a stub registry.
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

interface RoleLite { key: string; title: string; manager: string | null; charter: string; folder: boolean; cwd: string | null }
function role(key: string, manager: string | null = null, folder = false): RoleLite {
  return { key, title: key, manager, charter: `${key} charter sentence. More detail.`, folder, cwd: '/tmp' }
}
function stubRegistry(roles: RoleLite[]) {
  const m = new Map(roles.map((r) => [r.key, r]))
  return {
    get: (k: string) => m.get(k),
    has: (k: string) => m.has(k),
    list: () => [...m.values()],
    resolveCharter: (k: string) => { const r = m.get(k); return r && !r.folder ? r.charter : null },
    tree: () => [],
    mintKey: (t: string) => t.toLowerCase().replace(/\s+/g, '-'),
    create: (k: string, init: { manager?: string | null; folder?: boolean }) => { const r = role(k, init.manager ?? null, !!init.folder); m.set(k, r); return r },
    setManager: () => {},
    delete: (k: string) => m.delete(k),
    workingManager: (k: string) => {
      let mgr = m.get(k)?.manager ?? null
      const seen = new Set<string>()
      while (mgr && !seen.has(mgr)) {
        const r = m.get(mgr)
        if (!r || !r.folder) return mgr
        seen.add(mgr)
        mgr = r.manager ?? null
      }
      return null
    },
  }
}

class TestSession extends EventEmitter {
  sent: string[] = []
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
  kill() { this.killed = true }
  getInfo() { return { id: this.id, status: this.status, agentKey: this.agentKey, name: this.name } }
}

function ctxOf(sessions: Map<string, TestSession>, reg: ReturnType<typeof stubRegistry>): AgentContext {
  return { sessions, clients: new Set(), cwd: '/tmp', log: () => {}, truncate: (s: string) => s, agentRegistry: reg, modelConfig: {} } as unknown as AgentContext
}

describe('mergeFork', () => {
  it('captures the fork summary, injects it into the parent, kills the fork', async () => {
    const parent = new TestSession('s-p', { claudeSessionId: 'c-p', name: 'Parent' })
    const fork = new TestSession('s-f', { claudeSessionId: 'c-f', name: 'Parent (fork)', parentClaudeSessionId: 'c-p', reply: 'I learned X and did Y.' })
    const ctx = ctxOf(new Map([['s-p', parent], ['s-f', fork]]), stubRegistry([]))
    const res = await mergeFork(ctx, 's-f', 2000)
    expect(res.ok).toBe(true)
    expect(res.summary).toContain('learned X')
    expect(parent.sent.some((s) => s.includes('[MERGE') && s.includes('learned X'))).toBe(true)
    expect(fork.killed).toBe(true)
    expect(ctx.sessions.has('s-f')).toBe(false)
  })

  it('refuses a non-fork (no parent)', async () => {
    const p = new TestSession('s-p', { claudeSessionId: 'c-p' })
    const res = await mergeFork(ctxOf(new Map([['s-p', p]]), stubRegistry([])), 's-p', 300)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not a fork/i)
  })

  it('refuses a busy fork', async () => {
    const parent = new TestSession('s-p', { claudeSessionId: 'c-p' })
    const fork = new TestSession('s-f', { claudeSessionId: 'c-f', parentClaudeSessionId: 'c-p', status: 'running' })
    const res = await mergeFork(ctxOf(new Map([['s-p', parent], ['s-f', fork]]), stubRegistry([])), 's-f', 300)
    expect(res.error).toMatch(/busy/i)
  })

  it('org child with a FOLDER manager merges into the folder\'s own manager, never the folder', async () => {
    // worker → folder "life-admin" → real manager "al". The Sainsburys loss:
    // merging revived the folder as a charterless session that ate the digest.
    const reg = stubRegistry([role('al'), role('life-admin', 'al', true), role('worker', 'life-admin')])
    const grandparent = new TestSession('s-al', { claudeSessionId: 'c-al', agentKey: 'al', name: 'Al' })
    const child = new TestSession('s-w', { claudeSessionId: 'c-w', agentKey: 'worker', name: 'Worker', reply: 'grocery order 123 placed.' })
    const ctx = ctxOf(new Map([['s-al', grandparent], ['s-w', child]]), reg)
    const res = await mergeFork(ctx, 's-w', 2000)
    expect(res.ok).toBe(true)
    expect(res.parentId).toBe('s-al')
    expect(grandparent.sent.some((s) => s.includes('grocery order 123'))).toBe(true)
  })

  it('org child whose chain ends at a root folder refuses cleanly', async () => {
    const reg = stubRegistry([role('lonely-folder', null, true), role('worker', 'lonely-folder')])
    const child = new TestSession('s-w', { claudeSessionId: 'c-w', agentKey: 'worker', reply: 'x' })
    const res = await mergeFork(ctxOf(new Map([['s-w', child]]), reg), 's-w', 300)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/non-folder/i)
    expect(child.killed).toBe(false)
  })

  it('leaves the fork ALIVE if it produces no summary (timeout)', async () => {
    const parent = new TestSession('s-p', { claudeSessionId: 'c-p' })
    const fork = new TestSession('s-f', { claudeSessionId: 'c-f', parentClaudeSessionId: 'c-p' }) // reply=null → no turn
    const ctx = ctxOf(new Map([['s-p', parent], ['s-f', fork]]), stubRegistry([]))
    const res = await mergeFork(ctx, 's-f', 250)
    expect(res.ok).toBe(false)
    expect(fork.killed).toBe(false)
    expect(ctx.sessions.has('s-f')).toBe(true)
  })
})
