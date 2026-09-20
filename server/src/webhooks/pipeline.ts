// Project webhooks — archive → resolve the project's owner → wake it with an
// envelope carrying the payload. The hub never interprets a payload: the
// OWNER decides what a delivery means (deploy finished, PR opened, form
// submitted…). Every hub touchpoint goes through `WebhookCtx` so the
// pipeline is stub-testable.

import { createHash } from 'node:crypto'
import type { WebhookStore, WebhookDelivery } from './store.js'
import type { EmitInput, HubEvent } from '../events/types.js'

export interface WebhookCtx {
  store: WebhookStore
  /** Board `default_owner:` → bound-roles convention → null (no owner). */
  resolveOwner: (project: string) => string | null
  /** Inject an envelope into the live session with this agentKey. False = not live. */
  deliverToAgent: (agentKey: string, envelope: string) => boolean
  /** Event bus seam. `emit` publishes `webhook.received`; `matchedListeners`
   *  says which listeners' filters matched it — when any did, they own the
   *  delivery and the legacy owner-wake below is skipped. */
  emit?: (input: EmitInput) => HubEvent | null
  matchedListeners?: (ev: HubEvent) => string[]
  log: (msg: string) => void
}

export interface InboundWebhook {
  project: string
  method: string
  subpath: string
  query: Record<string, string>
  headers: Record<string, string | string[] | undefined>
  source: string | null
  body: Buffer
  via: WebhookDelivery['via']
}

/** Providers cap well below this; it is a sanity ceiling, not a budget. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024
/** How much of the body rides in the envelope — the sidecar holds the rest. */
export const ENVELOPE_BODY_CHARS = 6000

const DROPPED_HEADERS = new Set([
  'authorization', 'cookie', 'proxy-authorization',
  'host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-prefix', 'x-real-ip',
])

