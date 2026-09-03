// Ring pipeline: archive → transcript (ring's, else hub STT) → route (rules
// from the schema note, else LLM, else fallback agent) → execute → notify.
// Everything that touches the hub (sessions, vault, boards, Spotify, push,
// STT) arrives through RingCtx so this stays unit-testable with stubs.

import type { RingStore, RingRecording } from './store.js'
import { routeByRules, describeCommand, type RingAgent, type RingCommand, type RouteEnv } from './router.js'
import type { RingSchema, SchemaDescription } from './schema.js'
import { appendLogEntry, appendBullet, appendMovieRow, type MovieRow } from './append.js'

export interface RingCtx {
  store: RingStore
  schema: () => Promise<{ schema: RingSchema; errors: string[] }>
  describeSchema: () => Promise<SchemaDescription>
  env: () => Promise<RouteEnv>
  /** Resolve an agentKey to a live session (the fallback / relay target). */
  sessionForKey: (agentKey: string) => RingAgent | null
  /** Inject + auto-send into a session. False if the session is not live. */
  inject: (sessionId: string, content: string) => boolean
  notes: {
    /** null when the note doesn't exist yet. */
    read: (path: string) => Promise<string | null>
    write: (path: string, content: string) => Promise<void>
  }
  /** Add a board card; returns a one-line description of what landed. */
  addCard: (project: string, text: string, column: string) => Promise<string>
  music: {
    play: (query?: string) => Promise<string>
    pause: () => Promise<string>
    next: () => Promise<string>
    previous: () => Promise<string>
  }
  transcribe: (audio: Buffer, contentType: string) => Promise<string | null>
  classify: (text: string, schema: RingSchema, env: RouteEnv) => Promise<RingCommand | null>
  /** LLM step for `add movies`: infer title/year/series. null → plain bullet. */
  enrichMovie: (text: string) => Promise<MovieRow | null>
  notify: (msg: { title: string; body: string; sessionId?: string; id: string }) => void
  now?: () => Date
  log: (msg: string) => void
}

export interface RingDelivery {
  transcription: string | null
  audio: { data: Buffer; contentType: string } | null
  recordedAt: number | null
  client: string | null
}

/** Envelope the fallback agent sees for unclaimed text — task-framed like the WhatsApp inbound. */
export function buildRingEnvelope(message: string, recordingId: string): string {
  return `[RING — voice command from Yousef's Pebble Index 01, recording ${recordingId}]\n${message}`
}

/** `message <person> <text>` goes through AL: the WhatsApp number is AL's own
 *  identity, so AL relays Yousef's words with attribution rather than the hub
 *  sending them as if AL had said them. */
export function buildRelayEnvelope(contact: string, spoken: string, text: string, recordingId: string): string {
  return [
    `[RING — relay request from Yousef's Pebble Index 01, recording ${recordingId}]`,
    `Yousef said "message ${spoken}" — resolved to your contact \`${contact}\` (users/${contact}.md).`,
    `Relay this to them on WhatsApp now, faithfully and attributed to Yousef (e.g. "Yousef says: …"), no embellishment:`,
    '',
    text,
  ].join('\n')
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

  const { schema } = await ctx.schema()
  const env = await ctx.env()
  let command: RingCommand | null = null
  let via: NonNullable<RingRecording['route']>['via'] = 'none'
  let rule: string | undefined

  const hit = routeByRules(transcription, schema, env)
  if (hit) { command = hit.command; via = 'rule'; rule = hit.rule }
  else if (schema.llmFallback) {
    const guess = await ctx.classify(transcription, schema, env)
    if (guess && guess.kind !== 'unknown') { command = guess; via = 'llm' }
  }
  if (!command && schema.fallback) {
    const target = ctx.sessionForKey(schema.fallback)
    if (target) { command = { kind: 'agent', targetId: target.id, targetName: target.name, message: transcription }; via = 'default' }
  }
  if (!command) command = { kind: 'unknown', text: transcription }

  const outcome = await execute(ctx, command, id)
  rec.route = { command, via, ...(rule ? { rule } : {}), ok: outcome.ok, ...(outcome.detail ? { detail: outcome.detail } : {}) }
  ctx.store.update(rec)
  ctx.log(`[ring] ${id} ${via}${rule ? `/${rule}` : ''} ${describeCommand(command)} → ${outcome.ok ? 'ok' : 'FAILED'}${outcome.detail ? ` (${outcome.detail})` : ''}`)

  ctx.notify({ id, ...notification(command, outcome) })
  return rec
}

