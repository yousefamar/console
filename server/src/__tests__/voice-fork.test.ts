// AL's voice fork (^ripe-elk): the per-call turn machinery over a stub
// session — serialised turns, streamed text deltas, tool → "hold on" cue,
// barge-in via the soft interrupt, the live-call view, the closing turn and
// the reap. createSession itself is out of scope (a real spawn).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('../routes/agents.js', () => ({ closeSession: vi.fn(), createSession: vi.fn(), mintAgentKey: vi.fn(() => 'k') }))
vi.mock('../al/al-session.js', () => ({ getAlSession: () => null }))
vi.mock('../al/persona.js', () => ({ buildAlSystemPrompt: async () => 'AL' }))

import { closeSession } from '../routes/agents.js'
import {
  registerCall, runTurn, runCue, interruptCall, endCallFork, getLiveCalls, getLiveCall, setVoiceForkContext, _resetLiveCalls,
  ANSWERED_CUE, cleanGreeting, type TurnEvent,
} from '../al/voice-fork.js'
import type { Session } from '../session.js'

class StubSession extends EventEmitter {
  id = 'hub-fork-1'
  status: 'running' | 'idle' | 'ended' = 'idle'
  needsAttention: unknown = null
  sent: string[] = []
  logged: unknown[] = []
  interrupts = 0
  sendMessage(text: string) { this.sent.push(text); this.status = 'running' }
  logMessage(m: unknown) { this.logged.push(m) }
  async softInterrupt() { this.interrupts += 1; return 'control' as const }
  kill() { this.status = 'ended' }
  // what the CLI would stream back
  delta(t: string) { this.emit('hub_message', { type: 'text_delta', sessionId: this.id, content: t }) }
  tool(name: string, input: Record<string, unknown> = {}) { this.emit('hub_message', { type: 'tool_use', sessionId: this.id, toolUseId: 'tu1', toolName: name, input }) }
  result(ttftMs?: number) { this.status = 'idle'; this.emit('hub_message', { type: 'result', sessionId: this.id, cost: 0, tokens: {}, duration: 1, sessionIdClaude: 'c', ttftMs }) }
}

// Turn plumbing is promise chains only; ten microtask hops settle it without touching timers.
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

let stub: StubSession
let broadcasts: unknown[]
let events: Array<{ topic: string; data: Record<string, unknown> }>
const closed = () => vi.mocked(closeSession).mock.calls.map((c) => c[1])

beforeEach(() => {
  stub = new StubSession()
  broadcasts = []
  events = []
  vi.mocked(closeSession).mockClear()
  setVoiceForkContext({
    agents: { sessions: new Map(), clients: new Set() } as never,
    broadcast: (m) => broadcasts.push(m),
    emit: (e) => { events.push({ topic: e.topic, data: e.data }); return null },
  })
})
afterEach(() => {
  _resetLiveCalls()
  vi.useRealTimers()
})

function register(callId = 'CALLABC123', direction: 'in' | 'out' = 'out') {
  return registerCall(stub as unknown as Session, {
    callId, jid: '447845443890@s.whatsapp.net', phone: '447845443890', displayName: 'Yousef', user: 'yousef',
    direction, task: 'Say hi', envelope: '[VOICE CALL …] ready?', forkKey: 'al-call-callabc1-fork', model: null, contextMode: 'fresh',
  })
}

/** Warm turn done: outbound calls answer it with the opening line. */
async function warmDone(text = 'Hi Yousef, it is AL.') {
  await flush(); stub.delta(text); stub.result(); await flush()
}

describe('registerCall + warm turn', () => {
  it('sends the envelope as the first (silent) turn and shows the call as not yet live', async () => {
    register()
    await flush()
    expect(stub.sent).toEqual(['[VOICE CALL …] ready?'])
    expect(stub.logged).toEqual([]) // envelope is not a user_prompt
    const [info] = getLiveCalls()
    expect(info.live).toBe(false)
    expect(info.forkSessionId).toBe('hub-fork-1')
    expect(events.map((e) => e.topic)).toEqual(['voice.call.started'])
  })
})

