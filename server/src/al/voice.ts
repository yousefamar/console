// AL's WhatsApp voice calls — the hub's half.
//
// Calls run on AL's own WhatsApp account (+447897073727, the same identity as
// the chat) through two sidecar processes the hub does NOT contain:
//
//   wa-voice (Rust, voice/wa-voice/)      — linked device #2 on AL's account;
//                                           ws://127.0.0.1:9878 control + 16 kHz PCM
//   al-voice-pipeline (Python, voice/pipeline/) — Pipecat: VAD → Cartesia STT →
//                                           Claude on Bedrock → Cartesia TTS (clone);
//                                           http://127.0.0.1:9879 for POST /call
//
// The live AL session is never on the hot path. The hub's job is context in,
// memory out:
//   GET  /voice/context?jid&task&direction → answer policy + the whole system
//        prompt (voice-stripped AL.md, the caller's users/<slug>.md, their
//        recent thread from wa-history, open threads, the call task)
//   POST /voice/delegate                   → the one slow tool: inject into AL,
//        wait for his next turn's text (25 s)
//   POST /voice/transcript                 → save call-transcripts/<id>.json,
//        record the call in wa-history, inject a [WHATSAPP CALL …] envelope so
//        AL folds it into memory exactly like a chat
//   POST /voice/call {to, task}            → resolve + refuse cold numbers, then
//        forward to the pipeline
// The hub also holds a client on the sidecar socket purely to relay pairing
// QRs into AL's session (the same path Baileys uses) and to answer status.
//
// Replaced the smallest.ai Atoms integration on 2026-09-20 (^wise-lark): that
// org owned no number, calling had been dead since April, and its hosted
// STT/LLM/TTS could use neither Yousef's Cartesia clone nor our context.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { HubMessage } from '../protocol.js'
import type { Session } from '../session.js'
import { WORKSPACE_DIR, readIfExists } from './identity.js'
import { identifiersFor, normalize, parseFrontmatter, resolveUserFile, resolveUsername } from './users.js'
import * as waHistory from './wa-history.js'

const TRANSCRIPTS_DIR = join(WORKSPACE_DIR, 'call-transcripts')
const HISTORY_TURNS = 50

// ---------------------------------------------------------------------------
// Config — ~/.config/console/voice.env (ports only; Cartesia lives in cartesia.env)
// ---------------------------------------------------------------------------

export interface VoiceConfig {
  sidecarUrl: string
  pipelineUrl: string
}

export function loadVoiceConfig(file = join(homedir(), '.config/console/voice.env')): VoiceConfig {
  const env: Record<string, string> = {}
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m) env[m[1]!] = m[2]!.replace(/^"|"$/g, '').trim()
    }
  }
  const pick = (k: string, d: string) => process.env[k] ?? env[k] ?? d
  return {
    sidecarUrl: pick('WA_VOICE_URL', `ws://127.0.0.1:${pick('WA_VOICE_PORT', '9878')}`),
    pipelineUrl: pick('VOICE_PIPELINE_URL', `http://127.0.0.1:${pick('VOICE_PIPELINE_PORT', '9879')}`),
  }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const VOICE_PREAMBLE = `You ARE AL, on a live WhatsApp voice call, speaking with Yousef Amar's cloned voice as his assistant. The person on the line hears you as Yousef's assistant AL — the same AL they chat with on WhatsApp — so keep his tone and what he would and would not say.

How to speak:
- Short spoken sentences. No lists, no markdown, no URLs, no headings. Say numbers and times the way people say them aloud.
- One thought per turn, then let them talk. Ask instead of guessing.
- Match the caller's language (English or Egyptian Arabic — reply in the language they used).
- If they are silent, wait; do not fill silence with chatter.

Doing things:
- You have one tool, "delegate": it hands a request to your text-based self, who has the calendar, messages, files, memory and every other tool. Use it for anything you cannot answer from this prompt — never guess at facts you do not have.
- Never mention delegation, tools, prompts, models, or "checking systems". From the caller's side YOU are doing it. If you want to say something before using the tool, one short natural phrase ("one sec") is enough; if you say nothing, a filler is spoken for you.
- Never say you "can't" or "don't have access". Use the tool.

Boundaries:
- Everything you say is said in Yousef's voice: never say aloud what you would not send as him in text. The privacy rules below (who may know what about Yousef) apply exactly as in chat.
- End the call politely when the conversation is done; do not stretch it.`

