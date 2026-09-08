// Pinned read (^fond-yak): approving a hand-back marks the fork read and keeps
// it read — whatever its wind-down turn logs, no attention marker — until it
// is folded into its parent, deleted, marked unread or its card is reopened.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { HubMessage } from '../protocol.js'

class MockProcess extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() }
  stdout = new Readable({ read() {} })
  stderr = new Readable({ read() {} })
  pid = 12345
  killed = false
  kill(signal?: string) {
    this.killed = true
    this.emit('exit', signal === 'SIGINT' ? 130 : 0)
  }
}
vi.mock('node:child_process', () => ({
  spawn: () => new MockProcess(),
  execFile: (_c: string, _a: string[], _o: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => { cb?.(null, { stdout: '' }) },
  execSync: () => '',
}))
vi.mock('../auth-backend.js', () => ({ detectActiveBackend: () => 'bedrock' }))
vi.mock('../manifest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../manifest.js')>()),
  saveManifest: () => {},
}))

import { _resetReadStateForTests, getLastReadIndex, isReadPinned, parseReadStateFile, pinRead, setLastReadIndex, unpinRead } from '../read-state.js'
import { Session } from '../session.js'
import { markSessionRead, markSessionUnread, mergeFork, type AgentContext } from '../routes/agents.js'

const tick = () => new Promise<void>((r) => setImmediate(r))

beforeEach(() => _resetReadStateForTests())

describe('read-state pins', () => {
  it('pin / unpin / isReadPinned; unpin reports whether there was a pin', () => {
    expect(isReadPinned('c1')).toBe(false)
    pinRead('c1')
    expect(isReadPinned('c1')).toBe(true)
    expect(unpinRead('c1')).toBe(true)
    expect(unpinRead('c1')).toBe(false)
    expect(isReadPinned(undefined)).toBe(false)
    expect(unpinRead(undefined)).toBe(false)
  })

  it('reads the v1 flat file and the v2 nested file; garbage → empty', () => {
    expect(parseReadStateFile({ a: 3, b: 7 })).toEqual({ read: { a: 3, b: 7 }, pinned: {} })
    expect(parseReadStateFile({ read: { a: 3 }, pinned: { a: 123 } })).toEqual({ read: { a: 3 }, pinned: { a: 123 } })
    expect(parseReadStateFile({ read: { a: 3 } })).toEqual({ read: { a: 3 }, pinned: {} })
    expect(parseReadStateFile(null)).toEqual({ read: {}, pinned: {} })
    expect(parseReadStateFile('x')).toEqual({ read: {}, pinned: {} })
  })
})

describe('Session while pinned read', () => {
  const collect = (s: Session) => { const out: HubMessage[] = []; s.on('hub_message', (m: HubMessage) => out.push(m)); return out }

  it('every logged message advances lastReadIndex to the log length and re-broadcasts read state a beat later', async () => {
    const s = new Session({ prompt: 'continue', resume: 'csid-pinned' })
    expect(s.claudeSessionId).toBe('csid-pinned')
    setLastReadIndex('csid-pinned', 0)
    pinRead('csid-pinned')
    const msgs = collect(s)
    s.logMessage({ type: 'text', sessionId: s.id, content: 'wind-down summary' })
    s.logMessage({ type: 'text', sessionId: s.id, content: 'more' })
    expect(getLastReadIndex('csid-pinned')).toBe(2)
    expect(msgs).toHaveLength(0) // not yet — the message itself broadcasts first
    await tick()
    const reads = msgs.filter((m) => m.type === 'session_read_state')
    expect(reads.length).toBeGreaterThanOrEqual(1)
    const last = reads[reads.length - 1] as Extract<HubMessage, { type: 'session_read_state' }>
    expect(last).toMatchObject({ sessionId: s.id, lastReadIndex: 2, messageLogLength: 2, readPinned: true })
    expect(s.getInfo()).toMatchObject({ readPinned: true, lastReadIndex: 2, messageLogLength: 2 })
    s.kill()
  })

  it('an unpinned session logs without touching read state', async () => {
    const s = new Session({ prompt: 'continue', resume: 'csid-plain' })
    setLastReadIndex('csid-plain', 0)
    const msgs = collect(s)
    s.logMessage({ type: 'text', sessionId: s.id, content: 'hello' })
    await tick()
    expect(getLastReadIndex('csid-plain')).toBe(0)
    expect(msgs.filter((m) => m.type === 'session_read_state')).toHaveLength(0)
    expect(s.getInfo().readPinned).toBeUndefined()
    expect(s.getInfo().lastReadIndex).toBe(0)
    s.kill()
  })

  it('@amar raises no attention marker (and no push) while pinned; it does again once unpinned', () => {
    const s = new Session({ prompt: 'continue', resume: 'csid-att' })
    pinRead('csid-att')
    const msgs = collect(s)
    s.flagAttention('need you', true)
    expect(s.needsAttention).toBeNull()
    expect(msgs.filter((m) => m.type === 'session_attention')).toHaveLength(0)
    unpinRead('csid-att')
    s.flagAttention('need you', true)
    expect(s.needsAttention).toMatchObject({ snippet: 'need you' })
    expect(msgs.filter((m) => m.type === 'session_attention')).toHaveLength(1)
    s.kill()
  })
})

