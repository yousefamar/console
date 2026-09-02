// Ring pipeline: archive → transcript (ring's, else hub STT) → route (rules,
// else LLM, else fallback agent) → execute → notify. Everything that touches
// the hub (sessions, Spotify, push, STT) arrives through RingCtx so this
// stays unit-testable with stubs.

import type { RingStore, RingRecording } from './store.js'
import { routeByRules, describeCommand, type RingAgent, type RingCommand } from './router.js'

export interface RingCtx {
  store: RingStore
  agents: () => RingAgent[]
  /** Resolve an agentKey to a live session (the fallback target). */
  sessionForKey: (agentKey: string) => RingAgent | null
  /** Inject + auto-send into a session. False if the session is not live. */
  inject: (sessionId: string, content: string) => boolean
  music: {
    play: (query?: string) => Promise<string>
    pause: () => Promise<string>
    next: () => Promise<string>
    previous: () => Promise<string>
  }
  transcribe: (audio: Buffer, contentType: string) => Promise<string | null>
  classify: (text: string, agents: RingAgent[]) => Promise<RingCommand | null>
  notify: (msg: { title: string; body: string; sessionId?: string; id: string }) => void
  log: (msg: string) => void
}

export interface RingDelivery {
  transcription: string | null
  audio: { data: Buffer; contentType: string } | null
  recordedAt: number | null
  client: string | null
}

/** Envelope the target agent sees — task-framed like the WhatsApp inbound. */
export function buildRingEnvelope(message: string, recordingId: string): string {
  return `[RING — voice command from Yousef's Pebble Index 01, recording ${recordingId}]\n${message}`
}

export async function processDelivery(ctx: RingCtx, d: RingDelivery): Promise<RingRecording> {
  const receivedAt = Date.now()
  const recordedAt = d.recordedAt ?? receivedAt
  const id = ctx.store.mintId(recordedAt)

  let transcription = d.transcription?.trim() || null
  let source: RingRecording['transcriptionSource'] = transcription ? 'ring' : null
  if (!transcription && d.audio) {
    transcription = (await ctx.transcribe(d.audio.data, d.audio.contentType))?.trim() || null
    if (transcription) source = 'hub-stt'
  }

  const rec = ctx.store.save({
    id, recordedAt, receivedAt, client: d.client,
    transcription, transcriptionSource: source,
    audio: d.audio,
  })
  ctx.log(`[ring] ${id} archived (${d.audio ? `${d.audio.data.length} B audio, ` : ''}transcript=${source ?? 'none'})`)

  if (!transcription) {
    ctx.notify({ id, title: 'Ring: no transcript', body: d.audio ? 'Recording archived but nothing could be transcribed.' : 'Empty delivery — nothing to route.' })
    return rec
  }

  const agents = ctx.agents()
  const cfg = ctx.store.config()
  let command: RingCommand | null = null
  let via: NonNullable<RingRecording['route']>['via'] = 'none'
  let rule: string | undefined

  const hit = routeByRules(transcription, agents)
  if (hit) { command = hit.command; via = 'rule'; rule = hit.rule }
  else if (cfg.llmFallback) {
    const guess = await ctx.classify(transcription, agents)
    if (guess && guess.kind !== 'unknown') { command = guess; via = 'llm' }
  }
  if (!command && cfg.fallbackAgent) {
    const target = ctx.sessionForKey(cfg.fallbackAgent)
    if (target) { command = { kind: 'agent', targetId: target.id, targetName: target.name, message: transcription }; via = 'default' }
  }
  if (!command) command = { kind: 'unknown', text: transcription }

  const outcome = await execute(ctx, command, id)
  rec.route = { command, via, ...(rule ? { rule } : {}), ok: outcome.ok, ...(outcome.detail ? { detail: outcome.detail } : {}) }
  ctx.store.update(rec)
  ctx.log(`[ring] ${id} ${via}${rule ? `/${rule}` : ''} ${describeCommand(command)} → ${outcome.ok ? 'ok' : 'FAILED'}${outcome.detail ? ` (${outcome.detail})` : ''}`)

  ctx.notify({
    id,
    title: outcome.ok ? `Ring ${command.kind === 'agent' ? `→ ${command.targetName}` : `· ${command.kind}`}` : 'Ring: not delivered',
    body: outcome.ok ? (command.kind === 'agent' ? command.message : describeCommand(command)) : `${describeCommand(command)} — ${outcome.detail ?? 'failed'}`,
    ...(command.kind === 'agent' ? { sessionId: command.targetId } : {}),
  })
  return rec
}

async function execute(ctx: RingCtx, c: RingCommand, recordingId: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    switch (c.kind) {
      case 'agent': {
        const ok = ctx.inject(c.targetId, buildRingEnvelope(c.message, recordingId))
        return ok ? { ok } : { ok, detail: `${c.targetName} is not live` }
      }
      case 'music': {
        const detail = c.action === 'play' ? await ctx.music.play(c.query)
          : c.action === 'pause' ? await ctx.music.pause()
          : c.action === 'next' ? await ctx.music.next()
          : await ctx.music.previous()
        return { ok: true, detail }
      }
      case 'unknown':
        return { ok: false, detail: 'no matching command and no fallback agent' }
    }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}
