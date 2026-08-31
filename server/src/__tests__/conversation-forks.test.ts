// Conversation-fork router: owner bypass, fork-per-thread reuse, spawn-gap
// queueing, restart re-pointing, and the trivial-vs-substantive wind-down
// split. Stubbed AgentContext (merge-orch.test.ts precedent); the forks file
// is pointed at a tmp path via CONSOLE_AL_FORKS_FILE (todo-store precedent).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../manifest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../manifest.js')>()),
  saveManifest: () => {},
}))

// createSession/wakeSession/mergeIntoParent are stubbed — we test the ROUTER,
// not the spawn machinery (session.test.ts / merge-orch.test.ts own those).
const created: TestSession[] = []
const woken: Array<{ id: string; content: string }> = []
const merged: string[] = []
vi.mock('../routes/agents.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../routes/agents.js')>()),
  createSession: (_ctx: unknown, opts: { name?: string; parentClaudeSessionId?: string }) => {
    const s = new TestSession(`s-fork-${created.length}`, { name: opts.name, parentClaudeSessionId: opts.parentClaudeSessionId })
    created.push(s)
    return s
  },
  wakeSession: (_ctx: unknown, session: { id: string }, content: string) => {
    woken.push({ id: session.id, content })
  },
  mergeIntoParent: async (_ctx: unknown, childId: string) => {
    merged.push(childId)
    return { ok: true, summary: 'digest' }
  },
}))

import { routeInbound, startConversationForks, activeForks } from '../al/conversation-forks.js'
import * as alSession from '../al/al-session.js'

class TestSession extends EventEmitter {
  killed = false
  hibernated = false
  needsAttention: { ts: number; snippet: string } | null = null
  status: 'running' | 'idle' | 'ended' = 'idle'
  claudeSessionId?: string
  name?: string
  cwd = '/tmp'
  parentClaudeSessionId?: string
  constructor(public id: string, init: Partial<TestSession> = {}) { super(); Object.assign(this, init) }
  kill() { this.killed = true; this.status = 'ended' }
  hibernate() { if (this.status !== 'idle') return false; this.hibernated = true; return true }
}

function ctxOf(sessions: Map<string, TestSession>) {
  return { sessions, clients: new Set(), cwd: '/tmp', log: () => {}, truncate: (s: string) => s, modelConfig: {} } as any
}

let dir: string
let parent: TestSession

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'al-forks-test-'))
  process.env.CONSOLE_AL_FORKS_FILE = join(dir, 'forks.json')
  created.length = 0; woken.length = 0; merged.length = 0
  parent = new TestSession('s-al', { claudeSessionId: 'c-al', name: 'Al' })
  vi.spyOn(alSession, 'getAlSession').mockReturnValue(parent as any)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.CONSOLE_AL_FORKS_FILE
  rmSync(dir, { recursive: true, force: true })
})