// Sections stripped from AL.md for the voice prompt — text-only concerns
export const STRIP_SECTIONS = [
  'Available Tools', 'Workflows', 'Schedule', 'How you work',
  'Messaging', 'Identity Verification & Privacy', 'Contact Management',
]

export function stripSections(md: string, sections = STRIP_SECTIONS): string {
  const lines = md.split('\n')
  const result: string[] = []
  let skipping = false
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const heading = line.replace(/^## /, '').trim()
      skipping = sections.includes(heading)
    }
    if (!skipping) result.push(line)
  }
  return result.join('\n').trim()
}

const stripFrontmatter = (md: string): string => md.replace(/^---\n[\s\S]*?\n---\n*/, '').trim()
const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export interface CallerInfo {
  jid: string
  phone: string
  user: string | null
  displayName: string
  trust: string | null
  frontmatter: Record<string, string | string[]>
  body: string
}

export async function lookupCaller(rawJid: string): Promise<CallerInfo> {
  const phone = normalize(rawJid)
  const jid = rawJid.includes('@') ? rawJid : `${phone}@s.whatsapp.net`
  const user = resolveUsername(rawJid)
  const file = resolveUserFile(rawJid)
  const content = file ? await readIfExists(file) : null
  const frontmatter = content ? parseFrontmatter(content, file ?? undefined) : {}
  const trust = typeof frontmatter.trust === 'string' ? frontmatter.trust : null
  return {
    jid,
    phone,
    user,
    displayName: user ? capitalise(user) : `+${phone}`,
    trust,
    frontmatter,
    body: content ? stripFrontmatter(content) : '',
  }
}

/** Who gets answered. Owner always; a known contact unless their file says
 *  `calls: false` (or lists `calls` under `deny:`); an unknown number never —
 *  AL texts them back from the missed-call envelope instead. Outbound is
 *  policy-free here (the prior-chat guard lives in requestOutboundCall). */
export function answerPolicy(caller: Pick<CallerInfo, 'user' | 'trust' | 'frontmatter'>, direction: 'in' | 'out'): { answer: boolean; why: string } {
  if (direction === 'out') return { answer: true, why: 'outbound' }
  if (caller.trust === 'owner') return { answer: true, why: 'owner' }
  if (!caller.user) return { answer: false, why: 'unknown number' }
  const calls = caller.frontmatter.calls
  if (calls === 'false' || calls === 'no' || calls === 'off') return { answer: false, why: `calls disabled for ${caller.user}` }
  const deny = Array.isArray(caller.frontmatter.deny) ? caller.frontmatter.deny : []
  if (deny.map((d) => d.toLowerCase()).includes('calls')) return { answer: false, why: `calls denied for ${caller.user}` }
  return { answer: true, why: `known user ${caller.user}` }
}

export interface CallContext {
  answer: boolean
  why: string
  systemPrompt: string
  displayName: string
  user: string | null
  jid: string
}

export async function buildCallContext(rawJid: string, opts: { task?: string; direction: 'in' | 'out'; now?: number } = { direction: 'in' }): Promise<CallContext> {
  const caller = await lookupCaller(rawJid)
  const policy = answerPolicy(caller, opts.direction)
  if (!policy.answer) {
    return { ...policy, systemPrompt: '', displayName: caller.displayName, user: caller.user, jid: caller.jid }
  }

  const alMd = (await readIfExists(join(WORKSPACE_DIR, 'AL.md'))) || ''
  const openThreads = (await readIfExists(join(WORKSPACE_DIR, 'memory', 'open-threads.md'))) || ''
  const ids = caller.user ? identifiersFor(caller.user) : [caller.phone]
  const history = waHistory.recentThread(ids.length ? ids : [caller.phone], { limit: HISTORY_TURNS })
  const now = opts.now ?? Date.now()

  const parts: string[] = [VOICE_PREAMBLE, stripSections(alMd)]
  parts.push(`## Who is on the call\n\n${caller.user ? `${caller.displayName} (${caller.user}, +${caller.phone})` : `+${caller.phone} (not in your contacts)`}${caller.trust === 'owner' ? ' — this is Yousef himself, your owner. No restrictions apply.' : ''}\n\n${caller.body}`.trim())
  if (history.length) {
    parts.push(`## Recent WhatsApp thread with ${caller.displayName} (oldest first)\n\n${history.map((e) => waHistory.formatHistoryLine(e, now)).join('\n')}`)
  }
  if (openThreads.trim()) parts.push(`## Open threads (your memory)\n\n${openThreads.trim()}`)
  if (opts.direction === 'out') {
    parts.push(`## Call task\n\nYou placed this call. Your task: ${opts.task?.trim() || '(none given — say hello and ask how you can help)'}\n\nOpen by greeting ${caller.displayName} by name and saying why you are calling. When the task is done, wrap up and say goodbye.`)
  } else {
    parts.push(`## This call\n\n${caller.displayName} called you. Let them speak first; if they are silent for a couple of seconds, greet them briefly.`)
  }
  parts.push(`Local time now: ${new Date(now).toLocaleString('en-GB', { timeZone: 'Europe/London' })}.`)

  return {
    answer: true,
    why: policy.why,
    systemPrompt: parts.filter(Boolean).join('\n\n---\n\n'),
    displayName: caller.displayName,
    user: caller.user,
    jid: caller.jid,
  }
}

