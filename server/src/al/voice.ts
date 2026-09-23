// AL's WhatsApp voice calls — the hub's half.
//
// Calls run on AL's own WhatsApp account (+447897073727, the same identity as
// the chat) through two sidecar processes the hub does NOT contain:
//
//   wa-voice (Rust, voice/wa-voice/)      — linked device #2 on AL's account;
//                                           ws://127.0.0.1:9878 control + 16 kHz PCM
//   al-voice-pipeline (Python, voice/pipeline/) — Pipecat: VAD → Cartesia STT →
//                                           the AL voice fork → Cartesia TTS (clone);
//                                           http://127.0.0.1:9879 for POST /call
//
// The call's brain is a real fork of the AL session (al/voice-fork.ts): the
// pipeline opens it at ring time (POST /voice/session), streams every
// utterance through it (POST /voice/turn → NDJSON text deltas → TTS), barges
// in with POST /voice/interrupt, and closes it with the transcript
// (POST /voice/transcript → call-transcripts/<id>.json, a wa-history line, the
// [WHATSAPP CALL …] envelope into the parent AL, one closing turn in the fork).
// This file owns the caller lookup + answer policy, the envelope inputs, the
// transcript fold-back, outbound dialling and the sidecar QR/status relay.
//
// Replaced the smallest.ai Atoms integration on 2026-09-20 (^wise-lark); the
// Bedrock voice-brain + `delegate` tool went the same day (^ripe-elk) after
// Yousef's first live call: "too many layers... make it a normal forked
// session with direct access to all the tools".

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { WORKSPACE_DIR, readIfExists } from './identity.js'
import { identifiersFor, normalize, parseFrontmatter, resolveUserFile, resolveUsername } from './users.js'
import * as waHistory from './wa-history.js'
import { buildCallEnvelope } from './voice-fork.js'

const TRANSCRIPTS_DIR = join(WORKSPACE_DIR, 'call-transcripts')
const HISTORY_TURNS = 30

// ---------------------------------------------------------------------------
// Config — ~/.config/console/voice.env (ports only; Cartesia lives in cartesia.env)
// ---------------------------------------------------------------------------

export interface VoiceConfig {
  sidecarUrl: string
  pipelineUrl: string
  /** Model for the call fork (`VOICE_FORK_MODEL`). Default Sonnet 5: measured
   *  2026-09-20 with AL's persona at AL's cwd, warm cache — first text at
   *  ~1.8-2.5 s (Sonnet 5) ≈ Haiku 4.5 (2.0-2.4 s) < Fable 5.1 (~2.9 s), and
   *  Sonnet's judgement on when to use a tool is the better of the three. */
  forkModel: string
  /** `fresh` (default: AL's persona as system prompt, envelope carries the
   *  caller context — smallest context, fastest turns) or `inherited`
   *  (`--fork-session` copy of AL's whole transcript). */
  forkContext: 'fresh' | 'inherited'
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
    forkModel: pick('VOICE_FORK_MODEL', 'claude-sonnet-5').trim() || 'claude-sonnet-5',
    forkContext: pick('VOICE_FORK_CONTEXT', 'fresh') === 'inherited' ? 'inherited' : 'fresh',
  }
}

// ---------------------------------------------------------------------------
// Caller lookup + answer policy
// ---------------------------------------------------------------------------

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

/** Everything the pipeline needs before it answers or dials, plus the
 *  envelope the fork is warmed with. `answer:false` → no fork, the pipeline
 *  rejects (inbound) or refuses (outbound). */
export interface CallPrep {
  answer: boolean
  why: string
  displayName: string
  user: string | null
  jid: string
  phone: string
  envelope: string
  /** ISO 639-1 the call STARTS in (users/<slug>.md `language:`; default en).
   *  Cartesia STT has no auto-detect, so this is what it listens in until AL
   *  speaks another language. */
  language: string
}

export function callerLanguage(fm: Record<string, string | string[]>): string {
  const raw = fm.language ?? fm.lang ?? fm.locale
  const v = Array.isArray(raw) ? raw[0] : raw
  const code = typeof v === 'string' ? v.trim().toLowerCase().split(/[-_]/)[0]! : ''
  return /^[a-z]{2}$/.test(code) ? code : 'en'
}

export async function prepareCall(rawJid: string, opts: { callId: string; direction: 'in' | 'out'; task?: string | null; now?: number; rulesInline?: string | null }): Promise<CallPrep> {
  const caller = await lookupCaller(rawJid)
  const policy = answerPolicy(caller, opts.direction)
  const base = { displayName: caller.displayName, user: caller.user, jid: caller.jid, phone: caller.phone, language: callerLanguage(caller.frontmatter) }
  if (!policy.answer) return { ...policy, ...base, envelope: '' }
  const openThreads = (await readIfExists(join(WORKSPACE_DIR, 'memory', 'open-threads.md'))) || ''
  const ids = caller.user ? identifiersFor(caller.user) : [caller.phone]
  const now = opts.now ?? Date.now()
  const history = waHistory.recentThread(ids.length ? ids : [caller.phone], { limit: HISTORY_TURNS })
  const envelope = buildCallEnvelope({
    callId: opts.callId,
    direction: opts.direction,
    displayName: caller.displayName,
    phone: caller.phone,
    user: caller.user,
    trust: caller.trust,
    userBody: caller.body,
    recentThread: history.map((e) => waHistory.formatHistoryLine(e, now)),
    openThreads,
    task: opts.task ?? null,
    now,
    rulesInline: opts.rulesInline ?? null,
  })
  return { ...policy, ...base, envelope }
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
  /** Set by the transcript route when the call had a live AL fork. */
  fork?: { forkKey: string; ttftMs: number[]; turnMs: number[] } | null
}

