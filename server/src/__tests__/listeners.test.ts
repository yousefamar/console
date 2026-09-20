import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore } from '../events/store.js'
import { EventBus } from '../events/bus.js'
import { ListenerStore } from '../listeners/store.js'
import { ListenerEngine, buildEventEnvelope, template, validateAction } from '../listeners/engine.js'
import { parseWhere, whereMatches, inWindow, nextWindowStart, parseDays } from '../listeners/matcher.js'
import type { ShellRunner } from '../listeners/shell.js'
import type { HubEvent } from '../events/types.js'
import type { Session } from '../session.js'
import type { PushMessage } from '../push.js'

let dir: string
let clock: number
const now = () => clock
const tick = async (ms = 0) => { clock += ms; await new Promise((r) => setTimeout(r, 5)) }
/** Wait (real time, ≤ 2 s) for an async start()-time side effect. */
const until = async (fn: () => boolean) => { for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)) }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'listeners-')); clock = Date.parse('2026-09-21T10:00:00Z') /* Monday */ })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

interface FakeSession { id: string; name: string; status: string; claudeSessionId: string; agentKey?: string; cwd: string; queuedMessage: string | null; needsAttention: unknown; sent: string[]; queued: string[]; emit: (type: string, msg: unknown) => void }
function fakeSession(csid: string, agentKey = 'tester', status = 'idle'): FakeSession & Session {
  const handlers = new Map<string, Set<(m: unknown) => void>>()
  const s = {
    id: `session_${csid.slice(0, 4)}`, name: agentKey, status, claudeSessionId: csid, agentKey, cwd: dir, queuedMessage: null, needsAttention: null, sent: [], queued: [],
    emit: (type: string, msg: unknown) => { for (const fn of handlers.get(type) ?? []) fn(msg) },
  } as FakeSession
  return Object.assign(s, {
    sendMessage: (c: string) => { s.sent.push(c) },
    queueMessage: (c: string) => { s.queued.push(c); s.queuedMessage = c },
    logMessage: () => {},
    on: (type: string, fn: (m: unknown) => void) => { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type)!.add(fn) },
    off: (type: string, fn: (m: unknown) => void) => { handlers.get(type)?.delete(fn) },
  }) as unknown as FakeSession & Session
}

function harness(opts: { shell?: ShellRunner; sessions?: Array<FakeSession & Session>; postOk?: boolean; forks?: boolean } = {}) {
  const bus = new EventBus(new EventStore(join(dir, 'events')), () => {}, now)
  const store = new ListenerStore(join(dir, 'listeners.json'))
  const sessions = new Map<string, Session>()
  for (const s of opts.sessions ?? []) sessions.set(s.id, s)
  const notices: PushMessage[] = []
  const posts: Array<{ url: string; body: string; headers: Record<string, string> }> = []
  const cards: string[] = []
  const logs: string[] = []
  const forks: Array<FakeSession & Session & { model?: string; closed?: boolean }> = []
  const engine = new ListenerEngine({
    bus, store,
    getSessions: () => sessions,
    liveSessionForKey: (k) => [...sessions.values()].find((s) => s.agentKey === k && s.status !== 'ended'),
    broadcast: () => {},
    notify: (m) => notices.push(m),
    addCard: async (p, t) => { cards.push(`${p}: ${t}`); return `"${t}" → Backlog` },
    postUrl: async (url, body, headers) => { posts.push({ url, body, headers }); return { ok: opts.postOk ?? true, detail: opts.postOk === false ? 'HTTP 500' : 'HTTP 200' } },
    ...(opts.forks ? {
      spawnFork: (source, l, model) => {
        const f = Object.assign(fakeSession(`f${forks.length}000000-0000-0000-0000-000000000000`, `${source.agentKey}-${l.id.toLowerCase()}-fork`), { model, name: `Listener ${l.id} (fork)` })
        forks.push(f); sessions.set(f.id, f)
        return f
      },
      closeFork: (f) => { (f as unknown as { closed: boolean }).closed = true; sessions.delete(f.id) },
    } : {}),
    shell: opts.shell,
    log: (m) => logs.push(m),
    now,
  })
  return { bus, store, engine, sessions, notices, posts, cards, logs, forks }
}

const OWNER = { claudeSessionId: '11111111-1111-1111-1111-111111111111', agentKey: 'tester' }
const chat = (bus: EventBus, over: Record<string, unknown> = {}, key?: string) =>
  bus.emit({ topic: 'chat.message', source: 'matrix', data: { room: '!baba', sender: '@baba', isSelf: false, body: 'Gm', ...over }, key })!

describe('matcher', () => {
  const ev: HubEvent = { id: 'e', topic: 'chat.message', at: 0, source: 'matrix', hops: 0, data: { room: '!abc', isSelf: false, body: 'Good morning', n: 7, headers: { 'x-github-event': 'push' } } }
  it('parses every operator and evaluates it', () => {
    expect(whereMatches(ev, [parseWhere('data.room=!abc')])).toBe(true)
    expect(whereMatches(ev, [parseWhere('data.room!=!abc')])).toBe(false)
    expect(whereMatches(ev, [parseWhere('data.isSelf=false')])).toBe(true)
    expect(whereMatches(ev, [parseWhere('data.body~/^good/i')])).toBe(true)
    expect(whereMatches(ev, [parseWhere('data.body~^good')])).toBe(false)
    expect(whereMatches(ev, [parseWhere('data.body^=Good')])).toBe(true)
    expect(whereMatches(ev, [parseWhere('data.n>5'), parseWhere('data.n<=7')])).toBe(true)
    expect(whereMatches(ev, [parseWhere('data.n>=8')])).toBe(false)
    expect(whereMatches(ev, [parseWhere('data.headers.x-github-event in push|pull_request')])).toBe(true)
    expect(whereMatches(ev, [parseWhere('data.missing=x')])).toBe(false)
    expect(whereMatches(ev, [parseWhere('data.missing!=x')])).toBe(true)
    expect(whereMatches(ev, [parseWhere('topic=chat.message')])).toBe(true)
  })
  it('rejects nonsense loudly', () => {
    expect(() => parseWhere('no operator here')).toThrow(/expected/)
    expect(() => parseWhere('data.x~[')).toThrow(/regex/)
    expect(() => parseWhere('data.x>abc')).toThrow(/numeric/)
  })
  it('windows: hours (incl. overnight), days, next opening', () => {
    const mon10 = Date.parse('2026-09-21T09:00:00Z') // 10:00 BST Monday
    expect(inWindow(mon10, '07:00-23:00')).toBe(true)
    expect(inWindow(mon10, '22:00-06:00')).toBe(false)
    expect(inWindow(Date.parse('2026-09-21T22:30:00Z'), '22:00-06:00')).toBe(true)
    expect(inWindow(mon10, undefined, 'Mon-Fri')).toBe(true)
    expect(inWindow(mon10, undefined, 'Sat,Sun')).toBe(false)
    expect([...parseDays('Fri-Mon')].sort()).toEqual([0, 1, 5, 6])
    const next = nextWindowStart(mon10, '12:00-13:00')!
    expect(new Date(next).toISOString()).toBe('2026-09-21T11:00:00.000Z')
    expect(nextWindowStart(mon10, undefined, 'Sat')).toBe(Date.parse('2026-09-25T23:00:00Z'))
  })
})

