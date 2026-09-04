// Ring pipeline: archive → transcript (ring's, else hub STT) → route (rules
// from the schema note, else LLM, else fallback agent) → execute → notify.
// Everything that touches the hub (sessions, vault, boards, Spotify, push,
// STT) arrives through RingCtx so this stays unit-testable with stubs.

import type { RingStore, RingRecording } from './store.js'
import { routeByRules, describeCommand, type RingCommand, type RouteEnv } from './router.js'
import { RING_SCHEMA_NOTE, type RingSchema, type SchemaDescription } from './schema.js'
import { appendLogEntry, appendBullet, appendMovieRow, type MovieRow } from './append.js'

export interface RingCtx {
  store: RingStore
  schema: () => Promise<{ schema: RingSchema; errors: string[] }>
  describeSchema: () => Promise<SchemaDescription>
  env: () => Promise<RouteEnv>
  /** Deliver ring-originated work to AL — into the `AL ↔ ring` conversation
   *  fork (never AL's main session), falling back to the parent only when the
   *  fork can't spawn. False = AL is not live at all. */
  deliverToAl: (envelope: string) => boolean
  /** Deliver to a non-AL fallback agent by agentKey. False = no live session. */
  deliverToAgent: (agentKey: string, envelope: string) => boolean
  /** `echo` — the payload to Yousef's own WhatsApp via AL's number, no LLM.
   *  Returns the JID it went to; throws when WhatsApp is down / unconfigured. */
  whatsappToYousef: (text: string) => Promise<string>
  /** `message` — send AS YOUSEF through his own chat account (Matrix/Beeper
   *  WhatsApp bridge) to the contact's DM room. Returns the room name; throws
   *  when no room resolves or the send fails. */
  chatSendAsYousef: (contact: string, text: string) => Promise<string>
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
  notify: (msg: { title: string; body: string; id: string }) => void
  now?: () => Date
  log: (msg: string) => void
}

export interface RingDelivery {
  transcription: string | null
  audio: { data: Buffer; contentType: string } | null
  recordedAt: number | null
  client: string | null
}

/** Everything the `AL ↔ ring` fork needs to know, sent ONCE when the fork
 *  spawns: what the ring is, where the command tree lives, and what to do
 *  with a transcript the tree didn't claim. */
export function buildRingForkSeed(schema: RingSchema): string {
  const v = schema.verbs
  const targets = Object.entries(v.add.targets)
  const tree = [
    `add|log <target> <text>  → append to a list/log note (logs, dated: ${targets.filter(([, t]) => t.dated).map(([n]) => n).join(', ') || '-'}; lists: ${targets.filter(([, t]) => !t.dated).map(([n]) => n).join(', ') || '-'})`,
    `add <project> <text>     → board card in ${v.add.projectColumn}`,
    `start <project> <text>   → board card in ${v.start.column} (dispatched, forks an agent now)`,
    `message <person> <text>  → sent AS YOUSEF from his own chat account (not via you)`,
    'echo <text>              → straight to Yousef\'s WhatsApp (pure software smoke test)',
    'play | pause | next | previous | play <query>',
  ]
  return [
    `[RING FORK] You are a fork of AL dedicated to Yousef's Pebble Index 01 smart ring — a voice-command device. The hub routes each transcript through a deterministic command tree (\`${RING_SCHEMA_NOTE}\`, printable with \`con ring schema\`):`,
    ...tree.map((l) => `  ${l}`),
    'One kind of work reaches you here, as envelopes below:',
    'UNCLAIMED — a transcript no verb matched (mis-heard word, phrasing the tree lacks, or a genuine free-form request). Work out what Yousef meant and DO it. Then judge: if this SHOULD have been a tree command (a mangled verb/target, a nickname/alias the note lacks, a log or list that does not exist yet), file a card on the console board so the tree gets fixed: `con spaces board console add "Ring schema gap: <exact transcript> → <what it should map to>"`. Do not edit the schema note yourself — Console general owns it. A one-off request that no command should cover needs no card.',
    'You know everything parent-AL knew up to this branch point. You will be wound down automatically when idle; no action needed.',
  ].join('\n')
}

/** Per-delivery envelope for unclaimed text. */
export function buildFallbackEnvelope(text: string, recordingId: string): string {
  return `[RING — unclaimed voice command, recording ${recordingId}]\n${text}`
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
  if (!command && schema.fallback) { command = { kind: 'fallback', agentKey: schema.fallback, text: transcription }; via = 'default' }
  if (!command) command = { kind: 'unknown', text: transcription }

  const outcome = await execute(ctx, command, id)
  rec.route = { command, via, ...(rule ? { rule } : {}), ok: outcome.ok, ...(outcome.detail ? { detail: outcome.detail } : {}) }
  ctx.store.update(rec)
  ctx.log(`[ring] ${id} ${via}${rule ? `/${rule}` : ''} ${describeCommand(command)} → ${outcome.ok ? 'ok' : 'FAILED'}${outcome.detail ? ` (${outcome.detail})` : ''}`)

  ctx.notify({ id, ...notification(command, outcome) })
  return rec
}

function notification(c: RingCommand, o: { ok: boolean; detail?: string }): { title: string; body: string } {
  if (!o.ok) return { title: 'Ring: not delivered', body: `${describeCommand(c)} — ${o.detail ?? 'failed'}` }
  switch (c.kind) {
    case 'fallback': return { title: `Ring → ${c.agentKey === 'al' ? 'AL' : `@${c.agentKey}`}`, body: c.text }
    case 'message': return { title: `Ring → ${c.spoken}${o.detail ? ` (${o.detail})` : ''}`, body: c.text }
    case 'list': return { title: `Ring · ${c.dated ? 'log' : 'add'} ${c.target}`, body: c.dated ? c.item : (o.detail ?? c.item) }
    case 'echo': return { title: 'Ring · echo → WhatsApp', body: c.text }
    case 'card': return { title: `Ring · ${c.project} → ${c.column}`, body: o.detail ?? c.text }
    case 'music': return { title: 'Ring · music', body: o.detail ?? describeCommand(c) }
    default: return { title: 'Ring', body: describeCommand(c) }
  }
}

async function execute(ctx: RingCtx, c: RingCommand, recordingId: string): Promise<{ ok: boolean; detail?: string }> {
  const now = ctx.now?.() ?? new Date()
  try {
    switch (c.kind) {
      case 'fallback': {
        const envelope = buildFallbackEnvelope(c.text, recordingId)
        const ok = c.agentKey === 'al' ? ctx.deliverToAl(envelope) : ctx.deliverToAgent(c.agentKey, envelope)
        return ok ? { ok } : { ok, detail: `${c.agentKey === 'al' ? 'AL' : `@${c.agentKey}`} is not live` }
      }
      case 'message': {
        const room = await ctx.chatSendAsYousef(c.contact, c.text)
        return { ok: true, detail: room }
      }
      case 'echo': {
        const jid = await ctx.whatsappToYousef(c.text)
        return { ok: true, detail: `sent to ${jid}` }
      }
      case 'list': {
        const existing = await ctx.notes.read(c.file)
        if (c.dated) {
          await ctx.notes.write(c.file, appendLogEntry(existing, c.item, now))
          return { ok: true, detail: c.file }
        }
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
