// AL's voice fork — one forked Claude Code session per live WhatsApp call.
//
// Yousef, on the first live test call (2026-09-20): "this delegate thing is
// just too many layers... make it closer to a normal forked session where you
// have direct access to all the tools you need... tell people to hold on while
// you do stuff." So the call's brain is no longer a Bedrock model behind a
// `delegate` tool; it is a real fork of the AL session (AL's persona as system
// prompt, AL's cwd → skills + memory files, the full toolset), driven turn by
// turn by the voice pipeline:
//
//   POST /voice/session   → fork AL, send the call envelope (warm turn during ringing)
//   POST /voice/turn      → one utterance in, the fork's text streamed out as NDJSON
//                           (text deltas → TTS as they arrive; tool_use → "hold on")
//   POST /voice/interrupt → barge-in: stop the fork's turn without killing it
//   POST /voice/transcript→ the fork finishes what it promised and is merged into AL
//                           (digest, like a chat fork) — the transcript is a file, not an envelope
//
// The map of live calls here is ALSO the in-progress visibility Yousef asked
// for: GET /voice/calls and /voice/status read it, `voice.call.*` events go on
// the bus, and the fork session itself is the live transcript in the Console
// Agent tab (every utterance is logged into it as a user_prompt).

import type { HubMessage } from '../protocol.js'
import type { Session } from '../session.js'
import type { AgentContext } from '../routes/agents.js'
import { closeSession, createSession, mergeIntoParent, mintAgentKey } from '../routes/agents.js'
import { getAlSession } from './al-session.js'
import { buildAlSystemPrompt } from './persona.js'
import type { EmitInput } from '../events/types.js'

export type CallDirection = 'in' | 'out'

export interface LiveTurn { role: 'user' | 'assistant' | 'tool'; text: string; t: number }

export type TurnEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'result'; ms: number; ttftMs: number | null; interrupted: boolean; chars: number; text: string }
  | { type: 'error'; message: string }

interface ActiveTurn {
  sink: ((ev: TurnEvent) => void) | null
  startedAt: number
  firstTextAt: number | null
  text: string
  interrupted: boolean
  finish: (ev: TurnEvent) => void
}

export interface LiveCall {
  callId: string
  jid: string
  phone: string
  displayName: string
  user: string | null
  direction: CallDirection
  task: string | null
  startedAt: number
  answeredAt: number | null
  fork: Session
  forkKey: string
  model: string | null
  contextMode: 'fresh' | 'inherited'
  turns: LiveTurn[]
  ttftMs: number[]
  turnMs: number[]
  ended: boolean
  chain: Promise<void>
  current: ActiveTurn | null
  detach: () => void
  /** Outbound: the opening line the warm turn produced (spoken on pickup). */
  greeting: string | null
  /** Set once the greeting was spoken, so the next utterance can tell the
   *  fork what it opened with (the fork never ran a turn for it). */
  greetingNote: string | null
  warm: ActiveTurn | null
}

export interface LiveCallInfo {
  callId: string
  jid: string
  displayName: string
  user: string | null
  direction: CallDirection
  task: string | null
  startedAt: string
  answeredAt: string | null
  elapsedMs: number
  live: boolean
  forkSessionId: string
  forkKey: string
  forkStatus: string
  model: string | null
  turns: LiveTurn[]
  ttftMs: number[]
  lastLine: string | null
}

export interface VoiceForkContext {
  agents: AgentContext
  broadcast: (msg: HubMessage) => void
  emit?: (input: EmitInput) => unknown
}

let forkCtx: VoiceForkContext | null = null
export function setVoiceForkContext(ctx: VoiceForkContext | null): void {
  forkCtx = ctx
}

const live = new Map<string, LiveCall>()

const TURN_TIMEOUT_MS = 180_000
const WARM_TIMEOUT_MS = 90_000
const CLOSING_TIMEOUT_MS = 120_000
const REAP_SETTLE_MS = 2_000

const nowIso = (ms: number) => new Date(ms).toISOString()

function emit(topic: string, data: Record<string, unknown>, key?: string): void {
  try {
    forkCtx?.emit?.({ topic, data, source: 'al-voice', ...(key ? { key } : {}) })
  } catch (err) {
    console.error('[al/voice] event emit failed:', (err as Error)?.message)
  }
}

/** The addendum to AL's persona that turns the fork into the call's brain.
 *  Fresh mode appends it to the system prompt; inherited mode carries it at
 *  the top of the envelope (a --fork-session keeps the parent's prompt). */