describe('routeInbound', () => {
  it('owner (yousef) never forks — routes to parent', () => {
    const ctx = ctxOf(new Map([['s-al', parent]]))
    startConversationForks(ctx)
    const handled = routeInbound(ctx, '447845443890@lid', 'yousef', 'Yousef', '[envelope]')
    expect(handled).toBe(false)
    expect(created.length).toBe(0)
  })

  it('non-owner thread forks once and reuses the fork for later messages', () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)
    expect(routeInbound(ctx, '491629386217@s.whatsapp.net', 'mai', 'Mai', '[env 1]')).toBe(true)
    expect(created.length).toBe(1)
    const fork = created[0]!
    expect(fork.name).toBe('Al ↔ Mai')
    // seed + first envelope went out immediately (the --fork-session no-init gotcha)
    expect(woken[0]!.id).toBe(fork.id)
    expect(woken[0]!.content).toContain('[CONVERSATION FORK]')
    expect(woken[0]!.content).toContain('[env 1]')

    // fork announces its claudeSessionId → routing table persists it
    ctx.sessions.set(fork.id, fork)
    fork.emit('hub_message', { type: 'session_init', claudeSessionId: 'c-fork-0' })
    expect(activeForks()[0]!.claudeSessionId).toBe('c-fork-0')

    // second message: no new fork, same target
    expect(routeInbound(ctx, '491629386217@s.whatsapp.net', 'mai', 'Mai', '[env 2]')).toBe(true)
    expect(created.length).toBe(1)
    expect(woken[1]).toEqual({ id: fork.id, content: '[env 2]' })
    expect(activeForks()[0]!.inboundCount).toBe(2)
  })

  it('queues messages that arrive during the spawn gap, flushes on init', () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)
    routeInbound(ctx, '447776912442@s.whatsapp.net', 'nica', 'Nica', '[env 1]')
    const fork = created[0]!
    // second message lands BEFORE session_init → queued, not woken
    expect(routeInbound(ctx, '447776912442@s.whatsapp.net', 'nica', 'Nica', '[env 2]')).toBe(true)
    expect(woken.length).toBe(1)
    ctx.sessions.set(fork.id, fork)
    fork.emit('hub_message', { type: 'session_init', claudeSessionId: 'c-fork-0' })
    expect(woken.length).toBe(2)
    expect(woken[1]!.content).toBe('[env 2]')
  })

  it('different threads get different forks', () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)
    routeInbound(ctx, '491629386217@s.whatsapp.net', 'mai', 'Mai', '[a]')
    routeInbound(ctx, '123456-7890@g.us', null, 'Hulm Club', '[b]')
    expect(created.length).toBe(2)
    expect(activeForks().length).toBe(2)
  })

  it('re-points hubSessionId after a restart re-minted it (claudeSessionId match)', () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)
    routeInbound(ctx, '491629386217@s.whatsapp.net', 'mai', 'Mai', '[env]')
    const fork = created[0]!
    ctx.sessions.set(fork.id, fork)
    fork.emit('hub_message', { type: 'session_init', claudeSessionId: 'c-fork-0' })
    // simulate restart: same claudeSessionId, new hub id
    const revived = new TestSession('s-new-hub-id', { claudeSessionId: 'c-fork-0' })
    const ctx2 = ctxOf(new Map<string, TestSession>([['s-al', parent], ['s-new-hub-id', revived]]))
    startConversationForks(ctx2) // reload from disk + re-point
    expect(routeInbound(ctx2, '491629386217@s.whatsapp.net', 'mai', 'Mai', '[env 2]')).toBe(true)
    expect(created.length).toBe(1) // no new fork
    expect(woken.at(-1)).toEqual({ id: 's-new-hub-id', content: '[env 2]' })
  })

  it('drops records whose sessions did not survive the restart', () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)
    routeInbound(ctx, '491629386217@s.whatsapp.net', 'mai', 'Mai', '[env]')
    expect(activeForks().length).toBe(1)
    // restart with NO surviving fork session
    const ctx2 = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx2)
    expect(activeForks().length).toBe(0)
  })
})

describe('idle wind-down', () => {
  it('trivial conversation → removed without merge; substantive → digest-merge', async () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)

    // trivial: 1 inbound
    routeInbound(ctx, '111@s.whatsapp.net', 'max', 'Max', '[hi]')
    const trivialFork = created[0]!
    ctx.sessions.set(trivialFork.id, trivialFork)

    // substantive: 3 inbounds (> TRIVIAL_MAX_INBOUND). The fork must emit
    // session_init first — until then later messages queue in the spawn gap
    // and don't bump inboundCount.
    routeInbound(ctx, '222@s.whatsapp.net', 'rowan', 'Rowan', '[q1]')
    const bigFork = created[1]!
    ctx.sessions.set(bigFork.id, bigFork)
    bigFork.emit('hub_message', { type: 'session_init', claudeSessionId: 'c-big' })
    routeInbound(ctx, '222@s.whatsapp.net', 'rowan', 'Rowan', '[q2]')
    routeInbound(ctx, '222@s.whatsapp.net', 'rowan', 'Rowan', '[q3]')

    // advance past IDLE_MS + one sweep tick
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000)

    // trivial → killed and removed from the sessions map (wound-down forks
    // go away — Yousef's call; transcripts on disk are the history)
    expect(trivialFork.killed).toBe(true)
    expect(ctx.sessions.has(trivialFork.id)).toBe(false)
    expect(merged).toEqual([bigFork.id])
    expect(activeForks().length).toBe(0)
  })

  it('a fork with a pending @amar marker is NEVER wound down', async () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)
    routeInbound(ctx, '333@s.whatsapp.net', 'rowan', 'Rowan', '[needs yousef]')
    const fork = created[0]!
    fork.needsAttention = { ts: Date.now(), snippet: 'Rowan wants a Bedrock key' }
    ctx.sessions.set(fork.id, fork)
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000)
    expect(fork.killed).toBe(false)
    expect(fork.hibernated).toBe(false)
    expect(merged.length).toBe(0)
    expect(activeForks().length).toBe(1) // still tracked + routed
  })

  it('a running fork gets its deadline pushed, not interrupted', async () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)
    routeInbound(ctx, '111@s.whatsapp.net', 'max', 'Max', '[hi]')
    const fork = created[0]!
    fork.status = 'running'
    ctx.sessions.set(fork.id, fork)
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000)
    expect(fork.killed).toBe(false)
    expect(merged.length).toBe(0)
    expect(activeForks().length).toBe(1) // still tracked, deadline pushed
  })
})