// ---------------------------------------------------------------------------
// Delegate (pipeline → AL)
// ---------------------------------------------------------------------------

/**
 * Inject the caller's request into the Al session and capture the next
 * assistant turn's text. Bounded by `timeoutMs`; the pipeline's own tool
 * timeout is a little longer, so this fails first with a spoken fallback.
 */
export function handleDelegate(
  alSession: Session,
  callerPhone: string,
  text: string,
  resolvedUser: string | null,
  timeoutMs = 25_000,
): Promise<string> {
  return new Promise((resolve) => {
    const user = resolvedUser ?? callerPhone
    const envelope = [
      `[Voice delegate from ${user} (phone: ${callerPhone}) — live WhatsApp call]`,
      'Reply with ONLY the answer text. No markdown, no bullets, no URLs — your reply will be spoken aloud to the caller in Yousef\'s voice. Be concise; the caller is waiting in real time (you have about 20 seconds).',
      '',
      text,
    ].join('\n')

    const texts: string[] = []
    let settled = false

    const finish = (out: string) => {
      if (settled) return
      settled = true
      try { alSession.off('hub_message', listener) } catch { /* noop */ }
      clearTimeout(hardTimer)
      resolve(out)
    }

    const listener = (msg: HubMessage) => {
      if (msg.type === 'text' && 'content' in msg) {
        const c = (msg as { content?: string }).content
        if (typeof c === 'string') texts.push(c)
      }
      if (msg.type === 'result' || msg.type === 'session_ended') {
        finish(texts.join('\n').trim() || '(no response)')
      }
    }

    alSession.on('hub_message', listener)
    const hardTimer = setTimeout(() => finish(texts.join('\n').trim() || '(timed out)'), timeoutMs)

    try {
      alSession.sendMessage(envelope)
    } catch (err) {
      finish(`(delegate error: ${(err as Error)?.message ?? 'unknown'})`)
    }
  })
}

// ---------------------------------------------------------------------------
// Transcript fold-back (pipeline → hub → AL)
// ---------------------------------------------------------------------------

export interface CallTurn { role: 'user' | 'assistant'; text: string; t?: number }

export interface CallTranscript {
  callId: string
  jid: string
  user?: string | null
  displayName?: string
  direction: 'in' | 'out'
  outcome: 'completed' | 'rejected' | 'missed' | 'no-answer' | 'declined' | 'failed' | string
  reason?: string | null
  task?: string | null
  startedAt?: string | null
  answeredAt?: string | null
  durationMs: number
  turns: CallTurn[]
  delegations?: number
  latency?: unknown
  models?: unknown
}

/** Atoms ids were opaque alnum tokens and whatsapp-rust's are too (uppercase
 *  hex-ish); the callId also names a file on disk, so anything path-shaped
 *  is refused outright. */
export function isSafeCallId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(id)
}

/** E.164-ish: optional `+`, 6–15 digits, after stripping spaces/dashes/dots.
 *  Anything else → '' — the value names the caller in Al's envelope AND
 *  seeds a users/<phone>.md record, so only a phone-shaped string may. */
