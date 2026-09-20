// HTTP routes for the absorbed Al runtime — WhatsApp + voice.
//
//   GET  /whatsapp/status                 → { connected, hasQr }
//   GET  /whatsapp/qr                     → image/png QR (404 if connected)
//   POST /whatsapp/send  {to,text}        → { ok, id, jid }
//                        {to,speak,language?,speed?} → same + { voiceNote, seconds }  (Cartesia TTS in Yousef's voice → ptt)
//                        {to,audio(base64)}          → same  (any audio file → ptt)
//   POST /whatsapp/delete {to,messageId}  → { ok }
//   GET  /whatsapp/contacts?query=…       → { contacts: [...] }
//
//   GET  /voice/health                    → { ok: true }                (the only open one)
//   GET  /voice/status                    → { sidecar, pipeline, live: [...] }
//   GET  /voice/qr                        → image/png pairing QR for the wa-voice device (404 when paired)
//   POST /voice/session {callId,jid,direction,task} → { answer, why, displayName, user, jid, language, forkSessionId }
//                                           (pipeline, at ring time: answer policy + fork AL for the call)
//   POST /voice/turn {callId,text,cue?,interruptedAfter?} → NDJSON stream of
//                                           {type:text|tool|result|error} until the fork's turn ends
//   POST /voice/interrupt {callId}        → { ok, method }  (barge-in: stop the fork's turn)
//   POST /voice/hangup {callId}           → { ok }          (the fork's own `con whatsapp hangup`; → pipeline)
//   POST /voice/transcript {callId,jid,direction,outcome,turns,…} → { ok, file, fork }  (pipeline, post-call; the fork merges into AL as a digest)
//   POST /voice/call {to,task}            → { ok, callId, to } | { error }  (→ pipeline → sidecar)
//   GET  /voice/calls?limit=N             → { live: [...], calls: [...] }
//
// Every route here requires the hub bearer. The voice pipeline is a local
// process (voice/pipeline/) carrying the `voice`-scoped token from
// local-tokens.json; only /voice/health is exempt. Atoms is gone (^wise-lark),
// so is the Bedrock voice-brain + /voice/delegate (^ripe-elk).

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as wa from '../al/whatsapp.js'
import * as tts from '../al/tts.js'
import * as voice from '../al/voice.js'
import * as voiceFork from '../al/voice-fork.js'
import { record as recordHistory } from '../al/wa-history.js'
import { resolveUsername } from '../al/users.js'
import { injectToAl } from '../al/al-session.js'
import { WORKSPACE_DIR } from '../al/identity.js'
import QRCode from 'qrcode'

/** Hub-side wiring the voice routes need but the route signature lacks: the
 *  SPA broadcast for AL injections (the fork machinery gets its own context
 *  via voiceFork.setVoiceForkContext). Set once from index.ts at boot. */
let voiceBroadcast: ((msg: any) => void) | null = null
export function setVoiceRouteContext(ctx: { broadcast: (msg: any) => void }): void {
  voiceBroadcast = ctx.broadcast
}