function notification(c: RingCommand, o: { ok: boolean; detail?: string }): { title: string; body: string; sessionId?: string } {
  if (!o.ok) return { title: 'Ring: not delivered', body: `${describeCommand(c)} — ${o.detail ?? 'failed'}` }
  switch (c.kind) {
    case 'agent': return { title: `Ring → ${c.targetName}`, body: c.message, sessionId: c.targetId }
    case 'message': return { title: `Ring → AL relays to ${c.spoken}`, body: c.text, ...(o.detail ? {} : {}) }
    case 'log': return { title: `Ring · log ${c.target}`, body: c.text }
    case 'list': return { title: `Ring · add ${c.target}`, body: o.detail ?? c.item }
    case 'card': return { title: `Ring · card on ${c.project}`, body: o.detail ?? c.text }
    case 'music': return { title: 'Ring · music', body: o.detail ?? describeCommand(c) }
    default: return { title: 'Ring', body: describeCommand(c) }
  }
}

async function execute(ctx: RingCtx, c: RingCommand, recordingId: string): Promise<{ ok: boolean; detail?: string }> {
  const now = ctx.now?.() ?? new Date()
  try {
    switch (c.kind) {
      case 'agent': {
        // Fallback delivery only (unclaimed text → AL); never a spoken verb.
        const ok = ctx.inject(c.targetId, buildRingEnvelope(c.message, recordingId))
        return ok ? { ok } : { ok, detail: `${c.targetName} is not live` }
      }
      case 'message': {
        const al = ctx.sessionForKey('al')
        if (!al) return { ok: false, detail: 'AL is not live to relay the message' }
        const ok = ctx.inject(al.id, buildRelayEnvelope(c.contact, c.spoken, c.text, recordingId))
        return ok ? { ok } : { ok, detail: 'AL is not live to relay the message' }
      }
      case 'log': {
        const existing = await ctx.notes.read(c.file)
        await ctx.notes.write(c.file, appendLogEntry(existing, c.text, now))
        return { ok: true, detail: c.file }
      }
      case 'list': {
        const existing = await ctx.notes.read(c.file)
        if (c.enrich === 'movie') {
          const row = await ctx.enrichMovie(c.item)
          if (row) {
            await ctx.notes.write(c.file, appendMovieRow(existing, row))
            return { ok: true, detail: `${row.title} (${row.year})${row.series && !/^no$/i.test(row.series) ? ` · ${row.series}` : ''}` }
          }
        }
        await ctx.notes.write(c.file, appendBullet(existing, c.item))
        return { ok: true, detail: c.item }
      }
      case 'card': {
        const detail = await ctx.addCard(c.project, c.text, c.column)
        return { ok: true, detail }
      }
      case 'music': {
        const detail = c.action === 'play' ? await ctx.music.play(c.query)
          : c.action === 'pause' ? await ctx.music.pause()
          : c.action === 'next' ? await ctx.music.next()
          : await ctx.music.previous()
        return { ok: true, detail }
      }
      case 'unknown-target':
        return { ok: false, detail: `no ${c.verb} target called "${c.target}" — add it to the ring schema note` }
      case 'unknown':
        return { ok: false, detail: 'no matching command and no fallback agent' }
    }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}