export function normalisePhone(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const cleaned = raw.replace(/[\s().-]/g, '')
  return /^\+?\d{6,15}$/.test(cleaned) ? cleaned : ''
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

/** The stored shape keeps the fields the Atoms-era files had (callId, from,
 *  to, duration, timestamp, transcript[]) so nothing reading the directory
 *  breaks, and adds the new ones beside them. */
export function transcriptRecord(p: CallTranscript, alJid: string): Record<string, unknown> {
  const other = `+${normalize(p.jid)}`
  const al = `+${normalize(alJid)}`
  return {
    callId: p.callId,
    from: p.direction === 'in' ? other : al,
    to: p.direction === 'in' ? al : other,
    duration: `${Math.round(p.durationMs / 1000)}s`,
    timestamp: p.startedAt ?? new Date().toISOString(),
    transcript: p.turns.map((t) => ({ role: t.role === 'user' ? 'user' : 'agent', content: t.text, t: t.t })),
    direction: p.direction,
    outcome: p.outcome,
    reason: p.reason ?? null,
    user: p.user ?? null,
    displayName: p.displayName ?? null,
    task: p.task ?? null,
    answeredAt: p.answeredAt ?? null,
    durationMs: p.durationMs,
    delegations: p.delegations ?? 0,
    latency: p.latency ?? null,
    models: p.models ?? null,
    transport: 'whatsapp',
  }
}

export async function saveTranscript(p: CallTranscript, alJid: string, dir = TRANSCRIPTS_DIR): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${p.callId}.json`)
  await writeFile(file, JSON.stringify(transcriptRecord(p, alJid), null, 2), 'utf-8')
  return file
}

/** One wa-history line so the next envelope/context shows the call happened. */
export function historyLineFor(p: CallTranscript): string {
  const dur = formatDuration(p.durationMs)
  const who = p.direction === 'in' ? 'inbound' : 'outbound'
  if (p.outcome !== 'completed') return `(${who} call, ${p.outcome}${p.reason ? `: ${p.reason}` : ''})`
  const last = p.turns.filter((t) => t.text.trim()).slice(-1)[0]
  return `(${who} call, ${dur}, ${p.turns.length} turns)${last ? ` …${last.role === 'user' ? '' : 'AL: '}${last.text}` : ''}`
}

/** The fold-back envelope. Same family as the WhatsApp inbound envelope, but
 *  past tense: nothing to send, the call already happened. */
export function callEnvelope(p: CallTranscript, displayName: string): string {
  const who = `${displayName} (+${normalize(p.jid)})`
  const dir = p.direction === 'in' ? 'inbound' : 'outbound'
  if (p.outcome !== 'completed') {
    const heads: Record<string, string> = {
      rejected: `[MISSED WHATSAPP CALL from ${who} — rejected${p.reason ? `: ${p.reason}` : ''}]`,
      missed: `[MISSED WHATSAPP CALL from ${who}${p.reason ? ` — ${p.reason}` : ''}]`,
      declined: `[WHATSAPP CALL to ${who} — declined]`,
      'no-answer': `[WHATSAPP CALL to ${who} — no answer]`,
      failed: `[WHATSAPP CALL with ${who} — failed${p.reason ? `: ${p.reason}` : ''}]`,
    }
    const head = heads[p.outcome] ?? `[WHATSAPP CALL with ${who} — ${p.outcome}]`
    const lines = [head, `Call id: ${p.callId}`]
    if (p.task) lines.push(`Task: ${p.task}`)
    if (p.outcome === 'rejected' || p.outcome === 'missed') {
      lines.push('', 'They were not answered. Decide whether to text them back (con whatsapp send) — an unknown number gets nothing unless Yousef says so.')
    } else {
      lines.push('', 'Nothing was said. Decide whether to text instead or retry later; reply in this session only if Yousef needs to know.')
    }
    return lines.join('\n')
  }
  const lines = [
    `[WHATSAPP CALL with ${who}, ${formatDuration(p.durationMs)}, ${dir}]`,
    `Call id: ${p.callId}${p.delegations ? ` · ${p.delegations} delegate request(s) during the call` : ''}`,
  ]
  if (p.task) lines.push(`Task: ${p.task}`)
  lines.push('', 'Transcript:')
  for (const t of p.turns) {
    const stamp = typeof t.t === 'number' ? `${formatDuration(t.t).padStart(6)} ` : ''
    lines.push(`${stamp}${t.role === 'user' ? displayName : 'AL'}: ${t.text}`)
  }
  lines.push(
    '',
    'This call already happened; you (AL) spoke every "AL:" line above in Yousef\'s voice. Update memory/open-threads.md and the caller\'s users file as you would after a chat, and do anything you promised on the call. Reply in this session only if something needs Yousef.',
  )
  return lines.join('\n')
}

/** Everything the transcript route does with a payload, minus the injection
 *  (the caller owns the AL session + broadcast). Returns the envelope. */
export async function foldBackCall(p: CallTranscript, alJid: string): Promise<{ envelope: string; file: string; displayName: string }> {
  const caller = await lookupCaller(p.jid)
  const displayName = p.displayName || caller.displayName
  const file = await saveTranscript({ ...p, user: p.user ?? caller.user, displayName }, alJid)
  waHistory.record({
    ts: Date.now(),
    dir: p.direction === 'in' ? 'in' : 'out',
    jid: p.jid,
    user: p.user ?? caller.user,
    text: historyLineFor(p),
    via: p.direction === 'out' ? 'al-voice' : undefined,
    id: p.callId,
  })
  return { envelope: callEnvelope(p, displayName), file, displayName }
}

export async function listCallTranscripts(limit = 20, dir = TRANSCRIPTS_DIR): Promise<Array<Record<string, unknown>>> {
  let files: string[]
  try { files = await readdir(dir) } catch { return [] }
  const out: Array<Record<string, unknown>> = []
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    try {
      const rec = JSON.parse(await readFile(join(dir, f), 'utf-8')) as Record<string, unknown>
      out.push({
        callId: rec.callId, from: rec.from, to: rec.to, direction: rec.direction ?? null, outcome: rec.outcome ?? 'completed',
        displayName: rec.displayName ?? null, duration: rec.duration, timestamp: rec.timestamp, turns: Array.isArray(rec.transcript) ? rec.transcript.length : 0,
        task: rec.task ?? null, transport: rec.transport ?? 'atoms',
      })
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))
  return out.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Outbound (hub → pipeline)
// ---------------------------------------------------------------------------

/** A number AL has never exchanged a message with is never dialled — cold
 *  calls from an unofficial client are the documented fast-ban pattern. */
export function hasPriorChat(jidOrPhone: string): boolean {
  const user = resolveUsername(jidOrPhone)
  const ids = user ? identifiersFor(user) : []
  return waHistory.recentThread([jidOrPhone, ...ids], { limit: 1 }).length > 0
}

/** `to` may be a phone, a JID or a users/ slug. Returns a phone JID or null. */
export function resolveCallTarget(to: string): string | null {
  const t = to.trim()
  if (!t) return null
  if (/^[+\d][\d\s().-]{5,}$/.test(t)) {
    const phone = normalisePhone(t).replace(/^\+/, '')
    return phone ? `${phone}@s.whatsapp.net` : null
  }
  if (t.includes('@')) return /^\d+@(s\.whatsapp\.net|lid)$/.test(t) ? t : null
  // A users/<slug>: first phone-shaped identifier wins.
  const slug = t.toLowerCase()
  for (const id of identifiersFor(slug)) {
    if (/^\d{6,15}$/.test(id) && id.length <= 13) return `${id}@s.whatsapp.net`
  }
  return null
}

export async function requestOutboundCall(to: string, task: string, cfg = loadVoiceConfig()): Promise<{ ok: true; callId: string; to: string; displayName?: string } | { ok: false; status: number; error: string }> {
  const jid = resolveCallTarget(to)
  if (!jid) return { ok: false, status: 400, error: `cannot resolve "${to}" to a WhatsApp number (phone, JID or users/ slug)` }
  if (!hasPriorChat(jid)) return { ok: false, status: 403, error: `refusing to call ${jid}: AL has no prior WhatsApp chat with this number (cold calls risk the account)` }
  if (!task.trim()) return { ok: false, status: 400, error: 'missing task' }
  try {
    const res = await fetch(`${cfg.pipelineUrl}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid, task }),
      signal: AbortSignal.timeout(40_000),
    })
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) return { ok: false, status: res.status === 503 ? 503 : 502, error: String(data.detail ?? data.error ?? `pipeline ${res.status}`) }
    return { ok: true, callId: String(data.callId), to: jid, displayName: data.displayName ? String(data.displayName) : undefined }
  } catch (err) {
    return { ok: false, status: 503, error: `voice pipeline unreachable at ${cfg.pipelineUrl}: ${(err as Error)?.message ?? err}` }
  }
}

