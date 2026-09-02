// Pebble Index 01 ring routes. The ring's app POSTs multipart/form-data to
// /ring/webhook with `audio` (audio/mp4), `transcription`, `recordedAt`,
// `client` — plus whatever headers the user configures (we ask for
// `Authorization: Bearer <ring-scoped token>`, which the normal auth wall
// validates; nothing here is exempt). The ring never shows our response, so
// feedback goes out via push (see ring/pipeline.ts).

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { multipartBoundary, parseMultipart } from '../ring/multipart.js'
import { processDelivery, type RingCtx, type RingDelivery } from '../ring/pipeline.js'

/** 2 min of M4A is well under 5 MB; this is just a sanity ceiling. */
const MAX_BODY_BYTES = 25 * 1024 * 1024

function readRaw(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) { reject(new Error(`body exceeds ${max} bytes`)); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function deliveryFromRequest(contentType: string | undefined, body: Buffer): RingDelivery {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.startsWith('multipart/')) {
    const boundary = multipartBoundary(contentType)
    if (!boundary) throw new Error('multipart body without boundary')
    const parts = parseMultipart(body, boundary)
    const field = (name: string) => parts.find((p) => p.name === name && !p.filename && p.data.length)?.data.toString('utf8').trim() ?? null
    const audioPart = parts.find((p) => p.name === 'audio' && p.data.length)
    const recordedAt = Number(field('recordedAt'))
    return {
      transcription: field('transcription'),
      audio: audioPart ? { data: audioPart.data, contentType: audioPart.contentType ?? 'audio/mp4' } : null,
      recordedAt: Number.isFinite(recordedAt) && recordedAt > 0 ? recordedAt : null,
      client: field('client'),
    }
  }
  // JSON — the `con ring say` simulator and any text-only integration.
  const json = JSON.parse(body.toString('utf8') || '{}') as { transcription?: string; text?: string; recordedAt?: number; client?: string }
  const transcription = (json.transcription ?? json.text ?? '').trim()
  return {
    transcription: transcription || null,
    audio: null,
    recordedAt: typeof json.recordedAt === 'number' ? json.recordedAt : null,
    client: json.client ?? 'simulated',
  }
}

export function handleRingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  ctx: RingCtx,
  readBody: (req: IncomingMessage) => Promise<string>,
  webhookUrl: string,
): boolean {
  if (!path.startsWith('/ring')) return false
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  if (path === '/ring/webhook' && req.method === 'POST') {
    readRaw(req).then(async (body) => {
      const delivery = deliveryFromRequest(req.headers['content-type'], body)
      const rec = await processDelivery(ctx, delivery)
      json({ ok: true, id: rec.id, transcription: rec.transcription, route: rec.route ?? null })
    }).catch((err: Error) => {
      ctx.log(`[ring] webhook rejected: ${err.message}`)
      json({ error: err.message }, 400)
    })
    return true
  }

  if (path === '/ring/status' && req.method === 'GET') {
    const latest = ctx.store.list(1)[0]
    json({
      webhookUrl,
      recordings: ctx.store.count(),
      lastRecordedAt: latest?.recordedAt ?? null,
      config: ctx.store.config(),
      agents: ctx.agents().map((a) => ({ id: a.id, name: a.name, agentKey: a.agentKey })),
    })
    return true
  }

  if (path === '/ring/config' && req.method === 'POST') {
    readBody(req).then((body) => {
      const patch = JSON.parse(body || '{}') as { fallbackAgent?: string | null; llmFallback?: boolean }
      const out: { fallbackAgent?: string | null; llmFallback?: boolean } = {}
      if ('fallbackAgent' in patch) out.fallbackAgent = patch.fallbackAgent ? String(patch.fallbackAgent) : null
      if (typeof patch.llmFallback === 'boolean') out.llmFallback = patch.llmFallback
      json({ ok: true, config: ctx.store.setConfig(out) })
    }).catch((err: Error) => json({ error: err.message }, 400))
    return true
  }

  if (path === '/ring/recordings' && req.method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
    json({ recordings: ctx.store.list(limit).map(({ audio, ...r }) => ({ ...r, audio: audio ? { bytes: audio.bytes, contentType: audio.contentType } : null })) })
    return true
  }

  const audioMatch = /^\/ring\/recordings\/([^/]+)\/audio$/.exec(path)
  if (audioMatch && req.method === 'GET') {
    const id = decodeURIComponent(audioMatch[1]!)
    const p = ctx.store.audioPath(id)
    const rec = ctx.store.get(id)
    if (!p || !rec?.audio) { json({ error: 'not found' }, 404); return true }
    res.writeHead(200, { 'Content-Type': rec.audio.contentType, 'Content-Length': String(rec.audio.bytes), 'Cache-Control': 'private, max-age=31536000' })
    createReadStream(p).pipe(res)
    return true
  }

  const oneMatch = /^\/ring\/recordings\/([^/]+)$/.exec(path)
  if (oneMatch && req.method === 'GET') {
    const rec = ctx.store.get(decodeURIComponent(oneMatch[1]!))
    if (!rec) { json({ error: 'not found' }, 404); return true }
    json(rec)
    return true
  }

  return false
}
