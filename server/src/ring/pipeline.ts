// Ring pipeline: archive → transcript (ring's, else hub STT) → route (rules
// from the schema note, else LLM, else fallback agent) → execute → notify.
// Everything that touches the hub (sessions, vault, boards, Spotify, push,
// STT) arrives through RingCtx so this stays unit-testable with stubs.

import type { RingStore, RingRecording } from './store.js'
import { routeByRules, describeCommand, normaliseKeepCase, wordKey, wordKeys, findWordRun, type RingCommand, type RouteEnv, type RouteMatch } from './router.js'
import { RING_SCHEMA_NOTE, type RingSchema, type SchemaDescription } from './schema.js'
import { appendLogEntry } from './append.js'
import { payloadStart, snapToGap, type TimedWord, type Frame, type VoiceClip } from './voice.js'
import { appendRow, stamp } from '../lists/table.js'
import { columnsFor, rawRow } from '../lists/enrichers.js'
import { formatDuration } from '../glasses/timer.js'
import { dueAt, formatDue, parseReminder, type Reminder } from './remind.js'

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
  /** `voice` — the clip AS YOUSEF to the contact's DM as a push-to-talk voice
   *  note (MSC3245). Same room resolution as chatSendAsYousef. */
  chatSendVoiceAsYousef: (contact: string, clip: VoiceClip) => Promise<string>
  /** Head-clip analysis + the cut behind `voice` (ring/voice.ts). Each null
   *  when unavailable: no words → the note goes out uncut; no envelope → the
   *  words' estimate stands; no cut → the delivery fails. */
  voiceAudio: {
    /** Word timestamps over the first seconds, primed with the tree's vocabulary. */
    words: (audioPath: string, vocabulary: string) => Promise<TimedWord[] | null>
    /** RMS envelope of the first seconds, one frame per FRAME_MS. */
    envelope: (audioPath: string) => Promise<Frame[] | null>
    /** The recording from `fromSeconds` on, as ogg/opus. */
    cut: (audioPath: string, fromSeconds: number) => Promise<VoiceClip | null>
  }
  notes: {
    /** null when the note doesn't exist yet. */
    read: (path: string) => Promise<string | null>
    write: (path: string, content: string) => Promise<void>
  }
  /** Add a board card; returns a one-line description of what landed. */
  addCard: (project: string, text: string, column: string) => Promise<string>
  /** File a `Ring miss:` card on the console board for a failed delivery,
   *  unless an open one for the same transcript already exists. Returns what
   *  happened, for the sidecar. */
  fileMissCard: (miss: RingMiss, column: string) => Promise<'filed' | 'exists' | 'failed'>
  /** `timer` — the glasses' native countdown (0x07). Returns a one-line
   *  outcome; throws when the APK is not connected or the frame is refused. */
  glassesTimer: (seconds: number | null) => Promise<string>
  /** `remind` — hub-scheduled one-shots to Yousef's own WhatsApp (ring/remind.ts). */
  reminders: {
    schedule: (text: string, dueAt: number, recordingId: string) => Reminder
    pending: () => Reminder[]
    cancel: (id: string) => boolean
  }
  music: {
    play: (query?: string) => Promise<string>
    pause: () => Promise<string>
    next: () => Promise<string>
    previous: () => Promise<string>
  }
  transcribe: (audio: Buffer, contentType: string) => Promise<string | null>
  /** Hub STT over the first seconds of the archived recording, primed with
   *  the tree's vocabulary — re-hears a command head the ring mis-heard.
   *  Null when unavailable. */
  transcribeHead: (audioPath: string, vocabulary: string) => Promise<string | null>
  classify: (text: string, schema: RingSchema, env: RouteEnv) => Promise<RingCommand | null>
  notify: (msg: { title: string; body: string; id: string }) => void
  now?: () => Date
  log: (msg: string) => void
}

export interface RingMiss {
  recordingId: string
  transcription: string
  rule?: string
  via: string
  detail: string
}

/** The card a failed delivery files — self-contained: the fork that picks it
 *  up has never seen the ring. */
