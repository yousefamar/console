// Covers the spawn path the merge tests can't (they pre-seed live sessions to
// avoid spawning): reviveAgentRole, which goes through createSession →
// `new Session(...)`. We mock Session with a recording stub, so this also
// asserts the system-prompt INJECTION wiring (charter + board protocol +
// org-position: roster, self-identity, manager).

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

import { reviveAgentRole, type AgentContext } from '../routes/agents.js'

function reg() {
  const roles: Record<string, { key: string; title: string; manager: string | null; charter: string; folder: boolean; cwd: string | null }> = {
    al: { key: 'al', title: 'Al', manager: null, charter: 'Al charter.', folder: false, cwd: '/tmp' },
    eng: { key: 'eng', title: 'Engineering', manager: 'al', charter: 'Owns engineering. Builds things.', folder: false, cwd: '/tmp' },
  }
  return {
    get: (k: string) => roles[k],
    has: (k: string) => k in roles,
    list: () => Object.values(roles),
    resolveCharter: (k: string) => (roles[k]?.folder ? null : roles[k]?.charter ?? null),
    tree: () => [{ role: roles.al, children: [{ role: roles.eng, children: [] }] }],
    mintKey: (t: string) => t.toLowerCase().replace(/\s+/g, '-'),
    create: () => roles.eng,
    setManager: () => {},
  }
}

function ctxOf(sessions: Map<string, unknown>): AgentContext {
  return { sessions, clients: new Set(), cwd: '/tmp', log: () => {}, truncate: (s: string) => s, agentRegistry: reg(), modelConfig: {} } as unknown as AgentContext
}

describe('createSession charter injection (fresh role spawn)', () => {
  it('reviveAgentRole spawns with charter + protocol + org-position (roster, self-identity, manager)', () => {
    const ctx = ctxOf(new Map())
    const s = reviveAgentRole(ctx, 'eng') as unknown as { systemPrompt: string }
    expect(s).toBeTruthy()
    expect(s.systemPrompt).toContain('Owns engineering')           // charter body
    expect(s.systemPrompt).toContain('Work boards (kanban)')       // board-protocol preamble
    expect(s.systemPrompt).toContain('You are:')                   // self-identity line
    expect(s.systemPrompt).toContain('Engineering (`eng`)')
    expect(s.systemPrompt).toContain('Al (`al`)')                  // full roster
    expect(s.systemPrompt).toContain('You report to:')             // manager
    expect(ctx.sessions.size).toBe(1)
  })
})