function ndjsonLine(res: ServerResponse, obj: unknown): void {
  if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`)
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function handleAlRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  // ----------------------------------------------------------------------
  // WhatsApp
  // ----------------------------------------------------------------------

  if (path === '/whatsapp/status' && req.method === 'GET') {
    jsonResponse(res, 200, { connected: wa.isConnected(), hasQr: !!wa.getQrDataUrl() })
    return true
  }

  if (path === '/whatsapp/qr' && req.method === 'GET') {
    const dataUrl = wa.getQrDataUrl()
    if (!dataUrl) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('No QR available. WhatsApp is paired or initialising.')
      return true
    }
    // dataUrl is "data:image/png;base64,XXXX" — strip prefix, send as image/png
    const comma = dataUrl.indexOf(',')
    if (comma < 0) {
      jsonResponse(res, 500, { error: 'malformed QR data URL' })
      return true
    }
    const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64')
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store, must-revalidate',
    })
    res.end(buf)
    return true
  }

  if (path === '/whatsapp/send' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { to, text, speak, language, speed, audio } = JSON.parse(body || '{}') as {
        to?: string; text?: string; speak?: string; language?: string; speed?: number; audio?: string
      }
      if (!to || typeof to !== 'string') return jsonResponse(res, 400, { error: 'missing to' })
      const modes = [text, speak, audio].filter((v) => typeof v === 'string' && v.trim()).length
      if (modes !== 1) {
        return jsonResponse(res, 400, { error: 'provide exactly one of text, speak (spoken as a voice note) or audio (base64, sent as a voice note)' })
      }
      const spokenOrTyped = (text ?? speak)!
      if (typeof spokenOrTyped === 'string' && wa.findBlockedTerm(spokenOrTyped)) {
        console.warn('[al/wa] outbound send BLOCKED — message matched censored-content policy')
        return jsonResponse(res, 400, { error: 'blocked: message contains censored content (home address)' })
      }
      try {
        // `user` labels the send in the caller's transcript with the SAME
        // resolved name the inbound envelope uses, so "sent to Veronica @phone"
        // and "reply from Nica @lid" visibly meet in one identity.
        // X-Console-Agent = the sending session's agentKey (CLI sets it from
        // CONSOLE_AGENT_KEY); absent means the parent AL or a human terminal.
        const via = (req.headers['x-console-agent'] as string | undefined)?.trim() || 'al'
        if (text) {
          const { id, jid } = await wa.sendText(to.trim(), text)
          const user = resolveUsername(jid)
          recordHistory({ ts: Date.now(), dir: 'out', jid, user, text, via, id })
          return jsonResponse(res, 200, { ok: true, id, jid, user })
        }
        const wav = speak
          ? await tts.synthesise(speak, { language, speed })
          : Buffer.from(audio!, 'base64')
        const { id, jid, seconds } = await wa.sendVoiceNote(to.trim(), wav)
        const user = resolveUsername(jid)
        recordHistory({ ts: Date.now(), dir: 'out', jid, user, text: `(voice note, ${seconds}s) ${speak ?? '[audio file]'}`, via, id })
        jsonResponse(res, 200, { ok: true, id, jid, user, voiceNote: true, seconds })
      } catch (err) {
        const msg = (err as Error)?.message ?? 'unknown'
        const status = /not connected/i.test(msg) ? 503 : 500
        jsonResponse(res, status, { error: msg })
      }
    }).catch((err: Error) => jsonResponse(res, 400, { error: err.message }))
    return true
  }

  if (path === '/whatsapp/delete' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { to, messageId } = JSON.parse(body || '{}') as { to?: string; messageId?: string }
      if (!to || !messageId) return jsonResponse(res, 400, { error: 'missing to or messageId' })
      try {
        await wa.deleteForEveryone(to.trim(), messageId.trim())
        jsonResponse(res, 200, { ok: true })
      } catch (err) {
        const msg = (err as Error)?.message ?? 'unknown'
        const status = /not connected/i.test(msg) ? 503 : 500
        jsonResponse(res, status, { error: msg })
      }
    }).catch((err: Error) => jsonResponse(res, 400, { error: err.message }))
    return true
  }

  if (path === '/whatsapp/contacts' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const query = (url.searchParams.get('query') || '').toLowerCase()
    listContacts(query).then((contacts) => jsonResponse(res, 200, { contacts }))
      .catch((err: Error) => jsonResponse(res, 500, { error: err.message }))
    return true
  }

  // ----------------------------------------------------------------------
  // Voice (WhatsApp calls via wa-voice + al-voice-pipeline)
  // ----------------------------------------------------------------------

  if (path === '/voice/health' && req.method === 'GET') {
    jsonResponse(res, 200, { ok: true })
    return true
  }

  if (path === '/voice/status' && req.method === 'GET') {
    voice.pipelineHealth().then((pipeline) => jsonResponse(res, 200, { sidecar: voice.getSidecarStatus(), pipeline, live: voiceFork.getLiveCalls() }))
    return true
  }

  if (path === '/voice/qr' && req.method === 'GET') {
    voice.requestSidecarQr().then(async (code) => {
      if (!code) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('No voice-device QR available. wa-voice is paired, down, or did not issue one within 8 s.')
        return
      }
      const buf = await QRCode.toBuffer(code, { width: 300 })
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store, must-revalidate' })
      res.end(buf)
    }).catch((err: Error) => jsonResponse(res, 500, { error: err.message }))
    return true
  }

  // Ring time: answer policy + fork AL for the call. The fork's warm turn runs
  // while the phone rings so the first utterance meets a live process.
  if (path === '/voice/session' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const b = JSON.parse(body || '{}') as { callId?: unknown; jid?: unknown; direction?: unknown; task?: unknown }
      if (!voice.isSafeCallId(b.callId)) return jsonResponse(res, 400, { error: 'missing or unsafe callId' })
      const jid = typeof b.jid === 'string' ? b.jid.trim() : ''
      if (!jid || !voice.normalisePhone(jid.split('@')[0]!)) return jsonResponse(res, 400, { error: 'missing or non-phone jid' })
      const direction = b.direction === 'out' ? 'out' : 'in'
      const task = typeof b.task === 'string' && b.task.trim() ? b.task.trim() : null
      const cfg = voice.loadVoiceConfig()
      const prep = await voice.prepareCall(jid, {
        callId: b.callId, direction, task,
        rulesInline: cfg.forkContext === 'inherited' ? voiceFork.voiceForkRules(b.callId) : null,
      })
      console.log(`[al/voice] session ${b.callId} for ${jid} (${direction}): answer=${prep.answer} (${prep.why})`)
      if (!prep.answer) return jsonResponse(res, 200, { answer: false, why: prep.why, displayName: prep.displayName, user: prep.user, jid: prep.jid })
      try {
        const call = await voiceFork.startCallFork({
          callId: b.callId, jid: prep.jid, phone: prep.phone, displayName: prep.displayName, user: prep.user,
          direction, task, envelope: prep.envelope, model: cfg.forkModel, contextMode: cfg.forkContext,
        })
        jsonResponse(res, 200, { answer: true, why: prep.why, displayName: prep.displayName, user: prep.user, jid: prep.jid, language: prep.language, forkSessionId: call.fork.id, forkKey: call.forkKey, model: call.model, contextMode: call.contextMode })
      } catch (err) {
        const msg = (err as Error)?.message ?? 'fork failed'
        jsonResponse(res, /not bootstrapped|not wired/.test(msg) ? 503 : 500, { error: msg })
      }
    }).catch((err: Error) => jsonResponse(res, 400, { error: err.message }))
    return true
  }

  // One utterance → the fork's reply, streamed as NDJSON while it is generated.
  if (path === '/voice/turn' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const b = JSON.parse(body || '{}') as { callId?: unknown; text?: unknown; cue?: unknown; interruptedAfter?: unknown }
      if (!voice.isSafeCallId(b.callId)) return jsonResponse(res, 400, { error: 'missing or unsafe callId' })
      const text = typeof b.text === 'string' ? b.text.trim() : ''
      if (!text) return jsonResponse(res, 400, { error: 'missing text' })
      if (!voiceFork.getLiveCall(b.callId)) return jsonResponse(res, 404, { error: `no live call ${b.callId}` })
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
      res.flushHeaders()
      const sink = (ev: voiceFork.TurnEvent) => ndjsonLine(res, ev)
      const done = b.cue === true
        ? await voiceFork.runCue(b.callId, text, sink)
        : await voiceFork.runTurn(b.callId, text, sink, { interruptedAfter: typeof b.interruptedAfter === 'string' ? b.interruptedAfter : null })
      if (done.type === 'result') console.log(`[al/voice] ${b.callId}: turn ${done.ms} ms (first text ${done.ttftMs ?? '-'} ms${done.interrupted ? ', interrupted' : ''})`)
      res.end()
    }).catch((err: Error) => {
      if (res.headersSent) { ndjsonLine(res, { type: 'error', message: err.message }); res.end() }
      else jsonResponse(res, 400, { error: err.message })
    })
    return true
  }

  if (path === '/voice/interrupt' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const b = JSON.parse(body || '{}') as { callId?: unknown }
      if (!voice.isSafeCallId(b.callId)) return jsonResponse(res, 400, { error: 'missing or unsafe callId' })
      const out = await voiceFork.interruptCall(b.callId)
      jsonResponse(res, out.ok ? 200 : 404, out)
    }).catch((err: Error) => jsonResponse(res, 400, { error: err.message }))
    return true
  }

  // The fork (or anyone with the bearer) ends the call: forwarded to the
  // pipeline, which lets the goodbye finish playing before it hangs up.
  if (path === '/voice/hangup' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const b = JSON.parse(body || '{}') as { callId?: unknown }
      if (!voice.isSafeCallId(b.callId)) return jsonResponse(res, 400, { error: 'missing or unsafe callId' })
      const out = await voice.requestHangup(b.callId)
      jsonResponse(res, out.ok ? 200 : out.status, out.ok ? { ok: true, callId: b.callId } : { error: out.error })
    }).catch((err: Error) => jsonResponse(res, 400, { error: err.message }))
    return true
  }

  if (path === '/voice/call' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const b = JSON.parse(body || '{}') as { to?: string; task?: string; phoneNumber?: string; context?: string }
      const to = (b.to ?? b.phoneNumber ?? '').trim()
      const task = (b.task ?? b.context ?? '').trim()
      if (!to) return jsonResponse(res, 400, { error: 'missing to' })
      const result = await voice.requestOutboundCall(to, task)
      if (result.ok) {
        console.log(`[al/voice] outbound call ${result.callId} → ${result.to}: ${task.slice(0, 80)}`)
        return jsonResponse(res, 200, result)
      }
      jsonResponse(res, result.status, { error: result.error })
    }).catch((err: Error) => jsonResponse(res, 400, { error: err.message }))
    return true
  }

  if (path === '/voice/transcript' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const p = JSON.parse(body || '{}') as Partial<voice.CallTranscript>
      if (!voice.isSafeCallId(p.callId)) return jsonResponse(res, 400, { error: 'missing or unsafe callId' })
      if (typeof p.jid !== 'string' || !voice.normalisePhone(p.jid.split('@')[0]!)) return jsonResponse(res, 400, { error: 'missing or non-phone jid' })
      const payload: voice.CallTranscript = {
        callId: p.callId,
        jid: p.jid,
        user: typeof p.user === 'string' ? p.user : null,
        displayName: typeof p.displayName === 'string' ? p.displayName : undefined,
        direction: p.direction === 'out' ? 'out' : 'in',
        outcome: typeof p.outcome === 'string' ? p.outcome : 'completed',
        reason: typeof p.reason === 'string' ? p.reason : null,
        task: typeof p.task === 'string' ? p.task : null,
        startedAt: typeof p.startedAt === 'string' ? p.startedAt : null,
        answeredAt: typeof p.answeredAt === 'string' ? p.answeredAt : null,
        durationMs: Number(p.durationMs) || 0,
        turns: Array.isArray(p.turns)
          ? p.turns.filter((t) => t && typeof t.text === 'string').map((t) => ({ role: t.role === 'user' ? 'user' : 'assistant', text: t.text, t: typeof t.t === 'number' ? t.t : undefined }))
          : [],
        delegations: Number(p.delegations) || 0,
        latency: p.latency,
        models: p.models,
      }
      try {
        const alJid = wa.ownNumber() ? `${wa.ownNumber()}@s.whatsapp.net` : (voice.getSidecarStatus().jid ?? 'al')
        const fork = await voiceFork.endCallFork(payload.callId, voice.closingTurn(payload), { merge: payload.outcome === 'completed' })
        const { envelope, file, displayName } = await voice.foldBackCall(payload, alJid, fork ? { forkKey: fork.forkKey, ttftMs: fork.ttftMs, turnMs: fork.turnMs } : undefined)
        // A fork that ran the call hands itself back as a digest (chat-fork
        // merge); the parent gets the transcript envelope only when nobody
        // else has it — rejected/missed/unanswered calls, or no fork at all.
        const injected = fork?.merging ? false : (voiceBroadcast ? injectToAl(envelope, voiceBroadcast) : false)
        console.log(`[al/voice] call ${payload.callId} with ${displayName}: ${payload.outcome}, ${payload.turns.length} turns → ${file}${fork?.merging ? `, fork ${fork.forkKey} merging into AL` : injected ? ', envelope into AL' : ', AL not injected'}`)
        jsonResponse(res, 200, { ok: true, file, injected, fork: fork ? { forkSessionId: fork.forkSessionId, forkKey: fork.forkKey, merging: fork.merging } : null })
      } catch (err) {
        jsonResponse(res, 500, { error: (err as Error).message })
      }
    }).catch((err: Error) => jsonResponse(res, 400, { error: err.message }))
    return true
  }

  if (path === '/voice/calls' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 20))
    voice.listCallTranscripts(limit).then((calls) => jsonResponse(res, 200, { live: voiceFork.getLiveCalls(), calls }))
      .catch((err: Error) => jsonResponse(res, 500, { error: err.message }))
    return true
  }

  return false
}

// --- contacts ---

interface Contact {
  username: string
  identifiers: { whatsapp?: string[]; phone?: string[]; slack?: string[] }
  filePath: string
}

async function listContacts(query: string): Promise<Contact[]> {
  const usersDir = join(WORKSPACE_DIR, 'users')
  let files: string[]
  try {
    files = await readdir(usersDir)
  } catch {
    return []
  }
  const out: Contact[] = []
  for (const f of files) {
    if (!f.endsWith('.md')) continue
    const username = f.replace(/\.md$/, '')
    const filePath = join(usersDir, f)
    let content: string
    try { content = await readFile(filePath, 'utf-8') } catch { continue }
    const fm = parseFrontmatter(content)
    const identifiers: Contact['identifiers'] = {}
    for (const key of ['whatsapp', 'phone', 'slack'] as const) {
      const v = fm[key]
      if (Array.isArray(v)) identifiers[key] = v
      else if (typeof v === 'string') identifiers[key] = [v]
    }
    const contact: Contact = { username, identifiers, filePath }
    if (!query) {
      out.push(contact)
      continue
    }
    const haystack = [
      username,
      ...(identifiers.whatsapp ?? []),
      ...(identifiers.phone ?? []),
      ...(identifiers.slack ?? []),
    ].join(' ').toLowerCase()
    if (haystack.includes(query)) out.push(contact)
  }
  return out
}

function parseFrontmatter(content: string): Record<string, string | string[]> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return {}
  const result: Record<string, string | string[]> = {}
  let listKey: string | null = null
  for (const line of match[1].split('\n')) {
    if (listKey && /^\s+-\s+/.test(line)) {
      const val = line.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, '')
      if (val) (result[listKey] as string[]).push(val)
      continue
    }
    listKey = null
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
    if (key && !val) { result[key] = []; listKey = key }
    else if (key && val) result[key] = val
  }
  return result
}
