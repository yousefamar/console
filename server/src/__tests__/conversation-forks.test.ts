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
  createSession: (_ctx: unknown, opts: { name?: string; parentClaudeSessionId?: string; agentKey?: string }) => {
    const s = new TestSession(`s-fork-${created.length}`, { name: opts.name, parentClaudeSessionId: opts.parentClaudeSessionId, agentKey: opts.agentKey })
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

import { routeInbound, startConversationForks, activeForks, forkSummaries, isReplySend, mergeReason, lastMovedAt, type ForkRecord } from '../al/conversation-forks.js'
import * as alSession from '../al/al-session.js'

class TestSession extends EventEmitter {
  killed = false
  hibernated = false
  needsAttention: { ts: number; snippet: string } | null = null
  status: 'running' | 'idle' | 'ended' = 'idle'
  claudeSessionId?: string
  name?: string
  agentKey?: string
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
  parent = new TestSession('s-al', { claudeSessionId: 'c-al', name: 'AL' })
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
    expect(fork.name).toBe('AL ↔ Mai')
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

  it('a fork gets an `al-<contact>` agentKey and is listed by label for the owner envelope', () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)
    routeInbound(ctx, '447776912442@s.whatsapp.net', 'nica', 'nica', '[env]')
    const fork = created[0]!
    expect(fork.agentKey).toBe('al-nica')
    ctx.sessions.set(fork.id, fork)
    // a second live fork for the same contact name gets a suffixed key
    routeInbound(ctx, '999@s.whatsapp.net', null, 'nica', '[env]')
    expect(created[1]!.agentKey).toBe('al-nica-1')
    expect(forkSummaries().map((f) => f.label)).toEqual(['nica', 'nica'])
    expect(forkSummaries()[0]!.lastInboundAt).toBe(Date.now())
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

// ---------------------------------------------------------------------------
// A fork's work must reach the parent. 9 Oct 2026: a fork that spent 95 minutes
// and 245 tool calls on one request had two inbound messages, was called
// "trivial (2 msg)" and removed with no merge — the "any tool call beyond the
// reply makes it substantive" half had never been wired.
// ---------------------------------------------------------------------------

const NICA = '142245139378326@lid'
const reply = (to: string, body = 'on it') => ({ type: 'tool_use', toolName: 'Bash', input: { command: `con whatsapp send ${to} --body "${body}"` } })
const work = (command = 'python3 scrape.py') => ({ type: 'tool_use', toolName: 'Bash', input: { command } })
const HOUR = 60 * 60 * 1000

describe('isReplySend', () => {
  const ids = [NICA, '447776912442@s.whatsapp.net']

  it('is true only for a bare send to one of this thread\'s identities', () => {
    expect(isReplySend('Bash', { command: `con whatsapp send ${NICA} --body "3pm, see you then"` }, ids)).toBe(true)
    expect(isReplySend('Bash', { command: 'con whatsapp send 447776912442@s.whatsapp.net --speak "hello"' }, ids)).toBe(true)
    expect(isReplySend('Bash', { command: `  con whatsapp send "${NICA}" --body 'ok'` }, ids)).toBe(true)
  })

  it('lets the message body contain shell punctuation without calling it work', () => {
    expect(isReplySend('Bash', { command: `con whatsapp send ${NICA} --body "Done; 1,487 rows & a link | see below"` }, ids)).toBe(true)
    expect(isReplySend('Bash', { command: `con whatsapp send ${NICA} --body 'cost is $(unknown) for now'` }, ids)).toBe(true)
  })

  it('a send to anyone else is work — that is the fork asking Yousef for approval', () => {
    expect(isReplySend('Bash', { command: 'con whatsapp send 447845443890@s.whatsapp.net --body "ok to scrape for Nica?"' }, ids)).toBe(false)
  })

  it('anything chained to the send, or run inside it, is work', () => {
    expect(isReplySend('Bash', { command: `con whatsapp send ${NICA} --body "started" && python3 scrape.py` }, ids)).toBe(false)
    expect(isReplySend('Bash', { command: `con whatsapp send ${NICA} --body "started"; rm -rf out` }, ids)).toBe(false)
    expect(isReplySend('Bash', { command: `con whatsapp send ${NICA} --body "rows: $(wc -l < out.csv)"` }, ids)).toBe(false)
    expect(isReplySend('Bash', { command: `con whatsapp send ${NICA} --body "x"\npython3 more.py` }, ids)).toBe(false)
  })

  it('every other tool and every other command is work', () => {
    expect(isReplySend('Write', { file_path: '/tmp/parser.py', content: '' }, ids)).toBe(false)
    expect(isReplySend('Read', { file_path: '/tmp/x' }, ids)).toBe(false)
    expect(isReplySend('Bash', { command: 'con dashboard canvas tab publish laptop-pcf' }, ids)).toBe(false)
    expect(isReplySend('Bash', { command: `con whatsapp send-file ${NICA} out.csv` }, ids)).toBe(false)
    expect(isReplySend('Bash', {}, ids)).toBe(false)
  })
})

describe('mergeReason — merging is the default, reaping needs proof', () => {
  const rec = (over: Partial<ForkRecord> = {}): ForkRecord =>
    ({ threadJid: NICA, hubSessionId: 's', createdAt: 0, lastInboundAt: 0, inboundCount: 2, observed: true, workCalls: 0, ...over })

  it('is null only when the fork was watched all its life and did nothing but reply', () => {
    expect(mergeReason(rec())).toBeNull()
    expect(mergeReason(rec({ inboundCount: 1 }))).toBeNull()
  })

  it('work is a reason whatever the message count', () => {
    expect(mergeReason(rec({ workCalls: 243, substantive: true }))).toBe('243 tool call(s) beyond replying')
    expect(mergeReason(rec({ inboundCount: 1, workCalls: 1 }))).toBe('1 tool call(s) beyond replying')
  })

  it('a long conversation is a reason', () => {
    expect(mergeReason(rec({ inboundCount: 3 }))).toBe('3 inbound messages')
  })

  it('an unwatched history is a reason: a record from before tracking is never called trivial', () => {
    expect(mergeReason(rec({ observed: undefined, workCalls: undefined }))).toBe('its history was not watched')
  })
})

describe('a fork that did real work is merged, however few messages it got', () => {
  it('the incident: two inbound messages, hundreds of tool calls → digest-merge, not a silent reap', async () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)
    routeInbound(ctx, NICA, 'nica', 'nica', '[can you scrape this for me?]')
    const fork = created[0]!
    ctx.sessions.set(fork.id, fork)
    fork.emit('hub_message', { type: 'session_init', claudeSessionId: 'c-nica' })
    routeInbound(ctx, NICA, 'nica', 'nica', "[how's the scraping going?]")
    expect(activeForks()[0]!.inboundCount).toBe(2)

    fork.emit('hub_message', reply(NICA, 'on it'))
    fork.emit('hub_message', reply('447845443890@s.whatsapp.net', 'ok to scrape for Nica?'))   // asked Yousef
    for (let i = 0; i < 200; i++) fork.emit('hub_message', i % 3 ? work() : { type: 'tool_use', toolName: 'Write', input: { file_path: `/tmp/parser-${i}.py` } })
    fork.emit('hub_message', reply(NICA, 'done, here is the link'))
    fork.emit('hub_message', { type: 'result' })
    expect(activeForks()[0]).toMatchObject({ substantive: true, workCalls: 201, observed: true })

    await vi.advanceTimersByTimeAsync(61 * 60 * 1000)
    expect(merged).toEqual([fork.id])
    expect(fork.killed).toBe(false)             // mergeIntoParent closes it, with its digest
    expect(activeForks().length).toBe(0)
  })

  it('two messages answered with nothing but replies is still reaped quietly', async () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)
    routeInbound(ctx, NICA, 'nica', 'nica', '[thanks!]')
    const fork = created[0]!
    ctx.sessions.set(fork.id, fork)
    fork.emit('hub_message', { type: 'session_init', claudeSessionId: 'c-nica' })
    routeInbound(ctx, NICA, 'nica', 'nica', '[see you]')
    fork.emit('hub_message', reply(NICA, 'np'))
    fork.emit('hub_message', reply(NICA, 'see you'))
    fork.emit('hub_message', { type: 'result' })
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000)
    expect(merged).toEqual([])
    expect(fork.killed).toBe(true)
  })

  it('one tool call that is not a reply is enough', async () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)
    routeInbound(ctx, NICA, 'nica', 'nica', '[add milk to the list]')
    const fork = created[0]!
    ctx.sessions.set(fork.id, fork)
    fork.emit('hub_message', { type: 'tool_use', toolName: 'Edit', input: { file_path: '/vault/shopping.md' } })
    fork.emit('hub_message', reply(NICA, 'added'))
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000)
    expect(merged).toEqual([fork.id])
  })
})