export function voiceForkRules(callId: string): string {
  return `# You are on a live voice call

You are a fork of AL for ONE WhatsApp voice call, callId ${callId}. Same identity, memory files, skills and tools as AL. Everything you write as plain text is spoken aloud to the caller in Yousef's cloned voice the moment you write it, so:

- Speak in short sentences. One thought per turn, then stop and let them talk. No lists, markdown, URLs, headings, code, emoji or stage directions. Say numbers, dates and times the way people say them aloud.
- Before you use any tool, first write one short natural holding phrase ("Hold on, let me check the calendar."), then use the tool, then answer. Never describe tools, prompts, sessions or systems; from the caller's side YOU are doing it.
- Reply in the language the caller speaks. You sound native in English, Arabic and German, and can speak any other language with an English accent.
- Every word is said in Yousef's voice: never say aloud what you would not send as him in text. The privacy rules in your instructions apply exactly as in chat.
- Each incoming message is what the caller just said, transcribed; transcription errors are normal, infer the meaning. A message starting "(you were interrupted after: …)" means they cut you off there — the rest of what you wrote was never heard.
- Ending the call: only when the caller asks to hang up or end the call, says goodbye, or the task is clearly complete. Then say a short goodbye and run \`con whatsapp hangup ${callId}\` (Bash) ONCE. The hangup waits for your goodbye to finish playing. If that command errors, do not retry or look for another way — say "I can't hang up from my side, go ahead" and stop. Never leave a caller who asked to hang up on the line.
- Tools cost the caller silence: one tool call per question where possible, never a chain of retries. If something fails, say so in one sentence and offer to follow up by message.
- Do not fill silence and do not end every turn with a question.

After the call ends you will get one more message asking you to finish anything you promised; that reply is not spoken.`
}

/** The fork's first message: who is on the line and why. Sent during ringing
 *  so the process, its transcript and the prompt cache are warm before the
 *  first utterance. */
export function buildCallEnvelope(opts: {
  callId: string
  direction: CallDirection
  displayName: string
  phone: string
  user: string | null
  trust: string | null
  userBody: string
  recentThread: string[]
  openThreads: string
  task: string | null
  now?: number
  rulesInline?: string | null
}): string {
  const now = opts.now ?? Date.now()
  const who = opts.user ? `${opts.displayName} (${opts.user}, +${opts.phone})` : `+${opts.phone} (not in your contacts)`
  const parts: string[] = []
  if (opts.rulesInline) parts.push(opts.rulesInline)
  parts.push(`[VOICE CALL ${opts.direction === 'in' ? 'INBOUND from' : 'OUTBOUND to'} ${who} — callId ${opts.callId}]`)
  parts.push(`## Who is on the call\n\n${who}${opts.trust === 'owner' ? ' — this is Yousef himself, your owner. No restrictions apply.' : ''}${opts.userBody ? `\n\n${opts.userBody}` : ''}`)
  if (opts.recentThread.length) parts.push(`## Recent WhatsApp thread with ${opts.displayName} (oldest first)\n\n${opts.recentThread.join('\n')}`)
  if (opts.openThreads.trim()) parts.push(`## Open threads (your memory)\n\n${opts.openThreads.trim()}`)
  if (opts.direction === 'out') {
    parts.push(`## Call task\n\nYou are placing this call. Your task: ${opts.task?.trim() || '(none given — say hello and ask how you can help)'}\n\nWhen the task is done, wrap up and say goodbye.`)
  } else {
    parts.push(`## This call\n\n${opts.displayName} is calling you. Their first words arrive as the next message; if they are silent you will get "(The caller has said nothing for two seconds.)" — greet them briefly then.`)
  }
  parts.push(`Local time now: ${new Date(now).toLocaleString('en-GB', { timeZone: 'Europe/London' })}.`)
  if (opts.direction === 'out') {
    // The opening line is generated while the phone rings and spoken the
    // instant they pick up: a turn after pickup costs ~2 s of TTFT plus a
    // sentence of buffering, and by then the callee has said "Hello?" (the
    // Nica call, 20 Sept: the greeting was barged in on before its first word).
    parts.push(`The phone is ringing. Reply with ONLY your opening line — the exact words you will say the instant ${opts.displayName} picks up: greet them by name and say in one short sentence why you are calling. No preamble, no quotes, nothing else; it is spoken verbatim. Their reply arrives as the next message.`)
  } else {
    parts.push('The call is connecting. Reply with exactly the word: ready')
  }
  return parts.join('\n\n---\n\n')
}