describe('runTurn', () => {
  it('queues behind the warm turn, logs the utterance as a user_prompt, streams deltas and ends on result', async () => {
    register()
    await flush()
    const got: TurnEvent[] = []
    const p = runTurn('CALLABC123', 'Hello?', (ev) => got.push(ev))
    await flush()
    expect(stub.sent).toHaveLength(1) // still the warm turn
    stub.delta('ready'); stub.result()
    await flush()
    expect(stub.sent[1]).toBe('Hello?')
    expect(stub.logged.at(-1)).toMatchObject({ type: 'user_prompt', content: 'Hello?' })
    expect(broadcasts.at(-1)).toMatchObject({ type: 'user_prompt', sessionId: 'hub-fork-1', content: 'Hello?' })
    stub.delta('Hi '); stub.delta('Yousef.'); stub.result(420)
    const done = await p
    expect(got.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['Hi ', 'Yousef.'])
    expect(done).toMatchObject({ type: 'result', interrupted: false, chars: 10 })
    expect((done as { ttftMs: number }).ttftMs).toBeGreaterThanOrEqual(0)
    const info = getLiveCalls()[0]
    expect(info.live).toBe(true)
    expect(info.turns.map((t) => [t.role, t.text])).toEqual([['user', 'Hello?'], ['assistant', 'Hi Yousef.']])
    expect(info.lastLine).toBe('AL: Hi Yousef.')
    expect(events.filter((e) => e.topic === 'voice.call.turn').map((e) => e.data.role)).toEqual(['user', 'assistant'])
  })

  it('a tool call splits the spoken text and surfaces as a tool event (the pipeline speaks a filler if nothing was said)', async () => {
    register(); await flush(); stub.result(); await flush()
    const got: TurnEvent[] = []
    const p = runTurn('CALLABC123', "What's on tomorrow?", (ev) => got.push(ev))
    await flush()
    stub.delta('Hold on, let me check.'); stub.tool('Bash', { command: 'con cal events --from tomorrow' })
    stub.delta('Just the ten a.m. with Callum.'); stub.result()
    await p
    expect(got.map((e) => e.type)).toEqual(['text', 'tool', 'text', 'result'])
    const turns = getLiveCall('CALLABC123')!.turns.map((t) => `${t.role}: ${t.text}`)
    expect(turns).toEqual([
      "user: What's on tomorrow?",
      'assistant: Hold on, let me check.',
      'tool: Bash: con cal events --from tomorrow',
      'assistant: Just the ten a.m. with Callum.',
    ])
  })

  it('an interrupted utterance is prefixed with what was heard, and interruptCall soft-interrupts the fork', async () => {
    register(); await flush(); stub.result(); await flush()
    const got: TurnEvent[] = []
    const p1 = runTurn('CALLABC123', 'Tell me a long story', (ev) => got.push(ev))
    await flush()
    stub.delta('Once upon a time ')
    const irq = await interruptCall('CALLABC123')
    expect(irq).toEqual({ ok: true, method: 'control' })
    expect(stub.interrupts).toBe(1)
    stub.result() // the CLI ends the turn
    const d1 = await p1
    expect(d1).toMatchObject({ type: 'result', interrupted: true })
    const p2 = runTurn('CALLABC123', 'Stop. What time is it?', () => {}, { interruptedAfter: 'Once upon a time' })
    await flush()
    expect(stub.sent.at(-1)).toBe('(you were interrupted after: "Once upon a time")\nStop. What time is it?')
    expect(stub.logged.at(-1)).toMatchObject({ content: 'Stop. What time is it?' }) // the SPA sees the clean utterance
    stub.delta('Half past eight.'); stub.result()
    await p2
  })

  it('cues are spoken but not logged as prompts; unknown calls error out', async () => {
    register('CALLABC123', 'in'); await flush(); stub.result(); await flush()
    const p = runCue('CALLABC123', '(The caller has said nothing for two seconds.)', () => {})
    await flush()
    expect(stub.sent.at(-1)).toBe('(The caller has said nothing for two seconds.)')
    expect(stub.logged.find((m) => (m as { content?: string }).content === '(The caller has said nothing for two seconds.)')).toBeUndefined()
    stub.delta('Hi Yousef, it is AL.'); stub.result()
    await p
    const got: TurnEvent[] = []
    await runTurn('NOPE', 'x', (ev) => got.push(ev))
    expect(got).toEqual([{ type: 'error', message: 'no live call NOPE' }])
  })
})