describe('engine: ladder', () => {
  it('where filter → coalesce → one wake with the batch, journaled fired', async () => {
    const s = fakeSession(OWNER.claudeSessionId)
    const h = harness({ sessions: [s] })
    h.engine.start()
    const l = h.engine.add({ owner: OWNER, on: 'chat.message', where: ['data.room=!baba', 'data.isSelf=false'], coalesce: 1_000, action: { type: 'wake', prompt: 'Baba wrote: {{data.body}}' } })
    chat(h.bus)
    chat(h.bus, { isSelf: true })            // filtered out
    chat(h.bus, { body: 'Gn' })
    chat(h.bus, { room: '!other' })           // filtered out
    expect(l.stats.matched).toBe(2)
    expect(l.pending?.events.length).toBe(2)
    expect(s.sent).toEqual([])
    // quiet period elapses → timer fires → one wake carrying both
    clock += 1_100
    await h.engine.flushPending(l)
    expect(s.sent.length).toBe(1)
    expect(s.sent[0]).toMatch(/\[EVENT — chat\.message ×2 coalesced\] Listener L/)
    expect(s.sent[0]).toMatch(/Baba wrote: Gm$/)
    expect(l.stats.fired).toBe(1)
    expect(l.pending).toBeUndefined()
    expect(l.outcomes.map((o) => o.stage)).toEqual(['fired'])
    expect(h.bus.list({ topic: 'listener.fired' }).length).toBe(1)
  })

  it('a mid-turn owner gets the wake queued, not stacked', async () => {
    const s = fakeSession(OWNER.claudeSessionId, 'tester', 'running')
    const h = harness({ sessions: [s] })
    h.engine.start()
    const l = h.engine.add({ owner: OWNER, on: 'x.y', coalesce: 0, action: { type: 'wake', prompt: 'p' } })
    h.bus.emit({ topic: 'x.y', source: 't', data: {} })
    await h.engine.flushPending(l)
    expect(s.queued.length).toBe(1)
    expect(l.stats.lastOutcome).toMatch(/queued \(session mid-turn\)/)
  })

  it('guard exit 1 = deliberate no-op; exit 0 stdout rides in the envelope; stdin carries the batch', async () => {
    const s = fakeSession(OWNER.claudeSessionId)
    const seen: string[] = []
    const shell: ShellRunner = async (cmd, o) => {
      seen.push(o.input)
      const batch = JSON.parse(o.input) as { events: HubEvent[] }
      const ok = batch.events.some((e) => String(e.data.body).includes('nervous'))
      return { code: ok ? 0 : 1, stdout: ok ? 'Mai sounds nervous' : '', stderr: '', killed: false }
    }
    const h = harness({ sessions: [s], shell })
    h.engine.start()
    const l = h.engine.add({ owner: OWNER, on: 'chat.message', guard: 'python3 gmgn.py --event', coalesce: 0, action: { type: 'wake', prompt: 'Tell Yousef.' } })
    chat(h.bus, { body: 'Gm' }); await h.engine.flushPending(l)
    expect(l.stats.guardSkipped).toBe(1)
    expect(s.sent).toEqual([])
    chat(h.bus, { body: 'Gm ,, I am nervous' }); await h.engine.flushPending(l)
    expect(s.sent.length).toBe(1)
    expect(s.sent[0]).toMatch(/--- guard output \(`python3 gmgn.py --event`\) ---\nMai sounds nervous/)
    expect(JSON.parse(seen[0]!).listener.id).toBe(l.id)
    expect(l.outcomes.map((o) => o.stage)).toEqual(['guard-skipped', 'fired'])
  })

  it('run / post / notify / emit / card actions need no session', async () => {
    const ran: string[] = []
    const shell: ShellRunner = async (cmd, o) => { ran.push(`${cmd}|${o.env.EVENT_TOPIC}|${o.env.EVENT_COUNT}`); return { code: 0, stdout: 'done', stderr: '', killed: false } }
    const h = harness({ shell })
    h.engine.start()
    const run = h.engine.add({ owner: OWNER, on: 'geo.enter', where: ['data.fence=home'], action: { type: 'run', cmd: '~/exec/evening.sh' } })
    const post = h.engine.add({ owner: OWNER, on: 'geo.enter', action: { type: 'post', url: 'https://example.test/hook', headers: { 'X-Token': 't' } } })
    const notify = h.engine.add({ owner: OWNER, on: 'geo.enter', action: { type: 'notify', title: 'Arrived {{data.fenceName}}', body: 'after {{data.dwellS}} s out' } })
    const emit = h.engine.add({ owner: OWNER, on: 'geo.enter', where: ['data.fence=home'], action: { type: 'emit', topic: 'home.arrived', data: { via: '{{data.fence}}' } } })
    const card = h.engine.add({ owner: OWNER, on: 'geo.enter', action: { type: 'card', project: 'console', text: 'At {{data.fenceName}}', column: 'Backlog' } })
    h.bus.emit({ topic: 'geo.enter', source: 'location', data: { fence: 'home', fenceName: 'Home', dwellS: 3600 } })
    for (const l of [run, post, notify, emit, card]) await h.engine.flushPending(l)
    expect(ran).toEqual(['~/exec/evening.sh|geo.enter|1'])
    expect(h.posts.length).toBe(1)
    expect(h.posts[0]!.headers['X-Token']).toBe('t')
    expect(h.posts[0]!.headers['X-Console-Listener']).toBe(post.id)
    expect(JSON.parse(h.posts[0]!.body).events[0].data.fence).toBe('home')
    const generic = h.notices.find((n) => n.type === 'generic')!
    expect(generic.title).toBe('Arrived Home')
    expect(generic.body).toBe('after 3600 s out')
    const derived = h.bus.list({ topic: 'home.arrived' })[0]!
    expect(derived.hops).toBe(1)
    expect(derived.data.via).toBe('home')
    expect(derived.source).toBe(`listener:${emit.id}`)
    expect(h.cards).toEqual(['console: At Home'])
    // the derived event must not re-trigger its own listener (self-source guard)
    expect(emit.stats.matched).toBe(1)
  })

  it('cooldown holds the next batch until the gap has passed, nothing dropped', async () => {
    const s = fakeSession(OWNER.claudeSessionId)
    const h = harness({ sessions: [s] })
    h.engine.start()
    const l = h.engine.add({ owner: OWNER, on: 'x.y', coalesce: 0, cooldown: 600_000, action: { type: 'wake', prompt: 'p' } })
    h.bus.emit({ topic: 'x.y', source: 't', data: { n: 1 } }); await h.engine.flushPending(l)
    expect(s.sent.length).toBe(1)
    clock += 1_000
    h.bus.emit({ topic: 'x.y', source: 't', data: { n: 2 } })
    await h.engine.flushPending(l)
    expect(s.sent.length).toBe(1)
    expect(l.pending?.events.length).toBe(1)
    expect(l.pending!.dueAt).toBe(l.stats.lastFiredAt! + 600_000)
    clock += 600_000
    await h.engine.flushPending(l)
    expect(s.sent.length).toBe(2)
  })

  it('outside the active window: held until it opens, or dropped with dropOutside', async () => {
    const s = fakeSession(OWNER.claudeSessionId)
    const h = harness({ sessions: [s] })
    h.engine.start()
    clock = Date.parse('2026-09-21T02:00:00Z') // 03:00 BST
    const hold = h.engine.add({ owner: OWNER, on: 'x.y', coalesce: 0, hours: '07:00-23:00', action: { type: 'wake', prompt: 'p' } })
    const drop = h.engine.add({ owner: OWNER, on: 'x.y', coalesce: 0, hours: '07:00-23:00', dropOutside: true, action: { type: 'wake', prompt: 'p' } })
    h.bus.emit({ topic: 'x.y', source: 't', data: {} })
    expect(hold.pending?.dueAt).toBe(Date.parse('2026-09-21T06:00:00Z'))
    expect(drop.pending).toBeUndefined()
    expect(drop.outcomes[0]!.stage).toBe('dropped')
    await h.engine.flushPending(hold)
    expect(s.sent.length).toBe(0)
    clock = Date.parse('2026-09-21T06:00:01Z')
    await h.engine.flushPending(hold)
    expect(s.sent.length).toBe(1)
  })

  it('the per-hour ceiling pauses the listener, keeps the batch, and notifies', async () => {
    const s = fakeSession(OWNER.claudeSessionId)
    const h = harness({ sessions: [s] })
    h.engine.start()
    const l = h.engine.add({ owner: OWNER, on: 'x.y', coalesce: 0, maxPerHour: 2, action: { type: 'wake', prompt: 'p' } })
    for (let i = 0; i < 3; i++) { clock += 1000; h.bus.emit({ topic: 'x.y', source: 't', data: { i } }); await h.engine.flushPending(l) }
    expect(s.sent.length).toBe(2)
    expect(l.pausedAt).toBeTruthy()
    expect(l.pauseReason).toMatch(/ceiling/)
    expect(l.pending?.events.length).toBe(1)
    expect(h.notices.some((n) => n.title?.includes('paused'))).toBe(true)
    expect(h.bus.list({ topic: 'listener.paused' }).length).toBe(1)
    // resume flushes what was held
    h.engine.resume(l.id)
    clock += 1_500
    await h.engine.flushPending(l)
    expect(s.sent.length).toBe(3)
  })

  it('a dead wake target skips, warns at 3, auto-disables at 10', async () => {
    const h = harness()
    h.engine.start()
    const l = h.engine.add({ owner: OWNER, on: 'x.y', coalesce: 0, action: { type: 'wake', prompt: 'p' } })
    for (let i = 0; i < 10; i++) { h.bus.emit({ topic: 'x.y', source: 't', data: { i } }); await h.engine.flushPending(l) }
    expect(l.consecutiveSkips).toBe(10)
    expect(l.disabledAt).toBeTruthy()
    expect(h.notices.filter((n) => n.title?.includes('skipping')).length).toBe(1)
    expect(h.notices.filter((n) => n.title?.includes('auto-disabled')).length).toBe(1)
    h.bus.emit({ topic: 'x.y', source: 't', data: {} })
    expect(l.stats.matched).toBe(10) // disabled listeners do not match
  })

  it('test() reports the rung that stops an event, never acts', async () => {
    const s = fakeSession(OWNER.claudeSessionId)
    const shell: ShellRunner = async () => ({ code: 1, stdout: 'not yet', stderr: '', killed: false })
    const h = harness({ sessions: [s], shell })
    h.engine.start()
    const l = h.engine.add({ owner: OWNER, on: 'chat.message', where: ['data.room=!baba'], guard: 'x', action: { type: 'wake', prompt: 'p' } })
    const wrongRoom = chat(h.bus, { room: '!other' })
    expect((await h.engine.test(l.id, wrongRoom)).stage).toBe('where')
    const right = chat(h.bus)
    expect((await h.engine.test(l.id, right))).toMatchObject({ stage: 'guard', detail: expect.stringContaining('not yet') })
    const l2 = h.engine.add({ owner: OWNER, on: 'chat.message', action: { type: 'wake', prompt: 'p' } })
    const r = await h.engine.test(l2.id, right)
    expect(r.stage).toBe('would-fire')
    expect(r.envelope).toMatch(/\[EVENT — chat\.message\]/)
    expect(s.sent).toEqual([])
    expect((await h.engine.test(l2.id, { ...right, topic: 'mail.received' })).stage).toBe('no-match')
  })

  it('removal by another agent tells the owner; by the owner is silent', () => {
    const s = fakeSession(OWNER.claudeSessionId)
    const h = harness({ sessions: [s] })
    const l = h.engine.add({ owner: OWNER, on: 'x.y', action: { type: 'notify', title: 't' } })
    h.engine.remove(l.id, { actor: 'tester' })
    expect(s.sent).toEqual([])
    const l2 = h.engine.add({ owner: OWNER, on: 'x.y', action: { type: 'notify', title: 't' } })
    h.engine.remove(l2.id, { actor: 'someone-else', reason: 'forced' })
    expect(s.sent[0]).toMatch(/\[HUB LISTENER REMOVED\]/)
  })

  it('--fork wakes a fresh fork of the target, not the target; the fork is closed after its turn unless it pinged', async () => {
    const owner = fakeSession(OWNER.claudeSessionId)
    const al = fakeSession('22222222-2222-2222-2222-222222222222', 'al')
    const h = harness({ sessions: [owner, al], forks: true })
    h.engine.start()
    const l = h.engine.add({ owner: OWNER, on: 'x.y', coalesce: 0, name: 'baba', action: { type: 'wake', prompt: 'Handle {{data.n}}', fork: true, model: 'haiku' } })
    h.bus.emit({ topic: 'x.y', source: 't', data: { n: 1 } })
    await h.engine.flushPending(l)
    expect(owner.sent).toEqual([])
    expect(h.forks.length).toBe(1)
    const f = h.forks[0]!
    expect(f.model).toBe('haiku')
    expect(f.sent.length).toBe(1)
    expect(f.sent[0]).toMatch(/^\[LISTENER FORK\] You are a fresh, single-turn fork of "tester" \(@tester\) spawned by listener L\S+ \("baba"\)/)
    expect(f.sent[0]).toMatch(new RegExp(`--session-id ${f.claudeSessionId}`))
    expect(f.sent[0]).toMatch(/\[EVENT — x\.y\] Listener/)
    expect(f.sent[0]).toMatch(/Handle 1$/)
    expect(l.stats.lastOutcome).toMatch(/fired: forked → Listener L\S+ \(fork\) on haiku \(of tester\)/)
    // turn ends → closed after the settle delay
    f.emit('hub_message', { type: 'result', sessionId: f.id, cost: 0.0123 })
    await new Promise((r) => setTimeout(r, 2_100))
    expect(f.closed).toBe(true)
    expect(h.sessions.has(f.id)).toBe(false)
    expect(h.logs.some((m) => /fork Listener L\S+ \(fork\): turn done \(\$0\.012\) — closed/.test(m))).toBe(true)

    // --as + --fork forks the named target; a fork that raised the marker stays
    const l2 = h.engine.add({ owner: OWNER, on: 'x.z', coalesce: 0, action: { type: 'wake', prompt: 'p', as: 'al', fork: true } })
    h.bus.emit({ topic: 'x.z', source: 't', data: {} })
    await h.engine.flushPending(l2)
    expect(al.sent).toEqual([])
    const f2 = h.forks[1]!
    expect(f2.agentKey).toBe(`al-${l2.id.toLowerCase()}-fork`)
    expect(f2.sent[0]).toMatch(/fork of "al" \(@al\)/)
    f2.needsAttention = { ts: 1, snippet: 'ping' }
    f2.emit('hub_message', { type: 'result', sessionId: f2.id, cost: 0 })
    await new Promise((r) => setTimeout(r, 2_100))
    expect(f2.closed).toBeUndefined()
    expect(h.logs.some((m) => /asked for Yousef — left alive/.test(m))).toBe(true)

    // a dead target is a skip, exactly like a plain wake
    const l3 = h.engine.add({ owner: OWNER, on: 'x.w', coalesce: 0, action: { type: 'wake', prompt: 'p', as: 'nobody', fork: true } })
    h.bus.emit({ topic: 'x.w', source: 't', data: {} })
    await h.engine.flushPending(l3)
    expect(l3.stats.lastOutcome).toMatch(/skipped: @nobody is not live/)
    expect(h.forks.length).toBe(2)
  }, 10_000)

  it('validates actions and topics at add time', () => {
    const h = harness()
    expect(() => h.engine.add({ owner: OWNER, on: 'x.y', action: { type: 'wake', prompt: 'p', model: 'haiku' } })).toThrow(/--model only applies to --fork/)
    expect(() => h.engine.add({ owner: OWNER, on: 'x.y', action: { type: 'wake', prompt: 'p', fork: true, model: 'not a model' } })).toThrow(/--model wants an alias/)
    expect(h.engine.add({ owner: OWNER, on: 'x.y', action: { type: 'wake', prompt: 'p', fork: true, model: 'haiku' } }).action).toEqual({ type: 'wake', prompt: 'p', fork: true, model: 'haiku' })
    expect(() => h.engine.add({ owner: OWNER, on: 'Bad Topic', action: { type: 'notify', title: 't' } })).toThrow(/bad topic/)
    expect(() => h.engine.add({ owner: OWNER, on: 'x.y', action: { type: 'post', url: 'ftp://x' } })).toThrow(/http/)
    expect(() => h.engine.add({ owner: OWNER, on: 'x.y', action: { type: 'emit', topic: 'nodots' } })).toThrow(/dotted/)
    expect(() => h.engine.add({ owner: OWNER, on: 'x.y', hours: '25-99', action: { type: 'notify', title: 't' } })).toThrow(/hours/)
    expect(() => validateAction(undefined)).toThrow(/action is required/)
    expect(h.engine.add({ owner: OWNER, on: 'x.y', action: { type: 'wake', prompt: 'p' } }).coalesceMs).toBe(60_000)
    expect(h.engine.add({ owner: OWNER, on: 'x.y', action: { type: 'run', cmd: 'true' } }).coalesceMs).toBe(0)
  })
})