export function getLiveCall(callId: string): LiveCall | undefined {
  return live.get(callId)
}

export function liveCallInfo(c: LiveCall): LiveCallInfo {
  const last = c.turns.filter((t) => t.role !== 'tool').slice(-1)[0]
  return {
    callId: c.callId,
    jid: c.jid,
    displayName: c.displayName,
    user: c.user,
    direction: c.direction,
    task: c.task,
    startedAt: nowIso(c.startedAt),
    answeredAt: c.answeredAt ? nowIso(c.answeredAt) : null,
    elapsedMs: Date.now() - (c.answeredAt ?? c.startedAt),
    live: c.answeredAt !== null && !c.ended,
    forkSessionId: c.fork.id,
    forkKey: c.forkKey,
    forkStatus: c.fork.status,
    model: c.model,
    turns: c.turns,
    ttftMs: c.ttftMs,
    lastLine: last ? `${last.role === 'user' ? c.displayName : 'AL'}: ${last.text}` : null,
  }
}

export function getLiveCalls(): LiveCallInfo[] {
  return [...live.values()].filter((c) => !c.ended).map(liveCallInfo)
}

function record(c: LiveCall, role: LiveTurn['role'], text: string): void {
  const t = Date.now() - (c.answeredAt ?? c.startedAt)
  c.turns.push({ role, text, t })
  emit('voice.call.turn', { callId: c.callId, jid: c.jid, displayName: c.displayName, role, text, t })
}

/** Fork AL for a call and send the envelope as its warm turn. Throws when AL
 *  is not up (the pipeline then rejects/does not dial). */
export async function startCallFork(opts: {
  callId: string
  jid: string
  phone: string
  displayName: string
  user: string | null
  direction: CallDirection
  task: string | null
  envelope: string
  model?: string | null
  contextMode?: 'fresh' | 'inherited'
}): Promise<LiveCall> {
  if (!forkCtx) throw new Error('voice fork context not wired')
  const al = getAlSession()
  if (!al?.claudeSessionId) throw new Error('AL session not bootstrapped')
  if (live.has(opts.callId)) throw new Error(`call ${opts.callId} already has a fork`)
  const ctx = forkCtx.agents
  const mode = opts.contextMode ?? 'fresh'
  const forkKey = mintAgentKey(ctx, `${al.agentKey ?? 'al'} call ${opts.callId.slice(0, 8)} fork`)
  const name = `Call with ${opts.displayName} (fork)`
  const systemPrompt = mode === 'fresh' ? `${await buildAlSystemPrompt()}\n\n${voiceForkRules(opts.callId)}` : undefined
  const fork = createSession(ctx, {
    prompt: '',
    cwd: al.cwd,
    ...(mode === 'inherited'
      ? { resume: al.claudeSessionId, fork: true as const }
      : { pinSessionId: true as const, systemPrompt }),
    forkContext: mode,
    silent: true,
    name,
    parentClaudeSessionId: al.claudeSessionId,
    agentKey: forkKey,
    project: al.project,
    areas: al.areas,
    cacheTtl: '1h',
    ...(opts.model ? { modelOverride: opts.model } : {}),
  })
  const created = { type: 'session_created' as const, sessionId: fork.id, cwd: fork.cwd, prompt: '', name }
  fork.logMessage(created)
  forkCtx.broadcast(created)
  console.log(`[al/voice] ${opts.callId}: forked AL → "${name}" (${forkKey}, ${mode}${opts.model ? `, model ${opts.model}` : ''})`)
  return registerCall(fork, { ...opts, forkKey, model: opts.model ?? null, contextMode: mode })
}

/** Bind an already-created fork session to a call: the message router, the
 *  turn chain and the warm turn. Split from startCallFork so tests can drive
 *  the machinery with a stub session. */
