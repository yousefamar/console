// Deprecation shim for the old Al daemon's :18789 surface.
//
// The old al daemon exposed POST /message on :18789 as a localhost-only
// outbound channel for sibling agents on this machine. The new model uses
// `con whatsapp send` against /whatsapp/send on the hub. Until every caller
// is migrated, this shim:
//   * Listens on :18789 (localhost only — matches old semantics).
//   * Translates POST /message → wa.sendText(to, text) directly in-process.
//   * Logs every caller (remote, UA, body shape) to stdout so we can see who
//     hasn't migrated yet. After a week of zero calls, this whole file gets
//     deleted along with the Atoms-shim block in al.amar.io's Caddy entry.
//
// Voice routes (/voice/*) are NOT proxied here — Atoms hits al.amar.io which
// Caddy now routes directly to /voice/* on :9877. No shim needed there.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import * as wa from './whatsapp.js'

const SHIM_PORT = 18789

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function isLocal(req: IncomingMessage): boolean {
  const r = req.socket.remoteAddress ?? ''
  return r === '127.0.0.1' || r === '::1' || r === '::ffff:127.0.0.1'
}

export function startDeprecationShim(): void {
  const server = createServer(async (req, res) => {
    const url = req.url ?? ''
    const method = req.method ?? ''
    const remote = req.socket.remoteAddress ?? '-'
    const ua = req.headers['user-agent'] ?? '-'

    try {
      if (method === 'GET' && url === '/voice/health') {
        // Old al daemon answered /voice/health on :18789 too. Some callers
        // probe this to check Al liveness. Keep the contract.
        console.log(`[al/shim] ${remote} GET /voice/health (ua=${ua})`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, shim: true }))
        return
      }

      if (method === 'POST' && url === '/message') {
        if (!isLocal(req)) {
          console.warn(`[al/shim] /message non-localhost reject: ${remote}`)
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'localhost only' }))
          return
        }
        const rawBody = await readBody(req)
        let body: { to?: string; text?: string; channel?: string }
        try {
          body = JSON.parse(rawBody)
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid JSON body' }))
          return
        }
        const to = typeof body.to === 'string' ? body.to.trim() : ''
        const text = typeof body.text === 'string' ? body.text : ''
        const channel = body.channel ?? 'whatsapp'

        console.log(`[al/shim] DEPRECATED /message from ${remote} (ua=${ua}) → channel=${channel} to=${to.slice(0, 40)}`)

        if (channel !== 'whatsapp') {
          // Slack was dropped in the absorb. Old callers asking for slack get
          // a clear 410 so the failure is loud, not silent.
          res.writeHead(410, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `channel "${channel}" no longer supported — Slack was dropped in the Al rebuild` }))
          return
        }
        if (!to) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'missing to' }))
          return
        }
        if (!text.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'missing or empty text' }))
          return
        }
        if (!wa.isConnected()) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'WhatsApp not connected (possibly awaiting QR pair)' }))
          return
        }
        try {
          // Old shim prefixed text with "[Al] ". Preserve that contract so
          // existing recipients see the same attribution.
          const { id, jid } = await wa.sendText(to, `[Al] ${text}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, channel: 'whatsapp', to: jid, id, deprecated: 'use `con whatsapp send` instead' }))
        } catch (err) {
          const msg = (err as Error)?.message ?? 'unknown'
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `send failed: ${msg}` }))
        }
        return
      }

      // Anything else — log + 404 so we can spot stragglers.
      console.log(`[al/shim] 404 ${remote} ${method} ${url} (ua=${ua})`)
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'shim only forwards POST /message + GET /voice/health' }))
    } catch (err) {
      console.error('[al/shim] handler threw:', (err as Error)?.message)
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'shim internal error' }))
      } catch { /* socket already gone */ }
    }
  })

  server.on('error', (err) => {
    // EADDRINUSE most likely means old al daemon never stopped. Don't crash
    // the hub — just log loudly and skip the shim.
    console.error('[al/shim] failed to bind :18789:', (err as Error)?.message)
  })

  server.listen(SHIM_PORT, '127.0.0.1', () => {
    console.log(`[al/shim] deprecation shim listening on 127.0.0.1:${SHIM_PORT}`)
  })
}