/** Request headers minus credentials and transport noise, lower-cased, joined. */
export function sanitiseHeaders(headers: InboundWebhook['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase()
    if (DROPPED_HEADERS.has(key) || v === undefined) continue
    out[key] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

/** Query params minus the hub's own `token`. */
export function sanitiseQuery(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of params) if (k !== 'token') out[k] = v
  return out
}

const TEXT_TYPES = /^(text\/|application\/(json|x-www-form-urlencoded|xml|.*\+json|.*\+xml|javascript))/i

/** A body is text when its content-type says so or it decodes as clean UTF-8. */
export function bodyIsText(contentType: string | null, body: Buffer): boolean {
  if (contentType && TEXT_TYPES.test(contentType)) return true
  if (contentType && /^(image|audio|video|application\/octet-stream)/i.test(contentType)) return false
  if (body.length === 0) return true
  const s = body.toString('utf8')
  return !s.includes('�') && !/[\0-\x08\x0E-\x1F]/.test(s)
}

export function buildDelivery(store: WebhookStore, input: InboundWebhook, at = Date.now()): WebhookDelivery {
  const ct = (() => {
    const v = input.headers['content-type']
    return (Array.isArray(v) ? v[0] : v) ?? null
  })()
  const isText = bodyIsText(ct, input.body)
  return {
    id: store.mintId(at),
    project: input.project,
    receivedAt: at,
    method: input.method.toUpperCase(),
    subpath: input.subpath,
    query: input.query,
    headers: sanitiseHeaders(input.headers),
    contentType: ct,
    source: input.source,
    bodyBytes: input.body.length,
    ...(isText ? { bodyText: input.body.toString('utf8') } : { bodyBase64: input.body.toString('base64') }),
    via: input.via,
    route: { owner: null, delivered: false, at },
  }
}

/** The body as the owner should read it: pretty JSON when it parses, text
 *  as-is, a digest line for binary — clipped to ENVELOPE_BODY_CHARS. */
export function bodyPreview(rec: WebhookDelivery, max = ENVELOPE_BODY_CHARS): { text: string; truncated: boolean } {
  if (rec.bodyBase64 !== undefined) {
    const sha = createHash('sha256').update(Buffer.from(rec.bodyBase64, 'base64')).digest('hex').slice(0, 16)
    return { text: `<binary body, ${rec.bodyBytes} bytes, ${rec.contentType ?? 'unknown type'}, sha256 ${sha}…>`, truncated: false }
  }
  let text = rec.bodyText ?? ''
  if (text.trim()) {
    try { text = JSON.stringify(JSON.parse(text), null, 2) } catch { /* not JSON — as-is */ }
  }
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

function fmtWhen(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}

/** What the owner session receives. Facts first, the ask last; the sidecar
 *  id is the handle for everything the envelope leaves out. */
export function buildWebhookEnvelope(rec: WebhookDelivery, opts: { redelivery?: boolean } = {}): string {
  const lines: string[] = []
  lines.push(`[WEBHOOK — project ${rec.project}${opts.redelivery ? ', redelivered' : ''}] An external webhook for your project arrived. Nothing has acted on it — decide how to handle it (or ignore it).`)
  const from = [rec.source ? `from ${rec.source}` : null, rec.headers['user-agent'] ? `via ${rec.headers['user-agent']}` : null].filter(Boolean).join(' ')
  lines.push(`Delivery ${rec.id} · received ${fmtWhen(rec.receivedAt)}${from ? ` ${from}` : ''}${rec.via !== 'http' ? ` (${rec.via})` : ''}`)
  const qs = Object.entries(rec.query).map(([k, v]) => `${k}=${v}`).join('&')
  lines.push(`${rec.method} /hook/${rec.project}${rec.subpath}${qs ? `?${qs}` : ''} · ${rec.contentType ?? 'no content-type'} (${fmtBytes(rec.bodyBytes)})`)
  const shown = Object.entries(rec.headers).filter(([k]) => k !== 'user-agent' && k !== 'content-type' && k !== 'accept')
  if (shown.length) lines.push(`Headers: ${shown.map(([k, v]) => `${k}: ${v}`).join(' · ')}`)
  const body = bodyPreview(rec)
  if (rec.bodyBytes === 0) lines.push('Body: (empty)')
  else {
    lines.push('Body:')
    lines.push(body.text)
    if (body.truncated) lines.push(`[… ${fmtBytes(rec.bodyBytes - body.text.length)} more — \`con webhook show ${rec.id}\` for the full body]`)
  }
  lines.push(`Full record: \`con webhook show ${rec.id}\` · project history: \`con webhook list ${rec.project}\`.`)
  return lines.join('\n')
}

/** Archive → route → record the outcome. The record is saved BEFORE routing
 *  so a crash mid-delivery still leaves the payload on disk. */
export function processInbound(ctx: WebhookCtx, input: InboundWebhook): WebhookDelivery {
  const rec = ctx.store.save(buildDelivery(ctx.store, input))
  // Listeners first: a project that registered rules for its webhooks handles
  // them in software (or wakes on its own terms); the owner-wake is the
  // fallback for deliveries no rule claimed, so nothing silently vanishes.
  const ev = ctx.emit?.(webhookEvent(rec)) ?? null
  const handledBy = ev && ctx.matchedListeners ? ctx.matchedListeners(ev) : []
  if (handledBy.length) {
    rec.route = { owner: null, delivered: false, detail: `handled by listener(s) ${handledBy.join(', ')}`, at: Date.now() }
    rec.handledBy = handledBy
    ctx.store.save(rec)
    ctx.log(`[webhooks] ${rec.project} ${rec.method} ${rec.subpath || '/'} ${fmtBytes(rec.bodyBytes)} → listeners ${handledBy.join(', ')} ${rec.id}`)
    return rec
  }
  const outcome = route(ctx, rec, buildWebhookEnvelope(rec))
  rec.route = { ...outcome, at: Date.now() }
  ctx.store.save(rec)
  ctx.log(`[webhooks] ${rec.project} ${rec.method} ${rec.subpath || '/'} ${fmtBytes(rec.bodyBytes)} → ${outcome.delivered ? `@${outcome.owner}` : `undelivered (${outcome.detail})`} ${rec.id}`)
  return rec
}

/** The `webhook.received` event: provider headers + a parsed/clipped body, never the raw payload. */
export function webhookEvent(rec: WebhookDelivery): EmitInput {
  let json: unknown
  if (rec.bodyText && /json/i.test(rec.contentType ?? '')) {
    try { json = JSON.parse(rec.bodyText) } catch { /* not JSON after all */ }
  }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(rec.headers)) if (k !== 'accept' && k !== 'content-type' && k !== 'user-agent') headers[k] = v
  return {
    topic: 'webhook.received',
    source: `webhook:${rec.project}`,
    key: rec.id,
    at: rec.receivedAt,
    data: {
      project: rec.project,
      subpath: rec.subpath,
      method: rec.method,
      deliveryId: rec.id,
      contentType: rec.contentType,
      userAgent: rec.headers['user-agent'] ?? null,
      query: rec.query,
      headers,
      bodyPreview: rec.bodyText ? rec.bodyText.slice(0, 1024) : rec.bodyBase64 ? `<binary ${rec.bodyBytes} bytes>` : '',
      ...(json !== undefined ? { json: clipJson(json) } : {}),
    },
    ref: `con webhook show ${rec.id}`,
  }
}

const EVENT_JSON_CHARS = 8 * 1024

function clipJson(v: unknown): unknown {
  const s = JSON.stringify(v)
  if (s.length <= EVENT_JSON_CHARS) return v
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out: Record<string, unknown> = {}
    let used = 2
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const piece = JSON.stringify(val)
      if (used + piece.length + k.length + 4 > EVENT_JSON_CHARS) { out[k] = typeof val === 'string' ? `${val.slice(0, 200)}…` : '<clipped>'; continue }
      out[k] = val
      used += piece.length + k.length + 4
    }
    return out
  }
  return { _clipped: true, preview: s.slice(0, 2000) }
}

/** Replay an archived delivery to the project's CURRENT owner. */
export function redeliver(ctx: WebhookCtx, id: string): WebhookDelivery | null {
  const rec = ctx.store.get(id)
  if (!rec) return null
  const outcome = route(ctx, rec, buildWebhookEnvelope(rec, { redelivery: true }))
  rec.redeliveries = [...(rec.redeliveries ?? []), { ...outcome, at: Date.now() }]
  ctx.store.save(rec)
  ctx.log(`[webhooks] redeliver ${rec.id} → ${outcome.delivered ? `@${outcome.owner}` : `undelivered (${outcome.detail})`}`)
  return rec
}

function route(ctx: WebhookCtx, rec: WebhookDelivery, envelope: string): { owner: string | null; delivered: boolean; detail?: string } {
  const owner = ctx.resolveOwner(rec.project)
  if (!owner) return { owner: null, delivered: false, detail: `no owner for project ${rec.project} — no bound session and no default_owner: on its board` }
  const delivered = ctx.deliverToAgent(owner, envelope)
  return delivered ? { owner, delivered } : { owner, delivered: false, detail: `@${owner} is not live` }
}