export async function pipelineHealth(cfg = loadVoiceConfig()): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${cfg.pipelineUrl}/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok ? (await res.json()) as Record<string, unknown> : null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// Sidecar relay (hub ↔ wa-voice) — QR into AL's session + status
// ---------------------------------------------------------------------------

export interface SidecarRelayCallbacks {
  /** A fresh pairing QR (the raw code; render it however Baileys' is rendered). */
  onQr: (code: string, timeoutSecs: number) => void
  onReady?: (jid: string) => void
  onLoggedOut?: () => void
}

export interface SidecarStatus {
  socket: boolean
  connected: boolean
  paired: boolean
  jid: string | null
  hasQr: boolean
  calls: unknown[]
}

let relayStatus: SidecarStatus = { socket: false, connected: false, paired: false, jid: null, hasQr: false, calls: [] }
let relayQr: { code: string; at: number } | null = null
let relaySocket: WebSocket | null = null
let relayStopped = false

export function getSidecarStatus(): SidecarStatus {
  return { ...relayStatus, hasQr: !!relayQr && Date.now() - relayQr.at < 60_000 }
}

export function getSidecarQr(): string | null {
  return relayQr && Date.now() - relayQr.at < 60_000 ? relayQr.code : null
}

/** Applies one sidecar event to the relay state; exported for tests. */
export function applySidecarEvent(ev: Record<string, unknown>, cb: Partial<SidecarRelayCallbacks>): void {
  switch (ev.ev) {
    case 'status':
      relayStatus = {
        ...relayStatus,
        connected: !!ev.connected,
        paired: !!ev.paired,
        jid: typeof ev.jid === 'string' ? ev.jid : relayStatus.jid,
        calls: Array.isArray(ev.calls) ? ev.calls : [],
      }
      break
    case 'ready':
      relayStatus = { ...relayStatus, connected: true, paired: true, jid: typeof ev.jid === 'string' ? ev.jid : relayStatus.jid }
      relayQr = null
      cb.onReady?.(String(ev.jid ?? ''))
      break
    case 'qr':
      if (typeof ev.code === 'string') {
        relayQr = { code: ev.code, at: Date.now() }
        relayStatus = { ...relayStatus, paired: false }
        cb.onQr?.(ev.code, Number(ev.timeoutSecs ?? 20))
      }
      break
    case 'disconnected':
      relayStatus = { ...relayStatus, connected: false }
      break
    case 'loggedout':
      relayStatus = { ...relayStatus, connected: false, paired: false, jid: null }
      cb.onLoggedOut?.()
      break
    default:
      break
  }
}