export function registerCall(fork: Session, opts: {
  callId: string
  jid: string
  phone: string
  displayName: string
  user: string | null
  direction: CallDirection
  task: string | null
  envelope: string
  forkKey: string
  model: string | null
  contextMode: 'fresh' | 'inherited'
}): LiveCall {
  const call: LiveCall = {
    callId: opts.callId,
    jid: opts.jid,
    phone: opts.phone,
    displayName: opts.displayName,
    user: opts.user,
    direction: opts.direction,
    task: opts.task,
    startedAt: Date.now(),
    answeredAt: null,
    fork,
    forkKey: opts.forkKey,
    model: opts.model,
    contextMode: opts.contextMode,
    turns: [],
    ttftMs: [],
    turnMs: [],
    ended: false,
    chain: Promise.resolve(),
    current: null,
    detach: () => {},
    greeting: null,
    greetingNote: null,
    warm: null,
  }
  const onMsg = (m: HubMessage) => routeForkMessage(call, m)
  fork.on('hub_message', onMsg)
  call.detach = () => { try { fork.off('hub_message', onMsg) } catch { /* noop */ } }
  live.set(call.callId, call)

  // Warm turn: envelope in; "ready" out (inbound) or the opening line
  // (outbound — kept as call.greeting and spoken on pickup, see runCue).
  // Nothing is spoken by the turn itself; the first real utterance queues
  // behind it.
  call.chain = call.chain.then(() => sendTurn(call, opts.envelope, null, WARM_TIMEOUT_MS, null, (turn) => { call.warm = turn })).then((ev) => {
    call.warm = null
    if (call.direction === 'out' && ev.type === 'result' && ev.text.trim()) call.greeting = cleanGreeting(ev.text)
  })
  emit('voice.call.started', {
    callId: call.callId, jid: call.jid, displayName: call.displayName, user: call.user, direction: call.direction,
    task: call.task, forkSessionId: fork.id, forkKey: opts.forkKey,
  }, `${call.callId}:started`)
  return call
}

/** One fork turn: text in, events to `sink` until the fork's result. Resolves
 *  with the terminal event. A null `sink` = a silent turn (envelope, closing)
 *  whose text is not spoken and not recorded. `logAsPrompt` = the caller's
 *  own words, shown in the fork's transcript as a user_prompt (cues are sent
 *  without one). */
function sendTurn(call: LiveCall, text: string, sink: ((ev: TurnEvent) => void) | null, timeoutMs: number, logAsPrompt: string | null, onStart?: (turn: ActiveTurn) => void): Promise<TurnEvent> {
  return new Promise<TurnEvent>((resolve) => {
    if (call.fork.status === 'ended') {
      const ev: TurnEvent = { type: 'error', message: 'voice fork has ended' }
      sink?.(ev)
      resolve(ev)
      return
    }
    const turn: ActiveTurn = {
      sink,
      startedAt: Date.now(),
      firstTextAt: null,
      text: '',
      interrupted: false,
      finish: () => {},
    }
    const timer = setTimeout(() => turn.finish({ type: 'error', message: `fork turn timed out after ${Math.round(timeoutMs / 1000)} s` }), timeoutMs)
    let settled = false
    turn.finish = (ev: TurnEvent) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (call.current === turn) call.current = null
      // turn.sink, not the parameter: runCue attaches a sink to a warm turn
      // that is still generating so the opening line streams out live.
      if (turn.sink && turn.text.trim()) record(call, 'assistant', turn.text.trim())
      if (ev.type === 'result') {
        call.turnMs.push(ev.ms)
        if (ev.ttftMs !== null) call.ttftMs.push(ev.ttftMs)
      }
      turn.sink?.(ev)
      resolve(ev)
    }
    call.current = turn
    onStart?.(turn)
    if (logAsPrompt) {
      const promptMsg = { type: 'user_prompt' as const, sessionId: call.fork.id, content: logAsPrompt }
      try {
        forkCtx?.broadcast(promptMsg)
        call.fork.logMessage(promptMsg)
      } catch { /* display only */ }
    }
    try {
      call.fork.sendMessage(text)
    } catch (err) {
      turn.finish({ type: 'error', message: `sendMessage failed: ${(err as Error)?.message ?? err}` })
    }
  })
}