export function buildMissCard(m: RingMiss): { text: string; detail: string[] } {
  return {
    text: `Ring miss: "${m.transcription}" → ${m.detail}`,
    detail: [
      `Recording ${m.recordingId} (\`con ring show ${m.recordingId}\`), routed via ${m.via}${m.rule ? `/${m.rule}` : ''}.`,
      '1. FIRST, interpret the transcript and DO what Yousef asked, if at all possible — the command was spoken to be done, not filed. Check `con ring show` first so you do not double an action that partly happened (e.g. items already in a basket). Say in your hand-back what you did or why it could not be done.',
      '2. THEN fix the cause so it routes next time: a mis-heard verb/target/contact → add the spoken form to projects/console/ring-schema.md (the yaml fence; hot-reloads); a missing list/log → add the target there; a router or handler bug → server/src/ring/ (router.ts, pipeline.ts) or server/src/lists/. Verify with `con ring say --dry "<the transcript>"` and `con ring schema --check`.',
    ],
  }
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
    'voice <person> <speech>  → the recording itself, minus the command words, as a WhatsApp voice note FROM YOUSEF (not via you)',
    'echo <text>              → straight to Yousef\'s WhatsApp (pure software smoke test)',
    'remind [me] [in <duration> | at <time> | tomorrow …] <text> → the text to Yousef\'s WhatsApp at that time (no time → 2 h), his words verbatim; pure software',
    'al <text>                → straight to YOU (this fork), skipping the tree — he addressed you by name ("message al …" is different: that is a WhatsApp send FROM YOUSEF to your DM, answer it on WhatsApp)',
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

export interface RouteDecision {
  command: RingCommand
  via: NonNullable<RingRecording['route']>['via']
  rule?: string
  /** The hub-STT re-hearing of the audio head that routing used. */
  head?: string
}

/** Whisper-style STT takes a free-text prompt that biases it toward the
 *  words in it — the tree's command phrases, so "Log dream." is heard as such
 *  and not as "Look,". Canonical names only: the aliases ARE mis-hearings. */
export function sttVocabulary(schema: RingSchema, env: RouteEnv): string {
  const v = schema.verbs
  const firstName = (u: string) => u.split('-')[0]!
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const phrases = [
    ...Object.entries(v.add.targets).map(([n, t]) => `${t.dated ? 'Log' : 'Add'} ${n}.`),
    ...env.projects.map((p) => `Add ${p.replace(/-/g, ' ')}.`),
    ...[...new Set([...Object.keys(v.message.contacts), ...env.contacts].map(firstName))].map((c) => `Message ${cap(c)}.`),
    'Al.', 'Echo.', 'Voice.', 'Timer.', 'Remind me.', 'Play.', 'Pause.', 'Next.',
  ]
  return phrases.join(' ')
}

/** The head re-hearing fixes the COMMAND words; the payload still comes from
 *  the ring's full transcript, verbatim: the head payload's opening words are
 *  anchored in the ring transcript and everything from there is taken. Null
 *  when the two cannot be aligned. Kinds without a spoken payload pass. */
export function spliceHeadPayload(head: RingCommand, transcript: string): RingCommand | null {
  const field = head.kind === 'list' ? 'item' : head.kind === 'echo' || head.kind === 'card' || head.kind === 'message' || head.kind === 'voice' || head.kind === 'fallback' || head.kind === 'remind' ? 'text' : null
  if (!field) return head
  const want = wordKeys(field === 'item' ? (head as { item: string }).item : (head as { text: string }).text)
  if (!want.length) return null
  const tokens = normaliseKeepCase(transcript).split(' ')
  const keys = tokens.map(wordKey)
  for (const n of new Set([Math.min(3, want.length), Math.min(2, want.length)])) {
    const at = findWordRun(keys, want.slice(0, n), HEAD_ANCHOR_WINDOW)
    if (at < 0) continue
    const spliced = tokens.slice(at).join(' ')
    // A reminder's time phrase may sit at the END of the full transcript,
    // past the head — re-read the spliced text unless the head already had one.
    if (head.kind === 'remind' && !head.spoken) {
      const re = parseReminder(spliced, head.when.kind === 'in' ? head.when.seconds : 0)
      return re ? { kind: 'remind', ...re } : { ...head, text: spliced }
    }
    return { ...head, [field]: spliced } as RingCommand
  }
  return null
}

/** How far into the ring transcript the head payload may start — the lead-in
 *  is a handful of words, and a 10 s head is ~25. */
const HEAD_ANCHOR_WINDOW = 20

const firm = (h: RouteMatch) => h.command.kind !== 'unknown-target' && !h.weak

/** Transcript → command, exactly as the live pipeline decides it (rules, then
 *  a re-hearing of the audio head when the rules did not firmly match, then
 *  the LLM classifier, then the fallback agent). Pure with respect to the
 *  world — nothing is archived, executed or pushed. */
export async function decide(ctx: RingCtx, transcription: string, audioPath?: string | null): Promise<RouteDecision> {
  const { schema } = await ctx.schema()
  const env = await ctx.env()
  const hit = routeByRules(transcription, schema, env)
  if (hit && firm(hit)) return { command: hit.command, via: 'rule', rule: hit.rule }
  // The ring wrote "Look, these are three dreams" for "Log dream. These are
  // three dreams" — the HEAD is what it mis-hears. Hub STT, primed with the
  // tree's words, over the first seconds; the body stays the ring's.
  if (audioPath) {
    const head = await ctx.transcribeHead(audioPath, sttVocabulary(schema, env))
    const rehit = head ? routeByRules(head, schema, env) : null
    if (head && rehit && firm(rehit)) {
      const command = spliceHeadPayload(rehit.command, transcription)
      if (command) return { command, via: 'rule', rule: rehit.rule, head }
      ctx.log(`[ring] head re-hearing "${head}" routed ${rehit.rule} but its payload does not align with the transcript — ignored`)
    }
  }
  if (hit) return { command: hit.command, via: 'rule', rule: hit.rule }
  if (schema.llmFallback) {
    const guess = await ctx.classify(transcription, schema, env)
    if (guess && guess.kind !== 'unknown') return { command: guess, via: 'llm' }
  }
  if (schema.fallback) return { command: { kind: 'fallback', agentKey: schema.fallback, text: transcription }, via: 'default' }
  return { command: { kind: 'unknown', text: transcription }, via: 'none' }
}

/** `con ring say --dry`: what WOULD happen — the decision plus its one-liner,
 *  no recording, no side effects. The tuning loop for the schema note. */
export async function dryRun(ctx: RingCtx, transcription: string): Promise<RouteDecision & { describe: string }> {
  const d = await decide(ctx, transcription.trim())
  return { ...d, describe: describeCommand(d.command) }
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

  // Only the ring's own transcript gets its head re-heard: a hub-STT
  // transcript already IS the re-hearing.
  const { command, via, rule, head } = await decide(ctx, transcription, source === 'ring' ? rec.audio?.path : null)

  const outcome = await execute(ctx, command, rec)
  rec.route = { command, via, ...(rule ? { rule } : {}), ...(head ? { head } : {}), ok: outcome.ok, ...(outcome.detail ? { detail: outcome.detail } : {}) }
  ctx.store.update(rec)
  ctx.log(`[ring] ${id} ${via}${rule ? `/${rule}` : ''}${head ? ` (head re-heard: "${head}")` : ''} ${describeCommand(command)} → ${outcome.ok ? 'ok' : 'FAILED'}${outcome.detail ? ` (${outcome.detail})` : ''}`)

  ctx.notify({ id, ...notification(command, outcome) })

  // A miss is a bug in the tree or the code — file it where a fork will pick
  // it up, the moment it happens. Not for `unknown` (no fallback configured)
  // — that is a choice, not a failure.
  const { schema } = await ctx.schema()
  if (!outcome.ok && command.kind !== 'unknown' && schema.onFailure.column) {
    const filed = await ctx.fileMissCard({ recordingId: id, transcription, via, ...(rule ? { rule } : {}), detail: outcome.detail ?? 'not delivered' }, schema.onFailure.column)
    rec.route.card = filed
    ctx.store.update(rec)
    ctx.log(`[ring] ${id} miss card: ${filed}`)
  }
  return rec
}

function notification(c: RingCommand, o: { ok: boolean; detail?: string }): { title: string; body: string } {
  if (!o.ok) return { title: 'Ring: not delivered', body: `${describeCommand(c)} — ${o.detail ?? 'failed'}` }
  switch (c.kind) {
    case 'fallback': return { title: `Ring → ${c.agentKey === 'al' ? 'AL' : `@${c.agentKey}`}`, body: c.text }
    case 'message': return { title: `Ring → ${c.spoken}${o.detail ? ` (${o.detail})` : ''}`, body: c.text }
    case 'voice': return { title: `Ring → ${c.spoken} · voice note${o.detail ? ` (${o.detail})` : ''}`, body: c.text }
    case 'list': return { title: `Ring · ${c.dated ? 'log' : 'add'} ${c.target}`, body: c.dated ? c.item : (o.detail ?? c.item) }
    case 'echo': return { title: 'Ring · echo → WhatsApp', body: c.text }
    case 'card': return { title: `Ring · ${c.project} → ${c.column}`, body: o.detail ?? c.text }
    case 'music': return { title: 'Ring · music', body: o.detail ?? describeCommand(c) }
    case 'timer': return { title: 'Ring · timer', body: o.detail ?? describeCommand(c) }
    case 'remind': return { title: `Ring · reminder ${o.detail ?? ''}`.trim(), body: c.text }
    default: return { title: 'Ring', body: describeCommand(c) }
  }
}

async function execute(ctx: RingCtx, c: RingCommand, rec: RingRecording): Promise<{ ok: boolean; detail?: string }> {
  const now = ctx.now?.() ?? new Date()
  try {
    switch (c.kind) {
      case 'fallback': {
        const envelope = buildFallbackEnvelope(c.text, rec.id)
        const ok = c.agentKey === 'al' ? ctx.deliverToAl(envelope) : ctx.deliverToAgent(c.agentKey, envelope)
        return ok ? { ok } : { ok, detail: `${c.agentKey === 'al' ? 'AL' : `@${c.agentKey}`} is not live` }
      }
      case 'message': {
        const room = await ctx.chatSendAsYousef(c.contact, c.text)
        return { ok: true, detail: room }
      }
      case 'voice': {
        const path = rec.audio && ctx.store.audioPath(rec.id)
        if (!path) throw new Error('no recording to send — a voice note needs the ring audio (typed text has none)')
        // Word timestamps place the payload's first words, the envelope snaps
        // that to the real pause; an unplaceable payload ships the whole
        // recording rather than nothing.
        const { schema } = await ctx.schema()
        const [words, envelope] = await Promise.all([ctx.voiceAudio.words(path, sttVocabulary(schema, await ctx.env())), ctx.voiceAudio.envelope(path)])
        const est = words && rec.transcription ? payloadStart(words, rec.transcription, c.text) : null
        const from = est ? (envelope ? snapToGap(envelope, est) : est.t) : 0
        const clip = await ctx.voiceAudio.cut(path, from)
        if (!clip) throw new Error('ffmpeg could not cut the recording into a voice note')
        const room = await ctx.chatSendVoiceAsYousef(c.contact, clip)
        return { ok: true, detail: `${room}, ${formatDuration(Math.round(clip.durationMs / 1000))}${est ? `, head cut at ${from}s` : ', UNCUT — command words included'}` }
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
        // Raw row only — enrichment (e.g. movie year/series) is the
        // ListWatcher's job, seconds later, and works on hand-typed rows too.
        await ctx.notes.write(c.file, appendRow(existing, columnsFor(c.enrich), rawRow(c.enrich, c.item, stamp(now))))
        return { ok: true, detail: c.item }
      }
      case 'card': {
        const detail = await ctx.addCard(c.project, c.text, c.column)
        return { ok: true, detail }
      }
      case 'timer': {
        const detail = await ctx.glassesTimer(c.seconds)
        return { ok: true, detail }
      }
      case 'remind': {
        const due = dueAt(c.when, now)
        const r = ctx.reminders.schedule(c.text, due.getTime(), rec.id)
        return { ok: true, detail: `${formatDue(due, now)} → WhatsApp (${r.id})` }
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