describe('idle is measured from the fork\'s own last work, not only their last message', () => {
  it('a turn that ends 95 minutes after the last inbound restarts the clock', async () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)
    routeInbound(ctx, NICA, 'nica', 'nica', '[scrape please]')
    const fork = created[0]!
    ctx.sessions.set(fork.id, fork)
    fork.emit('hub_message', work())

    // One long turn: the existing mid-turn guard holds while it runs…
    fork.status = 'running'
    await vi.advanceTimersByTimeAsync(95 * 60 * 1000)
    expect(activeForks().length).toBe(1)
    // …and it ends here, 95 minutes after her message.
    fork.status = 'idle'
    fork.emit('hub_message', { type: 'result' })
    const rec = activeForks()[0]!
    expect(lastMovedAt(rec)).toBe(rec.lastTurnEndAt)

    // 15 minutes later — where the real fork was reaped — it is still there.
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(activeForks().length).toBe(1)
    expect(merged).toEqual([])
    // A reply from her now still reaches the fork that has the context.
    routeInbound(ctx, NICA, 'nica', 'nica', '[amazing, thank you]')
    expect(created.length).toBe(1)

    // A full hour after the conversation last moved, it is merged.
    await vi.advanceTimersByTimeAsync(HOUR + 2 * 60 * 1000)
    expect(merged).toEqual([fork.id])
  })
})