/** Keep a client on the sidecar socket; reconnect forever with backoff. */
export function startSidecarRelay(cb: SidecarRelayCallbacks, cfg = loadVoiceConfig()): () => void {
  relayStopped = false
  let backoff = 2000
  let timer: NodeJS.Timeout | null = null
  const connect = () => {
    if (relayStopped) return
    let ws: WebSocket
    try {
      ws = new WebSocket(cfg.sidecarUrl)
    } catch (err) {
      console.error('[al/voice] sidecar socket construct failed:', (err as Error)?.message)
      schedule()
      return
    }
    relaySocket = ws
    ws.on('open', () => {
      backoff = 2000
      relayStatus = { ...relayStatus, socket: true }
      console.log(`[al/voice] sidecar relay connected (${cfg.sidecarUrl})`)
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) return // call audio is the pipeline's business
      try {
        applySidecarEvent(JSON.parse(data.toString()) as Record<string, unknown>, cb)
      } catch (err) {
        console.error('[al/voice] sidecar event failed:', (err as Error)?.message)
      }
    })
    ws.on('error', (err) => {
      if (!/ECONNREFUSED/.test(err.message)) console.error('[al/voice] sidecar relay error:', err.message)
    })
    ws.on('close', () => {
      relayStatus = { ...relayStatus, socket: false, connected: false }
      relaySocket = null
      schedule()
    })
  }
  const schedule = () => {
    if (relayStopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 60_000)
  }
  connect()
  return () => {
    relayStopped = true
    if (timer) clearTimeout(timer)
    try { relaySocket?.close() } catch { /* noop */ }
    relaySocket = null
  }
}
