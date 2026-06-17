// Integration tests for the delegation/merge ORCHESTRATION (the stateful flows
// that were previously only live-verified): delegateTask, reportTask, mergeFork,
// runTaskWatchdog. Driven with a stubbed AgentContext — fake sessions (event
// emitters that record injected messages) + a stub registry + a real TaskStore.
//
// saveManifest writes to the REAL hub manifest; override it so tests can't
// clobber the running hub's session list.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../manifest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../manifest.js')>()),
  saveManifest: () => {},
}))

import { delegateTask, reportTask, mergeFork, runTaskWatchdog, type AgentContext } from '../routes/agents.js'
import { TaskStore } from '../agents/tasks.js'

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

let dir: string
let tasks: TaskStore
function ctxOf(sessions: Map<string, TestSession>, reg: ReturnType<typeof stubRegistry>): AgentContext {
  return { sessions, clients: new Set(), cwd: '/tmp', log: () => {}, truncate: (s: string) => s, tasks, agentRegistry: reg, modelConfig: {} } as unknown as AgentContext
}

// Fixed clock → task timestamps are a small constant, so the watchdog's real
// `Date.now() - updatedAt` is reliably huge (deterministic staleness).
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orch-')); tasks = new TaskStore(join(dir, 't.json'), () => 1_000_000) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('delegateTask', () => {
  it('creates a task and injects the envelope into the assignee\'s live session', () => {
    const reg = stubRegistry([role('al'), role('eng', 'al')])
    const eng = new TestSession('s-eng', { agentKey: 'eng', claudeSessionId: 'c-eng', name: 'eng' })
    const ctx = ctxOf(new Map([['s-eng', eng]]), reg)
    const res = delegateTask(ctx, { fromKey: 'al', toKey: 'eng', brief: 'do the thing' })
    expect(res.task?.toKey).toBe('eng')
    expect(tasks.open()).toHaveLength(1)
    expect(eng.sent).toHaveLength(1)
    expect(eng.sent[0]).toContain('[DELEGATED TASK')
    expect(eng.sent[0]).toContain('do the thing')
  })

  it('rejects a cycle (assignee already upstream)', () => {
    const reg = stubRegistry([role('al'), role('eng', 'al')])
    const eng = new TestSession('s-eng', { agentKey: 'eng', claudeSessionId: 'c-eng' })
    const ctx = ctxOf(new Map([['s-eng', eng]]), reg)
    const parent = tasks.create({ title: 'p', brief: 'p', fromKey: 'al', toKey: 'eng', origin: 'human', parentTaskId: null, chain: ['al', 'eng'] })
    const res = delegateTask(ctx, { fromKey: 'eng', toKey: 'al', brief: 'x', parentTaskId: parent.id })
    expect(res.error).toMatch(/cycle/i)
  })

  it('lists the assignee\'s reports + the re-delegate mandate when the assignee is a manager', () => {
    const reg = stubRegistry([role('al'), role('cg', 'al'), role('at', 'cg')])
    const cg = new TestSession('s-cg', { agentKey: 'cg', claudeSessionId: 'c-cg' })
    const ctx = ctxOf(new Map([['s-cg', cg]]), reg)
    delegateTask(ctx, { fromKey: 'al', toKey: 'cg', brief: 'route to at' })
    expect(cg.sent[0]).toContain('You manage')
    expect(cg.sent[0]).toContain('`at`')
    expect(cg.sent[0]).toContain('MUST re-delegate')
  })
})

describe('reportTask', () => {
  it('routes the result to the delegator and tears down an ephemeral worker', () => {
    const reg = stubRegistry([role('al'), role('eng', 'al')])
    const al = new TestSession('s-al', { agentKey: 'al', claudeSessionId: 'c-al' })
    const worker = new TestSession('s-w', {})
    const ctx = ctxOf(new Map([['s-al', al], ['s-w', worker]]), reg)
    const t = tasks.create({ title: 't', brief: 'b', fromKey: 'al', toKey: 'eng', origin: 'human', parentTaskId: null, chain: ['al', 'eng'], ephemeral: true, workerSessionId: 's-w' })
    const res = reportTask(ctx, t.id, 'done it', 'done')
    expect(res.ok).toBe(true)
    expect(tasks.get(t.id)!.status).toBe('done')
    expect(al.sent[0]).toContain('[REPORT')
    expect(al.sent[0]).toContain('done it')
    expect(worker.killed).toBe(true)
    expect(ctx.sessions.has('s-w')).toBe(false)
  })

  it('errors on an unknown task', () => {
    const ctx = ctxOf(new Map(), stubRegistry([]))
    expect(reportTask(ctx, 'nope', 'x').ok).toBe(false)
  })
})

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

describe('runTaskWatchdog', () => {
  it('nudges a stalled in-progress task', () => {
    const reg = stubRegistry([role('al'), role('eng', 'al')])
    const al = new TestSession('s-al', { agentKey: 'al', claudeSessionId: 'c-al' })
    const worker = new TestSession('s-w', { agentKey: 'eng', claudeSessionId: 'c-w' })
    const ctx = ctxOf(new Map([['s-al', al], ['s-w', worker]]), reg)
    const t = tasks.create({ title: 't', brief: 'b', fromKey: 'al', toKey: 'eng', origin: 'human', parentTaskId: null, chain: ['al', 'eng'], workerSessionId: 's-w' })
    runTaskWatchdog(ctx, 1, 2) // staleMs=1; fixed-clock updatedAt makes it stale
    expect(worker.sent.some((s) => s.includes('REMINDER'))).toBe(true)
    expect(tasks.get(t.id)!.nudges).toBe(1)
  })

  it('blocks + bubbles a stall report after maxNudges', () => {
    const reg = stubRegistry([role('al'), role('eng', 'al')])
    const al = new TestSession('s-al', { agentKey: 'al', claudeSessionId: 'c-al' })
    const worker = new TestSession('s-w', { agentKey: 'eng', claudeSessionId: 'c-w' })
    const ctx = ctxOf(new Map([['s-al', al], ['s-w', worker]]), reg)
    const t = tasks.create({ title: 't', brief: 'b', fromKey: 'al', toKey: 'eng', origin: 'human', parentTaskId: null, chain: ['al', 'eng'], workerSessionId: 's-w' })
    tasks.update(t.id, { nudges: 2 })
    runTaskWatchdog(ctx, 1, 2)
    expect(tasks.get(t.id)!.status).toBe('blocked')
    expect(al.sent.some((s) => s.includes('[REPORT'))).toBe(true) // stall bubbled to the delegator
  })
})