export interface ForkMeta { forkKey: string; ttftMs: number[]; turnMs: number[] }

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
    fork: p.fork ?? null,
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

/** The fold-back envelope for a call NO fork handled (rejected/missed/
 *  no-answer, or a legacy completed call). A call the fork ran hands itself
 *  back as a chat-fork digest instead (voice-fork.ts endCallFork) — the parent
 *  never gets a transcript the fork already has. */
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
    } else if (p.outcome === 'failed') {
      // The pipeline could not carry the call (call 008048b0, 23 Sept 2026:
      // 33 s of dead air). What the caller heard is at most the pre-rendered
      // clips, which the pipeline reports as turns.
      const spoken = p.turns.filter((t) => t.text.trim())
      if (p.answeredAt) {
        lines.push(`Answered: yes, ${formatDuration(p.durationMs)} — ${spoken.length ? `they heard only the canned line${spoken.length > 1 ? 's' : ''}: ${spoken.map((t) => `"${t.text}"`).join(' / ')}` : 'they heard NOTHING (no clip could be played)'}.`)
        lines.push('', `Text them now (con whatsapp send): a short apology for the broken call${spoken.length ? ' (you promised a message)' : ''}, and carry on by message or offer to call back once \`con whatsapp voice\` is green. Tell Yousef the call failed and why — this is a technical fault, not a busy signal.`)
      } else {
        lines.push('Answered: no — the call was ended before they picked up.')
        lines.push('', 'Decide whether to text instead or retry once `con whatsapp voice` is green; tell Yousef the call failed and why.')
      }
    } else {
      lines.push('', 'Nothing was said. Decide whether to text instead or retry later; reply in this session only if Yousef needs to know.')
    }
    return lines.join('\n')
  }
  const lines = [
    `[WHATSAPP CALL with ${who}, ${formatDuration(p.durationMs)}, ${dir}]`,
    `Call id: ${p.callId}${p.delegations ? ` · ${p.delegations} delegate request(s)` : ''}`,
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
export async function foldBackCall(p: CallTranscript, alJid: string, fork?: ForkMeta): Promise<{ envelope: string; file: string; displayName: string }> {
  const caller = await lookupCaller(p.jid)
  const displayName = p.displayName || caller.displayName
  if (fork) p = { ...p, fork }
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

/** The fork's last message once the call is over — the merge request: finish
 *  what it promised, write memory, then hand back a digest (its final message
 *  becomes the `[MERGE …]` envelope in AL). Not spoken. */
export function closingTurn(p: CallTranscript): string {
  const dur = formatDuration(p.durationMs)
  const head = p.outcome === 'completed'
    ? `[CALL ENDED after ${dur}${p.reason ? ` — ${p.reason}` : ''} — you are being folded back into AL and closed]`
    : `[CALL ${p.outcome.toUpperCase()}${p.reason ? ` — ${p.reason}` : ''} — you are being folded back into AL and closed]`
  return [
    head,
    'Nothing you write now is spoken. First do anything you promised on the call that is not done yet (messages, calendar, files), then update memory/open-threads.md and the caller\'s users file as you would after a chat — with no commentary while you work.',
    `Then, as your FINAL message, write the hand-back for your parent AL: who you spoke to, what was said and decided, what you did, anything open or that needs Yousef. Concise plain prose, no preamble, no transcript — the full transcript is call-transcripts/${p.callId}.json. You are closed right after.`,
  ].join('\n')
}

/** Hang up a live call through the pipeline (which lets the current TTS
 *  playout finish first). */
export async function requestHangup(callId: string, cfg = loadVoiceConfig()): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(`${cfg.pipelineUrl}/hangup/${encodeURIComponent(callId)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) })
    if (res.ok) return { ok: true }
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    return { ok: false, status: res.status === 404 ? 404 : 502, error: String(data.detail ?? data.error ?? `pipeline ${res.status}`) }
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

/** The current QR, or ask the sidecar for a fresh batch (`repair`) and wait
 *  for the first code. Null when paired, when the socket is down, or when
 *  nothing arrived within `waitMs`. */
export async function requestSidecarQr(waitMs = 8000): Promise<string | null> {
  const now = getSidecarQr()
  if (now) return now
  if (relayStatus.paired || !relaySocket || relaySocket.readyState !== WebSocket.OPEN) return null
  try { relaySocket.send(JSON.stringify({ cmd: 'repair' })) } catch { return null }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    const code = getSidecarQr()
    if (code) return code
  }
  return null
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