describe('the evidence survives a hub restart', () => {
  it('counts persist, and the watcher is re-attached to the restored session', async () => {
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent]]))
    startConversationForks(ctx)
    routeInbound(ctx, NICA, 'nica', 'nica', '[scrape please]')
    const fork = created[0]!
    ctx.sessions.set(fork.id, fork)
    fork.emit('hub_message', { type: 'session_init', claudeSessionId: 'c-nica' })
    fork.emit('hub_message', work())
    expect(JSON.parse(readFileSync(process.env.CONSOLE_AL_FORKS_FILE!, 'utf-8')).forks[NICA]).toMatchObject({ substantive: true, observed: true })

    // Restart: same claudeSessionId, a NEW Session object with a new hub id.
    const revived = new TestSession('s-after-restart', { claudeSessionId: 'c-nica' })
    const ctx2 = ctxOf(new Map<string, TestSession>([['s-al', parent], ['s-after-restart', revived]]))
    startConversationForks(ctx2)
    expect(activeForks()[0]).toMatchObject({ substantive: true, observed: true })
    revived.emit('hub_message', work('python3 parse.py'))
    revived.emit('hub_message', { type: 'result' })
    expect(activeForks()[0]!.workCalls).toBe(2)
    expect(activeForks()[0]!.lastTurnEndAt).toBe(Date.now())
  })

  it('a record written before tracking existed is merged, never guessed trivial', async () => {
    const { writeFileSync } = await import('node:fs')
    const legacy = new TestSession('s-legacy', { claudeSessionId: 'c-legacy' })
    writeFileSync(process.env.CONSOLE_AL_FORKS_FILE!, JSON.stringify({ version: 1, forks: { [NICA]: {
      threadJid: NICA, label: 'nica', hubSessionId: 's-old', claudeSessionId: 'c-legacy', createdAt: Date.now(), lastInboundAt: Date.now(), inboundCount: 2,
    } } }))
    const ctx = ctxOf(new Map<string, TestSession>([['s-al', parent], ['s-legacy', legacy]]))
    startConversationForks(ctx)
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000)
    expect(merged).toEqual(['s-legacy'])
    expect(legacy.killed).toBe(false)
  })
})
