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
//   GET  /voice/status                    → { sidecar, pipeline }
//   GET  /voice/qr                        → image/png pairing QR for the wa-voice device (404 when paired)
//   GET  /voice/context?jid&task&direction → { answer, why, systemPrompt, displayName, user, jid }
//   POST /voice/delegate {request,callerPhone,callId} → { response }   (pipeline, mid-call)
//   POST /voice/transcript {callId,jid,direction,outcome,turns,…}     → { ok, file }  (pipeline, post-call)
//   POST /voice/call {to,task}            → { ok, callId, to } | { error }  (→ pipeline → sidecar)
//   GET  /voice/calls?limit=N             → { calls: [...] }
//
// Every route here requires the hub bearer. The voice pipeline is a local
// process (voice/pipeline/) carrying the `voice`-scoped token from
// local-tokens.json; only /voice/health is exempt. Atoms is gone (^wise-lark).

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as wa from '../al/whatsapp.js'
import * as tts from '../al/tts.js'
import * as voice from '../al/voice.js'
import { record as recordHistory } from '../al/wa-history.js'
import { resolveUsername, ensureUserKnown } from '../al/users.js'
import { getAlSession, injectToAl } from '../al/al-session.js'
import { WORKSPACE_DIR } from '../al/identity.js'
import QRCode from 'qrcode'

/** Hub-side wiring the voice routes need but the route signature lacks: the
 *  SPA broadcast for AL injections. Set once from index.ts at boot. */
let voiceBroadcast: ((msg: any) => void) | null = null
export function setVoiceRouteContext(ctx: { broadcast: (msg: any) => void }): void {
  voiceBroadcast = ctx.broadcast
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
    voice.pipelineHealth().then((pipeline) => jsonResponse(res, 200, { sidecar: voice.getSidecarStatus(), pipeline }))
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

  if (path === '/voice/context' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const jid = (url.searchParams.get('jid') || '').trim()
    const task = url.searchParams.get('task') || undefined
    const direction = url.searchParams.get('direction') === 'out' ? 'out' : 'in'
    if (!jid || !voice.normalisePhone(jid.split('@')[0]!)) return (jsonResponse(res, 400, { error: 'missing or non-phone jid' }), true)
    voice.buildCallContext(jid, { task, direction })
      .then((ctx) => {
        console.log(`[al/voice] context for ${jid} (${direction}): answer=${ctx.answer} (${ctx.why}), ${ctx.systemPrompt.length} chars`)
        jsonResponse(res, 200, ctx)
      })
      .catch((err: Error) => jsonResponse(res, 500, { error: err.message }))
    return true
  }

  // POST only: a GET here would fire from a bare URL (img src, link, crawler).
  if (path === '/voice/delegate' && req.method === 'POST') {
    handleVoiceDelegate(req, res, readBody).catch((err: Error) =>
      jsonResponse(res, 500, { error: err.message }))
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
        const { envelope, file, displayName } = await voice.foldBackCall(payload, alJid)
        const injected = voiceBroadcast ? injectToAl(envelope, voiceBroadcast) : false
        console.log(`[al/voice] call ${payload.callId} with ${displayName}: ${payload.outcome}, ${payload.turns.length} turns → ${file}${injected ? ', folded into AL' : ', AL not injected'}`)
        jsonResponse(res, 200, { ok: true, file, injected })
      } catch (err) {
        jsonResponse(res, 500, { error: (err as Error).message })
      }
    }).catch((err: Error) => jsonResponse(res, 400, { error: err.message }))
    return true
  }

  if (path === '/voice/calls' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 20))
    voice.listCallTranscripts(limit).then((calls) => jsonResponse(res, 200, { calls }))
      .catch((err: Error) => jsonResponse(res, 500, { error: err.message }))
    return true
  }

  return false
}

async function handleVoiceDelegate(
  req: IncomingMessage,
  res: ServerResponse,
  readBody: (req: IncomingMessage) => Promise<string>,
): Promise<void> {
  const rawBody = await readBody(req)
  console.log('[al/voice] delegate POST')

  const body = rawBody ? JSON.parse(rawBody) : {}
  const rawPhone = body.callerPhone ?? body.caller_phone ?? body.from ?? body.fromNumber ?? ''
  const text = body.request ?? body.text ?? body.message ?? ''

  if (typeof text !== 'string' || !text) return jsonResponse(res, 400, { error: 'missing request field' })
  // The phone names the caller in Al's envelope AND seeds a users/<phone>.md
  // record — only a phone-shaped value may do either.
  const callerPhone = voice.normalisePhone(rawPhone)
  if (rawPhone && !callerPhone) console.warn(`[al/voice] delegate: ignoring non-phone callerPhone ${JSON.stringify(String(rawPhone)).slice(0, 40)}`)

  const al = getAlSession()
  if (!al) return jsonResponse(res, 503, { error: 'AL session not bootstrapped' })

  if (callerPhone) {
    ensureUserKnown(callerPhone, 'voice').catch((err: Error) =>
      console.error('[al/voice] ensureUserKnown failed:', err.message))
  }

  const resolvedUser = callerPhone ? resolveUsername(callerPhone) : null
  const response = await voice.handleDelegate(al, callerPhone, text, resolvedUser)
  jsonResponse(res, 200, { response })
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