describe('mark read / unread / merge lifecycle', () => {
  const ctxOf = (sessions: Map<string, unknown>): AgentContext =>
    ({ sessions, clients: new Set(), cwd: '/tmp', log: () => {}, truncate: (x: string) => x, modelConfig: {} } as unknown as AgentContext)

  it('markSessionRead({sticky}) pins; a later message stays read; markSessionUnread lifts the pin', async () => {
    const s = new Session({ prompt: 'continue', resume: 'csid-life' })
    s.logMessage({ type: 'text', sessionId: s.id, content: 'hand-back' })
    const ctx = ctxOf(new Map([[s.id, s]]))
    markSessionRead(ctx, s, { sticky: true })
    expect(isReadPinned('csid-life')).toBe(true)
    expect(getLastReadIndex('csid-life')).toBe(1)
    s.logMessage({ type: 'text', sessionId: s.id, content: 'merging…' })
    await tick()
    expect(getLastReadIndex('csid-life')).toBe(2)
    markSessionUnread(s, ctx.clients)
    expect(isReadPinned('csid-life')).toBe(false)
    expect(getLastReadIndex('csid-life')).toBe(1)
    s.logMessage({ type: 'text', sessionId: s.id, content: 'after unpin' })
    await tick()
    expect(getLastReadIndex('csid-life')).toBe(1) // unread again from here
    s.kill()
  })

  it('plain markSessionRead does not pin', () => {
    const s = new Session({ prompt: 'continue', resume: 'csid-plainread' })
    markSessionRead(ctxOf(new Map([[s.id, s]])), s)
    expect(isReadPinned('csid-plainread')).toBe(false)
    s.kill()
  })

  it('folding the fork into its parent lifts the pin', async () => {
    class TestSession extends EventEmitter {
      sent: string[] = []
      killed = false
      status: 'running' | 'idle' | 'ended' = 'idle'
      claudeSessionId?: string
      name?: string
      parentClaudeSessionId?: string
      reply: string | null = null
      constructor(public id: string, init: Partial<TestSession> = {}) { super(); Object.assign(this, init) }
      sendMessage() {
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
      getInfo() { return { id: this.id, status: this.status, name: this.name } }
    }
    const parent = new TestSession('s-p', { claudeSessionId: 'c-p', name: 'Parent' })
    const fork = new TestSession('s-f', { claudeSessionId: 'c-f', name: 'Parent (fork)', parentClaudeSessionId: 'c-p', reply: 'Summary.' })
    pinRead('c-f')
    const res = await mergeFork(ctxOf(new Map([['s-p', parent], ['s-f', fork]])), 's-f', 2000)
    expect(res.ok).toBe(true)
    expect(isReadPinned('c-f')).toBe(false)
  })
})