function routeForkMessage(call: LiveCall, m: HubMessage): void {
  if (!('sessionId' in m) || m.sessionId !== call.fork.id) return
  const turn = call.current
  switch (m.type) {
    case 'text_delta': {
      if (!turn) return
      if (turn.firstTextAt === null) turn.firstTextAt = Date.now()
      turn.text += m.content
      turn.sink?.({ type: 'text', text: m.content })
      return
    }
    case 'tool_use': {
      if (turn) {
        // Text so far is one spoken segment; the tool splits it from what follows.
        if (turn.sink && turn.text.trim()) record(call, 'assistant', turn.text.trim())
        turn.text = ''
        turn.sink?.({ type: 'tool', name: m.toolName })
      }
      const summary = m.toolName === 'Bash' && typeof m.input?.command === 'string'
        ? `Bash: ${String(m.input.command).slice(0, 120)}`
        : m.toolName
      record(call, 'tool', summary)
      return
    }
    case 'result': {
      if (!turn) return
      turn.finish({
        type: 'result',
        ms: Date.now() - turn.startedAt,
        ttftMs: turn.firstTextAt !== null ? turn.firstTextAt - turn.startedAt : (typeof m.ttftMs === 'number' ? m.ttftMs : null),
        interrupted: turn.interrupted,
        chars: turn.text.length,
        text: turn.text,
      })
      return
    }
    case 'error': {
      turn?.finish({ type: 'error', message: m.message })
      return
    }
    case 'session_ended': {
      turn?.finish({ type: 'error', message: 'voice fork session ended' })
      if (!call.ended) {
        console.warn(`[al/voice] ${call.callId}: fork ended mid-call`)
      }
      return
    }
    default:
      return
  }
}

/** The caller said something. Streams the fork's reply to `sink`; resolves at
 *  the terminal event. Turns are serialised per call: an utterance arriving
 *  while the fork is mid-turn waits (call `interruptCall` first for a
 *  barge-in). */
export function runTurn(callId: string, text: string, sink: (ev: TurnEvent) => void, opts: { interruptedAfter?: string | null } = {}): Promise<TurnEvent> {
  const call = live.get(callId)
  if (!call) {
    const ev: TurnEvent = { type: 'error', message: `no live call ${callId}` }
    sink(ev)
    return Promise.resolve(ev)
  }
  if (call.ended) {
    const ev: TurnEvent = { type: 'error', message: 'call already ended' }
    sink(ev)
    return Promise.resolve(ev)
  }
  if (call.answeredAt === null) call.answeredAt = Date.now()
  const utterance = text.trim()
  record(call, 'user', utterance)
  const notes: string[] = []
  if (call.greetingNote) {
    notes.push(`(The call was answered and you opened with: "${call.greetingNote}")`)
    call.greetingNote = null
  }
  if (opts.interruptedAfter) notes.push(`(you were interrupted after: "${opts.interruptedAfter.trim()}")`)
  const body = notes.length ? `${notes.join('\n')}\n${utterance}` : utterance
  const run = call.chain.then(() => {
    if (call.ended) {
      const ev: TurnEvent = { type: 'error', message: 'call already ended' }
      sink(ev)
      return ev
    }
    return sendTurn(call, body, sink, TURN_TIMEOUT_MS, utterance)
  })
  call.chain = run.then(() => undefined, () => undefined)
  return run
}

export const ANSWERED_CUE = '(The call was answered.)'

