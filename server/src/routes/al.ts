// HTTP routes for the absorbed Al runtime — WhatsApp + voice.
//
//   GET  /whatsapp/status                 → { connected, hasQr }
//   GET  /whatsapp/qr                     → image/png QR (404 if connected)
//   POST /whatsapp/send  {to,text}        → { ok, id, jid }
//   POST /whatsapp/delete {to,messageId}  → { ok }
//   GET  /whatsapp/contacts?query=…       → { contacts: [...] }
//
//   GET  /voice/health                    → { ok: true }
//   POST /voice/delegate                  → { response }   (called by Atoms during a call)
//   POST /voice/call {phoneNumber,context} → { callId } | { error }
//   POST /voice/webhook                   → { ok }         (Atoms post-call)
//
// All WhatsApp routes require the hub bearer (Phase 8+ of the hub-auth
// refactor). Voice routes are marked always-open in auth-middleware.ts
// because Atoms posts to /voice/delegate + /voice/webhook from the public
// internet via al.amar.io → Caddy → hub.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as wa from '../al/whatsapp.js'
import * as voice from '../al/voice.js'
import { resolveUsername, ensureUserKnown } from '../al/users.js'
import { getAlSession } from '../al/al-session.js'
import { WORKSPACE_DIR } from '../al/identity.js'

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
      const { to, text } = JSON.parse(body || '{}') as { to?: string; text?: string }
      if (!to || typeof to !== 'string') return jsonResponse(res, 400, { error: 'missing to' })
      if (!text || typeof text !== 'string' || !text.trim()) {
        return jsonResponse(res, 400, { error: 'missing or empty text' })
      }
      try {
        const { id, jid } = await wa.sendText(to.trim(), text)
        jsonResponse(res, 200, { ok: true, id, jid })
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
  // Voice (Atoms integration)
  // ----------------------------------------------------------------------

  if (path === '/voice/health' && req.method === 'GET') {
    jsonResponse(res, 200, { ok: true })
    return true
  }

  if (path.startsWith('/voice/delegate') && (req.method === 'POST' || req.method === 'GET')) {
    handleVoiceDelegate(req, res, readBody).catch((err: Error) =>
      jsonResponse(res, 500, { error: err.message }))
    return true
  }

  if (path === '/voice/call' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { phoneNumber, context } = JSON.parse(body || '{}') as { phoneNumber?: string; context?: string }
      if (!phoneNumber) return jsonResponse(res, 400, { error: 'missing phoneNumber' })
      const result = await voice.makeOutboundCall(phoneNumber, context ?? '')
      jsonResponse(res, result.error ? 500 : 200, result)
    }).catch((err: Error) => jsonResponse(res, 400, { error: err.message }))
    return true
  }

  if (path === '/voice/webhook' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const payload = body ? JSON.parse(body) : {}
        await voice.handleWebhook(payload)
        jsonResponse(res, 200, { ok: true })
      } catch (err) {
        jsonResponse(res, 500, { error: (err as Error).message })
      }
    }).catch((err: Error) => jsonResponse(res, 400, { error: err.message }))
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
  const parsedUrl = new URL(req.url ?? '/', 'http://localhost')
  console.log(`[al/voice] delegate ${req.method} ${req.url}`)

  const body = rawBody ? JSON.parse(rawBody) : {}
  const callerPhone = body.callerPhone ?? body.caller_phone ?? body.from ?? body.fromNumber ?? ''
  const text = parsedUrl.searchParams.get('request') ?? body.request ?? body.text ?? body.message ?? ''

  if (!text) return jsonResponse(res, 400, { error: 'missing request field' })

  const al = getAlSession()
  if (!al) return jsonResponse(res, 503, { error: 'Al session not bootstrapped' })

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