describe('engine: restarts', () => {
  it('a pending batch survives a restart and flushes; a stale one is dropped', async () => {
    const s = fakeSession(OWNER.claudeSessionId)
    const h1 = harness({ sessions: [s] })
    h1.engine.start()
    const l = h1.engine.add({ owner: OWNER, on: 'x.y', coalesce: 60_000, action: { type: 'wake', prompt: 'p' } })
    h1.bus.emit({ topic: 'x.y', source: 't', data: { n: 1 } })
    h1.engine.stop() // persists pending
    expect(JSON.parse(readFileSync(join(dir, 'listeners.json'), 'utf8')).listeners[0].pending.events.length).toBe(1)
    // restart 5 minutes later
    clock += 300_000
    const h2 = harness({ sessions: [s] })
    h2.engine.start()
    const l2 = h2.engine.get(l.id)!
    expect(l2.pending?.dueAt).toBeLessThanOrEqual(clock + 1_000)
    clock += 1_100
    await h2.engine.flushPending(l2)
    expect(s.sent.length).toBe(1)
    h2.engine.stop()
    // a batch left pending for > 24 h is recorded, not delivered
    h2.bus.emit({ topic: 'x.y', source: 't', data: { n: 2 } })
    const h3pre = harness({ sessions: [s] }); h3pre.engine.start()
    h3pre.bus.emit({ topic: 'x.y', source: 't', data: { n: 3 } })
    h3pre.engine.stop()
    clock += 25 * 3_600_000
    const h3 = harness({ sessions: [s] })
    h3.engine.start()
    const l3 = h3.engine.get(l.id)!
    expect(l3.pending).toBeUndefined()
    expect(l3.outcomes[l3.outcomes.length - 1]!.stage).toBe('dropped')
    expect(l3.outcomes[l3.outcomes.length - 1]!.detail).toMatch(/stale after downtime/)
  })

  it('a batch interrupted mid-fire (journal says firing) is re-run on start', async () => {
    const s = fakeSession(OWNER.claudeSessionId)
    let hang = true
    const shell: ShellRunner = (cmd, o) => hang ? new Promise(() => {}) : Promise.resolve({ code: 0, stdout: 'ok', stderr: '', killed: false })
    const h1 = harness({ sessions: [s], shell })
    h1.engine.start()
    const l = h1.engine.add({ owner: OWNER, on: 'x.y', coalesce: 0, guard: 'slow', action: { type: 'wake', prompt: 'p' } })
    h1.bus.emit({ topic: 'x.y', source: 't', data: {} })
    void h1.engine.flushPending(l) // guard never returns — "the hub died here"
    await tick()
    expect(l.outcomes[0]!.stage).toBe('firing')
    h1.store.flush()
    // restart: the interrupted batch runs again, guard now answers
    hang = false
    const h2 = harness({ sessions: [s], shell })
    h2.engine.start()
    await tick()
    const l2 = h2.engine.get(l.id)!
    expect(l2.outcomes.map((o) => o.stage)).toEqual(['error', 'fired'])
    expect(l2.outcomes[0]!.detail).toMatch(/interrupted by hub restart/)
    expect(s.sent.length).toBe(1)
  })

  it('reassignSession moves live listeners to the parent', () => {
    const h = harness()
    h.engine.add({ owner: OWNER, on: 'x.y', action: { type: 'notify', title: 't' } })
    expect(h.engine.reassignSession(OWNER.claudeSessionId, 'parent').length).toBe(1)
    expect(h.engine.list({ claudeSessionId: 'parent' }).length).toBe(1)
  })
})