describe('outbound opening line', () => {
  it('the warm turn\'s text is the greeting; the answered cue speaks it instantly without a fork turn, and the first utterance tells the fork', async () => {
    register()
    await warmDone('"Hey Yousef, it\'s AL — quick one about dinner."')
    expect(getLiveCall('CALLABC123')!.greeting).toBe("Hey Yousef, it's AL — quick one about dinner.")
    const got: TurnEvent[] = []
    const done = await runCue('CALLABC123', ANSWERED_CUE, (ev) => got.push(ev))
    expect(stub.sent).toHaveLength(1) // no second message to the fork
    expect(got.map((e) => e.type)).toEqual(['text', 'result'])
    expect(done).toMatchObject({ type: 'result', ttftMs: 0, text: "Hey Yousef, it's AL — quick one about dinner." })
    expect(getLiveCall('CALLABC123')!.turns).toEqual([expect.objectContaining({ role: 'assistant', text: "Hey Yousef, it's AL — quick one about dinner." })])
    const p = runTurn('CALLABC123', 'Oh hi. Pasta?', () => {})
    await flush()
    expect(stub.sent.at(-1)).toBe('(The call was answered and you opened with: "Hey Yousef, it\'s AL — quick one about dinner.")\nOh hi. Pasta?')
    stub.delta('Pasta it is.'); stub.result()
    await p
    // the note is used once
    const p2 = runTurn('CALLABC123', 'Bye', () => {})
    await flush()
    expect(stub.sent.at(-1)).toBe('Bye')
    stub.delta('Bye.'); stub.result(); await p2
  })

  it('a pickup while the opening line is still being written streams it live', async () => {
    register(); await flush()
    stub.delta('Hey Yousef, ')
    const got: TurnEvent[] = []
    const p = runCue('CALLABC123', ANSWERED_CUE, (ev) => got.push(ev))
    await flush()
    expect(got).toEqual([{ type: 'text', text: 'Hey Yousef, ' }])
    stub.delta('it is AL.'); stub.result()
    const done = await p
    expect(got.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['Hey Yousef, ', 'it is AL.'])
    expect(done).toMatchObject({ type: 'result', text: 'Hey Yousef, it is AL.' })
    expect(stub.sent).toHaveLength(1)
    expect(getLiveCall('CALLABC123')!.greetingNote).toBe('Hey Yousef, it is AL.')
  })

  it('no opening line (empty warm reply) falls back to a normal cue turn', async () => {
    register(); await flush(); stub.result(); await flush()
    const p = runCue('CALLABC123', ANSWERED_CUE, () => {})
    await flush()
    expect(stub.sent.at(-1)).toBe(ANSWERED_CUE)
    stub.delta('Hi.'); stub.result(); await p
  })

  it('cleanGreeting strips quotes and emphasis', () => {
    expect(cleanGreeting('  "Hi there."  ')).toBe('Hi there.')
    expect(cleanGreeting('**Hi there.**')).toBe('Hi there.')
    expect(cleanGreeting('“Hi.”')).toBe('Hi.')
  })
})

describe('endCallFork', () => {
  it('sends the closing turn after in-flight turns, then reaps the fork and drops it from the live list', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    register(); await flush(); stub.result(); await flush()
    const summary = await endCallFork('CALLABC123', '[CALL ENDED]')
    expect(summary).toMatchObject({ forkSessionId: 'hub-fork-1', forkKey: 'al-call-callabc1-fork' })
    expect(getLiveCalls()).toEqual([]) // ended calls are hidden immediately
    expect(events.at(-1)?.topic).toBe('voice.call.ended')
    await flush()
    expect(stub.sent.at(-1)).toBe('[CALL ENDED]')
    stub.delta('Nothing to do.'); stub.result()
    await flush()
    expect(closed()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2_100)
    expect(closed()).toEqual([stub])
    expect(getLiveCall('CALLABC123')).toBeUndefined()
  })

  it('a fork that raised the attention marker is left alive for Yousef', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    register(); await flush(); stub.result(); await flush()
    await endCallFork('CALLABC123', '[CALL ENDED]')
    await flush()
    stub.needsAttention = { at: 1 }
    stub.result()
    await vi.advanceTimersByTimeAsync(2_100)
    expect(closed()).toEqual([])
  })

  it('a turn arriving after the end errors instead of reaching the fork', async () => {
    register(); await flush(); stub.result(); await flush()
    await endCallFork('CALLABC123', '[CALL ENDED]')
    const got: TurnEvent[] = []
    await runTurn('CALLABC123', 'still there?', (ev) => got.push(ev))
    expect(got).toEqual([{ type: 'error', message: 'call already ended' }])
  })
})
