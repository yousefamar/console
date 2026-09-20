// WebhookStore — files every inbound project webhook away for posterity:
// one JSON sidecar per delivery under ~/.config/console/webhooks/deliveries/.
// Append-only by design (like RingStore / MessageArchive) — no delete/prune.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface WebhookDelivery {
  id: string
  project: string
  receivedAt: number
  method: string
  /** Path AFTER `/hook/<project>` — providers can address sub-routes. */
  subpath: string
  /** Query string with the `token` parameter removed. */
  query: Record<string, string>
  /** Request headers with credentials stripped (see `sanitiseHeaders`). */
  headers: Record<string, string>
  contentType: string | null
  /** Original client IP (X-Forwarded-For head when Caddy-proxied). */
  source: string | null
  bodyBytes: number
  /** Body as UTF-8 text when it decodes cleanly; binary bodies are base64. */
  bodyText?: string
  bodyBase64?: string
  /** `cli` for `con webhook test`, `redeliver` for a replay, else `http`. */
  via: 'http' | 'cli' | 'redeliver'
  /** Routing outcome. Owner is the agentKey the project resolved to. */
  route: {
    owner: string | null
    delivered: boolean
    detail?: string
    at: number
  }
  /** Every replay of this delivery, newest last. */
  redeliveries?: Array<{ at: number; owner: string | null; delivered: boolean; detail?: string }>
  /** Listener ids whose filters matched the `webhook.received` event — they own it; no owner-wake ran. */
  handledBy?: string[]
}

export class WebhookStore {
  private readonly deliveriesDir: string

  constructor(configDir: string) {
    this.deliveriesDir = join(configDir, 'webhooks', 'deliveries')
    mkdirSync(this.deliveriesDir, { recursive: true })
  }

  private lastMintedAt = 0

  /** Sortable, filesystem-safe id: `2026-09-16T10-15-30.123Z-ab12`. Two
   *  deliveries in the same millisecond would otherwise sort by the random
   *  suffix, so the id's clock is nudged forward to stay strictly monotone. */
  mintId(at: number): string {
    this.lastMintedAt = Math.max(at, this.lastMintedAt + 1)
    return `${new Date(this.lastMintedAt).toISOString().replace(/:/g, '-')}-${randomBytes(2).toString('hex')}`
  }

  save(rec: WebhookDelivery): WebhookDelivery {
    const path = join(this.deliveriesDir, `${rec.id}.json`)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(rec, null, 2))
    renameSync(tmp, path)
    return rec
  }

  get(id: string): WebhookDelivery | null {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return null
    const path = join(this.deliveriesDir, `${id}.json`)
    if (!existsSync(path)) return null
    try { return JSON.parse(readFileSync(path, 'utf8')) as WebhookDelivery } catch { return null }
  }

  /** Newest first; optionally one project only. */
  list(opts: { project?: string | null; limit?: number } = {}): WebhookDelivery[] {
    const limit = opts.limit ?? 50
    const out: WebhookDelivery[] = []
    let names: string[]
    try { names = readdirSync(this.deliveriesDir).filter((n) => n.endsWith('.json')).sort().reverse() } catch { return out }
    for (const n of names) {
      const rec = this.get(n.slice(0, -5))
      if (!rec) continue
      if (opts.project && rec.project !== opts.project) continue
      out.push(rec)
      if (out.length >= limit) break
    }
    return out
  }

  /** Per-project totals for the status view. */
  summary(): Record<string, { count: number; lastReceivedAt: number; undelivered: number }> {
    const out: Record<string, { count: number; lastReceivedAt: number; undelivered: number }> = {}
    for (const rec of this.list({ limit: Number.MAX_SAFE_INTEGER })) {
      const s = out[rec.project] ?? (out[rec.project] = { count: 0, lastReceivedAt: 0, undelivered: 0 })
      s.count++
      s.lastReceivedAt = Math.max(s.lastReceivedAt, rec.receivedAt)
      const landed = rec.route.delivered || !!rec.handledBy?.length || (rec.redeliveries ?? []).some((r) => r.delivered)
      if (!landed) s.undelivered++
    }
    return out
  }
}