describe('engine: lifetimes (--once / --times / --expires)', () => {
  it('--once fires exactly once and removes itself; --times N counts down and persists across a restart', async () => {
    const s = fakeSession(OWNER.claudeSessionId)
    const h = harness({ sessions: [s] })
    h.engine.start()
    const once = h.engine.add({ owner: OWNER, on: 'astera.release.landed', coalesce: 0, times: 1, action: { type: 'wake', prompt: 'It landed.' } })
    const thrice = h.engine.add({ owner: OWNER, on: 'astera.release.landed', coalesce: 0, times: 3, action: { type: 'run', cmd: 'true' } })
    expect(once.timesTotal).toBe(1)
    h.bus.emit({ topic: 'astera.release.landed', source: 't', data: { sha: 'a' } })
    await h.engine.flushPending(once); await h.engine.flushPending(thrice)
    expect(s.sent.length).toBe(1)
    expect(h.engine.get(once.id)).toBeUndefined()
    expect(h.logs.some((m) => m.includes(`removed ${once.id}`) && m.includes('fired 1/1'))).toBe(true)
    expect(s.sent).toHaveLength(1) // self-removal is silent for the owner
    expect(h.engine.get(thrice.id)?.times).toBe(2)
    h.engine.stop()
    // restart: the remaining count survives
    const h2 = harness({ sessions: [s] })
    h2.engine.start()
    const t2 = h2.engine.get(thrice.id)!
    expect(t2.times).toBe(2)
    for (let i = 0; i < 2; i++) { h2.bus.emit({ topic: 'astera.release.landed', source: 't', data: { i } }); await h2.engine.flushPending(t2) }
    expect(h2.engine.get(thrice.id)).toBeUndefined()
    h2.bus.emit({ topic: 'astera.release.landed', source: 't', data: {} })
    expect(h2.engine.list().length).toBe(0)
  })

  it('a guard-skipped or dead-target batch does not consume a --once', async () => {
    const shell: ShellRunner = async () => ({ code: 1, stdout: '', stderr: '', killed: false })
    const h = harness({ shell })
    h.engine.start()
    const l = h.engine.add({ owner: OWNER, on: 'x.y', coalesce: 0, times: 1, guard: 'no', action: { type: 'wake', prompt: 'p' } })
    h.bus.emit({ topic: 'x.y', source: 't', data: {} }); await h.engine.flushPending(l)
    expect(l.times).toBe(1)
    expect(h.engine.get(l.id)).toBeDefined()
  })

  it('--expires removes the listener at the deadline, fired or not, without acting on what it held', async () => {
    const s = fakeSession(OWNER.claudeSessionId)
    const h = harness({ sessions: [s] })
    h.engine.start()
    const l = h.engine.add({ owner: OWNER, on: 'x.y', coalesce: 3_600_000, expiresAt: clock + 600_000, action: { type: 'wake', prompt: 'p' } })
    h.bus.emit({ topic: 'x.y', source: 't', data: {} })
    expect(l.pending?.events.length).toBe(1)
    clock += 600_001
    // an event after expiry sweeps it before matching
    h.bus.emit({ topic: 'x.y', source: 't', data: {} })
    expect(h.engine.get(l.id)).toBeUndefined()
    expect(s.sent).toEqual([])
    expect(h.logs.some((m) => m.includes(`removed ${l.id}`) && m.includes('expired after 0 fire(s), 1 event(s) still pending'))).toBe(true)
    // the timer path is closed too
    await h.engine.flushPending(l)
    expect(s.sent).toEqual([])
    // and the periodic sweep / start() catch one with no traffic at all
    const quiet = h.engine.add({ owner: OWNER, on: 'never.fires', expiresAt: clock + 1_000, action: { type: 'notify', title: 't' } })
    clock += 2_000
    expect(h.engine.sweepExpired().map((x) => x.id)).toEqual([quiet.id])
    h.engine.stop()
    const stale = h.engine.add({ owner: OWNER, on: 'never.fires', expiresAt: clock + 1_000, action: { type: 'notify', title: 't' } })
    h.store.flush()
    clock += 2_000
    const h2 = harness({ sessions: [s] })
    h2.engine.start()
    expect(h2.engine.get(stale.id)).toBeUndefined()
  })

  it('validates lifetimes at add time', () => {
    const h = harness()
    expect(() => h.engine.add({ owner: OWNER, on: 'x.y', times: 0, action: { type: 'notify', title: 't' } })).toThrow(/--times/)
    expect(() => h.engine.add({ owner: OWNER, on: 'x.y', times: 1.5, action: { type: 'notify', title: 't' } })).toThrow(/--times/)
    expect(() => h.engine.add({ owner: OWNER, on: 'x.y', expiresAt: clock - 1, action: { type: 'notify', title: 't' } })).toThrow(/future/)
  })
})

