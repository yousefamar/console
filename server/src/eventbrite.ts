// ============================================================================
// Eventbrite organiser follow — hub-side fetch of every live event published
// by a fixed list of organisers, for the Calendar tab's read-only overlay.
//
// Eventbrite killed its public RSS and event search; the only durable feed is
// `GET /v3/organizers/{id}/events/?status=live` with a PERSONAL OAuth token
// (free, from the user's account → Developer). The token + organiser list live
// in `~/.config/console/eventbrite.json` (0600) — never in the repo, never in
// a response body. Calendar-only source: venues carry an address but no coords
// we trust for Map pins, and the point is "when are these people running
// something", not "where".
//
// TTL-cached; refreshed by the client on boot/reconnect/6h. Never background-
// polled by the hub itself.
// ============================================================================

import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

const API = 'https://www.eventbriteapi.com/v3'
const TTL_MS = 6 * 60 * 60 * 1000

export interface EventbriteOrganizer {
  id: string
  name: string
}

export interface EventbriteEvent {
  id: string
  title: string
  url: string
  start: string // ISO 8601 UTC
  end: string // ISO 8601 UTC
  organizerId: string
  organizerName: string
  venueName: string
  address: string
  online: boolean
  summary: string
}

interface Config {
  token?: string
  organizers: EventbriteOrganizer[]
}

/** Pull an organiser id or event id out of a pasted Eventbrite URL / bare id.
 *  `/o/<slug>-<id>` → organiser; `/e/<slug>-tickets-<id>` → event (the caller
 *  resolves it to its organiser via the API); bare digits → organiser id. */