/** The opening line as the fork wrote it, minus quoting/markdown it might add. */
export function cleanGreeting(text: string): string {
  return text.trim().replace(/^["'“]+|["'”]+$/g, '').replace(/^\*+|\*+$/g, '').trim()
}

/** A cue that is not the caller's words (call answered, silence) — spoken
 *  reply, but not logged as a user_prompt. The answered cue on an outbound
 *  call does not run a turn: it speaks the opening line the warm turn wrote
 *  (streaming it live if that turn is still generating), and the fork is told
 *  what it said with the caller's first utterance. */
export function runCue(callId: string, cue: string, sink: (ev: TurnEvent) => void): Promise<TurnEvent> {
  const call = live.get(callId)
  if (!call) {
    const ev: TurnEvent = { type: 'error', message: `no live call ${callId}` }
    sink(ev)
    return Promise.resolve(ev)
  }
  if (call.ended) {
    const ev: TurnEvent = { type: 'error', message: 'call already ended' }
    sink(ev)
    return Promise.resolve(ev)
  }
  if (call.answeredAt === null) call.answeredAt = Date.now()
  if (call.direction === 'out' && cue.trim() === ANSWERED_CUE) {
    if (call.greeting) {
      const text = call.greeting
      record(call, 'assistant', text)
      call.greetingNote = text
      sink({ type: 'text', text })
      const ev: TurnEvent = { type: 'result', ms: 0, ttftMs: 0, interrupted: false, chars: text.length, text }
      sink(ev)
      return Promise.resolve(ev)
    }
    const warm = call.warm
    if (warm && call.current === warm) {
      // Still being written: stream what exists, then the rest as it arrives.
      const started = Date.now()
      if (warm.text) sink({ type: 'text', text: warm.text })
      warm.sink = (ev) => {
        if (ev.type === 'result') {
          const text = cleanGreeting(ev.text)
          call.greetingNote = text || null
          sink({ ...ev, ms: Date.now() - started, ttftMs: 0, text })
        } else sink(ev)
      }
      return call.chain.then(() => ({ type: 'result', ms: Date.now() - started, ttftMs: 0, interrupted: false, chars: 0, text: call.greetingNote ?? '' }) as TurnEvent)
    }
    // Warm turn produced nothing usable: fall through to a normal cue turn.
  }
  const run = call.chain.then(() => (call.ended
    ? (sink({ type: 'error', message: 'call already ended' }), { type: 'error', message: 'call already ended' } as TurnEvent)
    : sendTurn(call, cue, sink, TURN_TIMEOUT_MS, null)))
  call.chain = run.then(() => undefined, () => undefined)
  return run
}

/** Barge-in: stop whatever the fork is doing right now. */
export async function interruptCall(callId: string): Promise<{ ok: boolean; method: string }> {
  const call = live.get(callId)
  if (!call) return { ok: false, method: 'no such call' }
  if (call.current) call.current.interrupted = true
  const method = await call.fork.softInterrupt()
  return { ok: true, method }
}

/** The call is over. A call that actually happened is handed back like any
 *  chat fork (Yousef, 20 Sept: "the fork should hand back to the parent like a
 *  chat fork" — the parent must NOT get the transcript the fork already has):
 *  `mergeIntoParent` sends `closing` as the fork's last turn (finish what was
 *  promised, then a digest), injects `[MERGE — fork … folded in]` + digest into
 *  AL, and closes the fork. A call with no conversation (no answer, declined)
 *  is just closed. If the merge cannot run (parent gone, fork ended) the fork
 *  is closed and the transcript file remains the record. Resolves once the
 *  hand-back has been scheduled (not finished). */
export async function endCallFork(callId: string, closing: string, opts: { merge?: boolean } = {}): Promise<{ forkSessionId: string; forkKey: string; turns: LiveTurn[]; ttftMs: number[]; turnMs: number[]; merging: boolean } | null> {
  const call = live.get(callId)
  if (!call) return null
  call.ended = true
  if (call.current) {
    call.current.interrupted = true
    await call.fork.softInterrupt().catch(() => 'idle')
  }
  emit('voice.call.ended', {
    callId: call.callId, jid: call.jid, displayName: call.displayName, direction: call.direction,
    durationMs: call.answeredAt ? Date.now() - call.answeredAt : 0, turns: call.turns.length, forkSessionId: call.fork.id,
  }, `${call.callId}:ended`)
  const merge = opts.merge !== false && call.turns.some((t) => t.role !== 'tool')
  const summary = { forkSessionId: call.fork.id, forkKey: call.forkKey, turns: [...call.turns], ttftMs: [...call.ttftMs], turnMs: [...call.turnMs], merging: merge }
  const ctx = forkCtx
  const drop = () => {
    call.detach()
    live.delete(call.callId)
    if (!ctx || call.fork.status === 'ended') return
    if (call.fork.needsAttention) {
      console.log(`[al/voice] ${call.callId}: fork asked for Yousef — left alive (${call.forkKey})`)
      return
    }
    closeSession(ctx.agents, call.fork)
    console.log(`[al/voice] ${call.callId}: fork closed (${call.forkKey})`)
  }
  call.chain = call.chain.then(async () => {
    if (!ctx || call.fork.status === 'ended' || !merge) { drop(); return }
    const res = await mergeIntoParent(ctx.agents, call.fork.id, 180_000, { request: closing })
    if (res.ok) {
      call.detach()
      live.delete(call.callId)
      console.log(`[al/voice] ${call.callId}: fork ${call.forkKey} merged into AL (${res.summary?.length ?? 0}-char digest)`)
      return
    }
    console.warn(`[al/voice] ${call.callId}: merge failed (${res.error}) — closing the fork; transcript file is the record`)
    drop()
  }).catch((err) => {
    console.error(`[al/voice] ${call.callId}: hand-back failed:`, (err as Error)?.message)
    drop()
  })
  return summary
}

/** Test/inspection hook. */
export function _resetLiveCalls(): void {
  for (const c of live.values()) c.detach()
  live.clear()
}
