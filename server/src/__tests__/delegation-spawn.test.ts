// Covers the spawn injection path: a keyed session's system prompt gets the
// board protocol + its @key identity (and a project-board pointer when the
// project has a board). Charters/memory are deliberately NOT injected — they
// live in the project's CLAUDE.md / Claude Code's auto-memory.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../manifest.js', async (o) => ({ ...(await o<typeof import('../manifest.js')>()), saveManifest: () => {} }))

// Self-contained stub (defined inside the factory — vi.mock is hoisted above
// module code). Records constructor options so tests can read the injected prompt.
vi.mock('../session.js', () => {
  let idc = 0
  class StubSession {
    listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
    id = `session_stub_${++idc}`
    status = 'idle'
    sent: string[] = []
    killed = false
    cwd: string; agentKey?: string; name?: string; parentClaudeSessionId?: string
    systemPrompt?: string; initialPrompt: string
    constructor(opts: { cwd: string; agentKey?: string; name?: string; parentClaudeSessionId?: string; systemPrompt?: string; prompt: string }) {
      this.cwd = opts.cwd; this.agentKey = opts.agentKey; this.name = opts.name
      this.parentClaudeSessionId = opts.parentClaudeSessionId; this.systemPrompt = opts.systemPrompt; this.initialPrompt = opts.prompt
    }
    on(ev: string, fn: (...a: unknown[]) => void) { (this.listeners[ev] ||= []).push(fn); return this }
    off(ev: string, fn: (...a: unknown[]) => void) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn); return this }
    emit(ev: string, ...a: unknown[]) { (this.listeners[ev] || []).forEach((f) => f(...a)); return true }
    sendMessage(c: string) { this.sent.push(c) }
    logMessage() {}
    kill() { this.killed = true }
    startTodoWatch() {}
    getInfo() { return { id: this.id, status: this.status } }
  }
  return { Session: StubSession }
})

import { createSession, mintAgentKey, forkRoleSessionForTicket, wakeForkCompacted, type AgentContext } from '../routes/agents.js'
import { buildForkCompactPrompt } from '../kanban/dispatch.js'

function ctxOf(sessions: Map<string, unknown>): AgentContext {
  return { sessions, clients: new Set(), cwd: '/tmp', log: () => {}, truncate: (s: string) => s, modelConfig: {} } as unknown as AgentContext
}

describe('createSession prompt injection (fresh keyed spawn)', () => {
  it('keyed spawn gets board protocol + @key identity; no charter injection', () => {
    const ctx = ctxOf(new Map())
    const s = createSession(ctx, { prompt: 'go', cwd: '/tmp', agentKey: 'eng' }) as unknown as { systemPrompt: string }
    expect(s.systemPrompt).toContain('Work boards (kanban)')  // board-protocol preamble
    expect(s.systemPrompt).toContain('`eng`')                 // self-identity @key
    expect(ctx.sessions.size).toBe(1)
  })

  it('key-less spawn gets no injected prompt', () => {
    const ctx = ctxOf(new Map())
    const s = createSession(ctx, { prompt: 'go', cwd: '/tmp' }) as unknown as { systemPrompt?: string }
    expect(s.systemPrompt).toBeUndefined()
  })

  it('caller-supplied systemPrompt (Al) is kept, identity appended', () => {
    const ctx = ctxOf(new Map())
    const s = createSession(ctx, { prompt: 'go', cwd: '/tmp', agentKey: 'al', systemPrompt: 'AL PERSONA' }) as unknown as { systemPrompt: string }
    expect(s.systemPrompt).toContain('AL PERSONA')
    expect(s.systemPrompt).toContain('`al`')
    expect(s.systemPrompt).not.toContain('Work boards (kanban)') // Al's persona already includes it
  })
})

describe('mintAgentKey', () => {
  it('slugs and collision-suffixes against live sessions', () => {
    const sessions = new Map<string, unknown>()
    const ctx = ctxOf(sessions)
    expect(mintAgentKey(ctx, 'Feeds Tab')).toBe('feeds-tab')
    sessions.set('a', { agentKey: 'feeds-tab', status: 'idle' })
    expect(mintAgentKey(ctx, 'Feeds Tab')).toBe('feeds-tab-1')
  })
})

describe('forkRoleSessionForTicket key shape', () => {
  it('prefixes the fork key with the SOURCE KEY, not its name — rootOf()/reopen peel `-<id>-fork` and expect the key', () => {
    const sessions = new Map<string, unknown>()
    const ctx = ctxOf(sessions)
    const source = { id: 'src', name: 'Console mobile', agentKey: 'new-mobile-app', claudeSessionId: 'c1', cwd: '/tmp', status: 'idle' }
    sessions.set('src', source)
    const fork = forkRoleSessionForTicket(ctx, source as never, 'kind-pony') as unknown as { agentKey: string; name: string }
    expect(fork.agentKey).toBe('new-mobile-app-kind-pony-fork')
    expect(fork.name).toBe('Kind pony (fork)')
  })
})

describe('wakeForkCompacted', () => {
  it('sends /compact first and queues the envelope + images behind it', () => {
    const sessions = new Map<string, unknown>()
    const ctx = ctxOf(sessions)
    const source = { id: 'src', name: 'Console general', agentKey: 'console-general', claudeSessionId: 'c1', cwd: '/tmp', status: 'idle' }
    sessions.set('src', source)
    const fork = forkRoleSessionForTicket(ctx, source as never, 'brisk-wolf') as unknown as {
      sent: string[]; queued: Array<[string, unknown[] | undefined]>; status: string
      queueMessage: (c: string, i?: unknown[]) => void
    }
    // The stub's queueMessage records instead of flushing.
    fork.queued = []
    fork.queueMessage = (c, i) => { fork.queued.push([c, i]) }
    wakeForkCompacted(ctx, fork as never, '[BOARD TASK] the card', [{ media_type: 'image/png', data: 'AAAA' }] as never)
    expect(fork.sent).toHaveLength(1)
    expect(fork.sent[0]).toBe(buildForkCompactPrompt())
    expect(fork.sent[0]!.startsWith('/compact ')).toBe(true)
    expect(fork.queued).toEqual([['[BOARD TASK] the card', [{ media_type: 'image/png', data: 'AAAA' }]]])
  })
})