describe('envelope + template', () => {
  it('template fills paths from the first event', () => {
    const ev: HubEvent = { id: 'e', topic: 'mail.received', at: 0, source: 'g', hops: 0, data: { subject: 'Invoice', n: 3, nested: { a: 1 } } }
    expect(template('Re: {{data.subject}} #{{data.n}} {{data.nested}} {{data.nope}} {{topic}}', ev)).toBe('Re: Invoice #3 {"a":1}  mail.received')
  })
  it('envelope lists each event with its ref and the listener handles', () => {
    const h = harness()
    const l = h.engine.add({ owner: OWNER, on: 'mail.received', name: 'astera alerts', action: { type: 'wake', prompt: 'p' } })
    const ev: HubEvent = { id: '2026-09-21T10-00-00.000Z-aaaa', topic: 'mail.received', at: clock, source: 'g', hops: 0, data: { from: 'alerts@astera.catering', subject: 'Mirror not applied' }, ref: 'con mail read t1' }
    const env = buildEventEnvelope(l, [ev])
    expect(env).toMatch(/^\[EVENT — mail\.received\] Listener L[\w-]+ \("astera alerts"\) fired\./)
    expect(env).toMatch(/from: alerts@astera\.catering · subject: Mirror not applied · ref: con mail read t1 · id 2026-09-21T10-00-00\.000Z-aaaa/)
    expect(env).toMatch(new RegExp(`con listen pause ${l.id}`))
  })
})