export function parseEventbriteRef(input: string): { kind: 'organizer' | 'event'; id: string } | null {
  const s = input.trim()
  if (/^\d{6,}$/.test(s)) return { kind: 'organizer', id: s }
  const o = s.match(/eventbrite\.[a-z.]+\/o\/[^/?#]*?-?(\d{6,})(?:[/?#]|$)/i)
  if (o) return { kind: 'organizer', id: o[1]! }
  const e = s.match(/eventbrite\.[a-z.]+\/e\/[^/?#]*?-?(\d{6,})(?:[/?#]|$)/i)
  if (e) return { kind: 'event', id: e[1]! }
  return null
}

interface RawEvent {
  id: string
  name?: { text?: string }
  summary?: string
  url?: string
  start?: { utc?: string }
  end?: { utc?: string }
  online_event?: boolean
  venue?: { name?: string; address?: { localized_address_display?: string } }
}

/** Pure: API event → our flat shape. Null when it has no start. */
export function adaptEventbriteEvent(raw: RawEvent, org: EventbriteOrganizer): EventbriteEvent | null {
  const start = raw.start?.utc
  if (!start) return null
  return {
    id: String(raw.id),
    title: (raw.name?.text ?? 'Eventbrite event').trim(),
    url: raw.url ?? '',
    start,
    end: raw.end?.utc ?? start,
    organizerId: org.id,
    organizerName: org.name,
    venueName: raw.venue?.name ?? '',
    address: raw.venue?.address?.localized_address_display ?? '',
    online: !!raw.online_event,
    summary: (raw.summary ?? '').trim(),
  }
}

export class EventbriteStore {
  private configFile: string
  private cache: EventbriteEvent[] = []
  private fetchedAt = 0
  private inflight: Promise<EventbriteEvent[]> | null = null
  private lastError: string | null = null

  constructor(configDir: string, private fetchImpl: typeof fetch = fetch) {
    this.configFile = join(configDir, 'eventbrite.json')
  }

  private readConfig(): Config {
    if (!existsSync(this.configFile)) return { organizers: [] }
    try {
      const raw = JSON.parse(readFileSync(this.configFile, 'utf8')) as Partial<Config>
      return { token: raw.token, organizers: Array.isArray(raw.organizers) ? raw.organizers : [] }
    } catch {
      return { organizers: [] }
    }
  }

  private writeConfig(cfg: Config): void {
    const tmp = `${this.configFile}.tmp`
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.configFile)
    chmodSync(this.configFile, 0o600)
  }

  configured(): boolean {
    return !!this.readConfig().token
  }

  setToken(token: string): void {
    const cfg = this.readConfig()
    cfg.token = token.trim()
    this.writeConfig(cfg)
    this.fetchedAt = 0
  }

  organizers(): EventbriteOrganizer[] {
    return this.readConfig().organizers
  }

  /** Token never leaves the hub — status only says whether one is set. */
  getStatus(): { configured: boolean; organizers: EventbriteOrganizer[]; count: number; fetchedAt: number; lastError: string | null } {
    const cfg = this.readConfig()
    return { configured: !!cfg.token, organizers: cfg.organizers, count: this.cache.length, fetchedAt: this.fetchedAt, lastError: this.lastError }
  }

  private async api<T>(token: string, path: string): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    const body = (await res.json()) as T & { error?: string; error_description?: string }
    if (!res.ok) throw new Error(`Eventbrite ${res.status}: ${body.error_description ?? body.error ?? 'request failed'}`)
    return body
  }

  /** Follow an organiser by id, organiser URL, or any of their event URLs. */
  async addOrganizer(ref: string): Promise<EventbriteOrganizer> {
    const parsed = parseEventbriteRef(ref)
    if (!parsed) throw new Error('not an Eventbrite organiser/event URL or id')
    const cfg = this.readConfig()
    if (!cfg.token) throw new Error('no Eventbrite token set')
    let org: EventbriteOrganizer
    if (parsed.kind === 'event') {
      const ev = await this.api<{ organizer?: { id: string; name?: string } }>(cfg.token, `/events/${parsed.id}/?expand=organizer`)
      if (!ev.organizer?.id) throw new Error('event has no organiser')
      org = { id: ev.organizer.id, name: ev.organizer.name ?? ev.organizer.id }
    } else {
      const o = await this.api<{ id: string; name?: string }>(cfg.token, `/organizers/${parsed.id}/`)
      org = { id: o.id, name: o.name ?? o.id }
    }
    if (!cfg.organizers.some((x) => x.id === org.id)) {
      cfg.organizers.push(org)
      this.writeConfig(cfg)
      this.fetchedAt = 0
    }
    return org
  }

  removeOrganizer(id: string): boolean {
    const cfg = this.readConfig()
    const before = cfg.organizers.length
    cfg.organizers = cfg.organizers.filter((o) => o.id !== id)
    if (cfg.organizers.length === before) return false
    this.writeConfig(cfg)
    this.cache = this.cache.filter((e) => e.organizerId !== id)
    return true
  }

  /** Cached unless stale or `force`; coalesces concurrent fetches. */
  async getEvents(force = false): Promise<EventbriteEvent[]> {
    if (!force && this.fetchedAt && Date.now() - this.fetchedAt < TTL_MS) return this.cache
    if (this.inflight) return this.inflight
    this.inflight = this.fetchAll()
      .then((events) => {
        this.cache = events
        this.fetchedAt = Date.now()
        this.lastError = null
        return events
      })
      .catch((e: Error) => {
        this.lastError = e.message
        throw e
      })
      .finally(() => { this.inflight = null })
    return this.inflight
  }

  private async fetchAll(): Promise<EventbriteEvent[]> {
    const cfg = this.readConfig()
    if (!cfg.token) return []
    const out: EventbriteEvent[] = []
    for (const org of cfg.organizers) {
      // `page_size` is rejected (ARGUMENTS_ERROR); paginate via continuation.
      let cont: string | undefined
      for (let page = 0; page < 10; page++) {
        const q = `status=live&order_by=start_asc&expand=venue${cont ? `&continuation=${encodeURIComponent(cont)}` : ''}`
        const res = await this.api<{ events?: RawEvent[]; pagination?: { has_more_items?: boolean; continuation?: string } }>(
          cfg.token, `/organizers/${org.id}/events/?${q}`)
        for (const raw of res.events ?? []) {
          const ev = adaptEventbriteEvent(raw, org)
          if (ev) out.push(ev)
        }
        if (!res.pagination?.has_more_items || !res.pagination.continuation) break
        cont = res.pagination.continuation
      }
    }
    out.sort((a, b) => a.start.localeCompare(b.start))
    return out
  }
}