describe('engine: expectations', () => {
  const geoEnter = (bus: EventBus, fence: string) => bus.emit({ topic: 'geo.enter', source: 'location', data: { fence } })!
  const geoLeave = (bus: EventBus, fence: string) => bus.emit({ topic: 'geo.leave', source: 'location', data: { fence } })!

  it('relative: --after arms, --on before the deadline satisfies (then runs), nothing fires', async () => {
    const s = fakeSession(OWNER.claudeSessionId)
    const h = harness({ sessions: [s] })
    h.engine.start()
    const l = h.engine.add({
      owner: OWNER, on: 'geo.enter', where: ['data.fence=office'],
      expect: { after: 'geo.leave', afterWhere: ['data.fence=home'], within: 90 * 60_000, then: { type: 'notify', title: 'Made it: {{data.fence}}' } },
      action: { type: 'wake', prompt: 'Left home 90 min ago, not at the office' },
    })
    geoLeave(h.bus, 'gym')                          // wrong fence — does not arm
    expect(l.expect!.pending.length).toBe(0)
    const trigger = geoLeave(h.bus, 'home')
    expect(l.expect!.pending.length).toBe(1)
    expect(l.expect!.pending[0]!.deadlineAt).toBe(clock + 90 * 60_000)
    expect(l.expect!.pending[0]!.triggerEventId).toBe(trigger.id)
    clock += 30 * 60_000
    geoEnter(h.bus, 'office')
    expect(l.expect!.pending.length).toBe(0)
    expect(l.expect!.satisfied).toBe(1)
    expect(h.notices.map((n) => n.title)).toEqual(['Made it: office'])
    expect(h.bus.list({ topic: 'expect.satisfied' }).length).toBe(1)
    clock += 90 * 60_000
    await h.engine.evaluateDue(l, 'sweep')
    expect(s.sent).toEqual([])
    expect(l.stats.fired).toBe(0)
    expect(l.outcomes.map((o) => o.stage)).toEqual(['armed', 'satisfied', 'fired'])
    expect(h.engine.get(l.id)).toBeDefined()         // has an --after: keeps waiting for the next arm
  })

  it('relative: the deadline passes → expect.missed emitted, --else runs through guard + envelope with the trigger', async () => {
    const s = fakeSession(OWNER.claudeSessionId)
    const guardSeen: string[] = []
    const shell: ShellRunner = async (_cmd, o) => { guardSeen.push(o.input); return { code: 0, stdout: 'no yoga booked, still nudge', stderr: '', killed: false } }
    const h = harness({ sessions: [s], shell })
    h.engine.start()
    const l = h.engine.add({
      owner: OWNER, on: 'geo.enter', where: ['data.fence=office'], guard: 'check.sh', name: 'commute',
      expect: { after: 'geo.leave', afterWhere: ['data.fence=home'], within: 90 * 60_000 },
      action: { type: 'wake', prompt: 'Not at the office. Trigger fence: {{data.trigger.fence}}' },
    })
    const trigger = geoLeave(h.bus, 'home')
    geoEnter(h.bus, 'gym')                          // wrong fence — does not satisfy
    clock += 90 * 60_000 + 1
    await h.engine.evaluateDue(l, 'deadline')
    const missed = h.bus.list({ topic: 'expect.missed' })
    expect(missed.length).toBe(1)
    expect(missed[0]!.data).toMatchObject({ listenerId: l.id, reason: 'deadline', acted: true, triggerEventId: trigger.id, trigger: { fence: 'home' }, confidence: 'stale' })
    expect(guardSeen.length).toBe(1)
    expect(JSON.parse(guardSeen[0]!).events[0].topic).toBe('expect.missed')
    expect(s.sent.length).toBe(1)
    expect(s.sent[0]).toMatch(/^\[EXPECTATION MISSED — expect geo\.enter where data\.fence=office within 90m after geo\.leave where data\.fence=home\] Listener L[\w-]+ \("commute"\): deadline \d\d\/\d\d \d\d:\d\d passed with no matching event\. location data is STALE/)
    expect(s.sent[0]).toMatch(/no yoga booked, still nudge/)
    expect(s.sent[0]).toMatch(/Trigger fence: home$/)
    expect(l.expect!.pending.length).toBe(0)
    expect(l.expect!.missed).toBe(1)
    expect(l.stats.fired).toBe(1)
    expect(l.stats.lastOutcome).toMatch(/^missed: /)
    // still alive, re-armable
    geoLeave(h.bus, 'home')
    expect(l.expect!.pending.length).toBe(1)
  })

  it('relative with no --after: armed at creation, one-shot — satisfied removes it, missed runs the else and removes it', async () => {
    const h = harness()
    h.engine.start()
    const wait = h.engine.add({ owner: OWNER, on: 'astera.release.landed', expect: { within: 6 * 3_600_000 }, action: { type: 'notify', title: 'release never landed' } })
    expect(wait.expect!.pending.length).toBe(1)
    expect(wait.expect!.pending[0]!.triggerEventId).toBeUndefined()
    h.bus.emit({ topic: 'astera.release.landed', source: 't', data: { sha: 'abc' } })
    expect(h.engine.get(wait.id)).toBeUndefined()
    expect(h.notices.length).toBe(0)
    const wait2 = h.engine.add({ owner: OWNER, on: 'astera.release.landed', expect: { within: 6 * 3_600_000 }, action: { type: 'notify', title: 'release never landed' } })
    clock += 6 * 3_600_000 + 1
    await h.engine.evaluateDue(wait2, 'deadline')
    expect(h.notices.map((n) => n.title)).toEqual(['release never landed'])
    expect(h.engine.get(wait2.id)).toBeUndefined()
  })

  it('absolute: at each --by tick, a matching event inside the window satisfies; none → miss; cron re-arms the next tick', async () => {
    // clock = Monday 2026-09-21 10:00Z (11:00 BST). Tuesday 19:10 local = 2026-09-22T18:10Z
    const h = harness()
    h.engine.start()
    const l = h.engine.add({ owner: OWNER, on: 'geo.enter', where: ['data.fence=buzz-gym'], expect: { by: '10 19 * * 2', window: 3 * 3_600_000 }, action: { type: 'notify', title: 'Not at the gym by 19:10' } })
    expect(l.expect!.pending.length).toBe(1)
    const tue = Date.parse('2026-09-22T18:10:00Z')
    expect(l.expect!.pending[0]!.deadlineAt).toBe(tue)
    expect(l.coalesceMs).toBe(0)
    // too early: an enter on Monday is outside the 3 h window
    geoEnter(h.bus, 'buzz-gym')
    clock = tue - 2 * 3_600_000
    geoEnter(h.bus, 'buzz-gym')                     // 17:10 — inside the window
    clock = tue + 1
    await h.engine.evaluateDue(l, 'deadline')
    expect(l.expect!.satisfied).toBe(1)
    expect(h.notices.length).toBe(0)
    expect(l.expect!.pending[0]!.deadlineAt).toBe(Date.parse('2026-09-29T18:10:00Z'))
    expect(l.expect!.matches.length).toBe(1)        // Monday's pruned (outside the window); Tuesday's kept until the window moves on
    // next week: nothing → miss
    clock = Date.parse('2026-09-29T18:10:00Z') + 1
    await h.engine.evaluateDue(l, 'deadline')
    expect(l.expect!.missed).toBe(1)
    expect(h.notices.map((n) => n.title)).toEqual(['Not at the gym by 19:10'])
    expect(h.bus.list({ topic: 'expect.missed' })[0]!.data).toMatchObject({ reason: 'deadline', acted: true, deadlineAt: Date.parse('2026-09-29T18:10:00Z') })
    expect(l.expect!.pending[0]!.deadlineAt).toBe(Date.parse('2026-10-06T18:10:00Z'))
    expect(l.expect!.matches.length).toBe(0)
  })

  it('absolute one-shot (ISO --by): default window = since creation; evaluated once then self-removed', async () => {
    const h = harness()
    h.engine.start()
    const at = clock + 2 * 3_600_000
    const l = h.engine.add({ owner: OWNER, on: 'geo.leave', where: ['data.fence=home'], expect: { by: new Date(at).toISOString() }, action: { type: 'notify', title: 'You meant to leave at 07:00' } })
    expect(l.expect!.pending[0]!.deadlineAt).toBe(at)
    clock += 3_600_000
    geoLeave(h.bus, 'home')
    clock = at + 1
    await h.engine.evaluateDue(l, 'deadline')
    expect(h.notices.length).toBe(0)
    expect(h.engine.get(l.id)).toBeUndefined()
    // +2h relative form also works, and a past --by is refused
    const l2 = h.engine.add({ owner: OWNER, on: 'x.y', expect: { by: '+2h' }, action: { type: 'notify', title: 't' } })
    expect(l2.expect!.pending[0]!.deadlineAt).toBe(clock + 2 * 3_600_000)
    expect(() => h.engine.add({ owner: OWNER, on: 'x.y', expect: { by: '2020-01-01T00:00:00Z' }, action: { type: 'notify', title: 't' } })).toThrow(/past/)
  })

  it('restart: an overdue deadline < 24 h fires the --else late; > 24 h emits expect.missed{hub down} and does not act', async () => {
    const h1 = harness()
    h1.engine.start()
    const soon = h1.engine.add({ owner: OWNER, on: 'x.y', expect: { within: 10 * 60_000 }, action: { type: 'notify', title: 'soon missed' } })
    const stale = h1.engine.add({ owner: OWNER, on: 'x.z', expect: { after: 'x.arm', within: 10 * 60_000 }, action: { type: 'notify', title: 'stale missed' } })
    h1.bus.emit({ topic: 'x.arm', source: 't', data: {} })
    expect(stale.expect!.pending.length).toBe(1)
    h1.engine.stop()
    const raw = JSON.parse(readFileSync(join(dir, 'listeners.json'), 'utf8')).listeners as Array<{ id: string; expect: { pending: Array<{ deadlineAt: number }> } }>
    expect(raw.find((x) => x.id === soon.id)!.expect.pending.length).toBe(1)
    // make `stale`'s deadline 30 h old and `soon`'s 2 h old at the restart
    clock += 2 * 3_600_000 + 10 * 60_000
    const h2pre = harness(); // no start — just to edit the file through a store
    const l = h2pre.store.get(stale.id)!
    l.expect!.pending[0]!.deadlineAt = clock - 30 * 3_600_000
    h2pre.store.persistSync()
    const h2 = harness()
    h2.engine.start()
    await until(() => h2.engine.get(soon.id) === undefined) // the one-shot's removal is the last step of its late judgement
    expect(h2.notices.map((n) => n.title)).toEqual(['soon missed'])
    const missed = h2.bus.list({ topic: 'expect.missed' })
    expect(missed.map((m) => m.data.reason).sort()).toEqual(['deadline', 'hub down'])
    expect(missed.find((m) => m.data.reason === 'hub down')!.data).toMatchObject({ listenerId: stale.id, acted: false })
    expect(missed.find((m) => m.data.reason === 'deadline')!.data.lateMs).toBe(2 * 3_600_000)
    expect(h2.engine.get(soon.id)).toBeUndefined()   // one-shot wait resolved
    const st = h2.engine.get(stale.id)!
    expect(st.expect!.pending.length).toBe(0)
    expect(st.outcomes[st.outcomes.length - 1]!.stage).toBe('missed')
    expect(st.outcomes[st.outcomes.length - 1]!.detail).toMatch(/hub came back — not acted on/)
  })

  it('restart: an absolute expectation whose tick passed during downtime is judged from its persisted matches', async () => {
    const h1 = harness()
    h1.engine.start()
    const l = h1.engine.add({ owner: OWNER, on: 'x.y', expect: { by: '10 19 * * 2', window: 3 * 3_600_000 }, action: { type: 'notify', title: 'missed tick' } })
    const tue = Date.parse('2026-09-22T18:10:00Z')
    clock = tue - 3_600_000
    h1.bus.emit({ topic: 'x.y', source: 't', data: {} })
    h1.engine.stop()
    clock = tue + 3_600_000
    const h2 = harness()
    h2.engine.start()
    await until(() => h2.engine.get(l.id)!.expect!.satisfied === 1)
    const l2 = h2.engine.get(l.id)!
    expect(l2.expect!.satisfied).toBe(1)
    expect(h2.notices.length).toBe(0)
    expect(l2.expect!.pending[0]!.deadlineAt).toBe(Date.parse('2026-09-29T18:10:00Z'))
  })

  it('test() explains would-arm / would-satisfy / would-count / ignored without acting; flush judges now', async () => {
    const h = harness()
    h.engine.start()
    const rel = h.engine.add({ owner: OWNER, on: 'geo.enter', where: ['data.fence=office'], expect: { after: 'geo.leave', afterWhere: ['data.fence=home'], within: 90 * 60_000 }, action: { type: 'notify', title: 'late' } })
    const enter: HubEvent = { id: 'e1', topic: 'geo.enter', at: clock, source: 't', hops: 0, data: { fence: 'office' } }
    const leave: HubEvent = { id: 'e2', topic: 'geo.leave', at: clock, source: 't', hops: 0, data: { fence: 'home' } }
    expect((await h.engine.test(rel.id, enter)).stage).toBe('ignored')
    expect((await h.engine.test(rel.id, leave)).stage).toBe('would-arm')
    expect((await h.engine.test(rel.id, { ...leave, data: { fence: 'gym' } })).stage).toBe('where')
    expect((await h.engine.test(rel.id, { ...leave, topic: 'chat.message' })).stage).toBe('no-match')
    expect(rel.expect!.pending.length).toBe(0)
    geoLeave(h.bus, 'home')
    expect((await h.engine.test(rel.id, enter)).stage).toBe('would-satisfy')
    const abs = h.engine.add({ owner: OWNER, on: 'geo.enter', expect: { by: '10 19 * * 2' }, action: { type: 'notify', title: 'x' } })
    expect((await h.engine.test(abs.id, enter)).stage).toBe('would-count')
    // flush = judge the nearest deadline now → miss
    const r = await h.engine.judgeNow(rel)
    expect(r.ok).toBe(true)
    expect(h.notices.map((n) => n.title)).toEqual(['late'])
    expect(rel.expect!.pending.length).toBe(0)
  })

  it('validates expectation inputs', () => {
    const h = harness()
    const base = { owner: OWNER, on: 'x.y', action: { type: 'notify', title: 't' } as const }
    expect(() => h.engine.add({ ...base, expect: {} })).toThrow(/--by .* or --within/)
    expect(() => h.engine.add({ ...base, expect: { by: '10 19 * * 2', within: 1000 } })).toThrow(/different flavours/)
    expect(() => h.engine.add({ ...base, expect: { by: 'nonsense' } })).toThrow(/--by wants/)
    expect(() => h.engine.add({ ...base, expect: { by: '99 99 * * *' } })).toThrow(/cron/)
    expect(() => h.engine.add({ ...base, expect: { within: 1000, window: 5 } })).toThrow(/--window only/)
    expect(() => h.engine.add({ ...base, expect: { within: 1000, afterWhere: ['a=b'] } })).toThrow(/--after-where needs --after/)
    expect(() => h.engine.add({ ...base, expect: { after: 'x.y', within: 1000 } })).toThrow(/satisfy itself/)
    expect(() => h.engine.add({ ...base, expect: { within: 1000, then: { type: 'wake', prompt: '' } } })).toThrow(/--wake needs a prompt/)
  })
})
