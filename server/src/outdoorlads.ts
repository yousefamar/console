// ============================================================================
// OutdoorLads events — hub-side fetch of the public RSS feed.
//
// OutdoorLads (LGBTQ+ outdoor activity group) publishes all upcoming events as
// one national RSS feed at /events-rss.xml. The feed repurposes <pubDate> as the
// event START time (not the publish time), and embeds Event Type + Region +
// Description as HTML inside each <description>. There are NO geo coords, so this
// is a calendar-only source (no Map pin) — it feeds the Calendar tab's read-only
// overlay seam via the client. We fetch + parse + cache here; the client filters
// (e.g. to camping) and registers the overlay.
//
// Manual/TTL fetch only — never background-polled.
// ============================================================================

import RssParser from 'rss-parser'

const FEED_URL = 'https://www.outdoorlads.com/events-rss.xml'
const TTL_MS = 60 * 60 * 1000 // 1h — the feed changes slowly (new events go live)

export interface OutdoorLadsEvent {
  id: string
  title: string
  link: string
  start: string // ISO 8601 (from the feed's pubDate, which is the event start)
  eventType: string // e.g. "Campsites", "Lowland and Hill Walks"
  region: string // e.g. "South East" (text only — no coords in the feed)
  location: string // the full "Approximate Location and Region" sentence
  description: string // plain-text event description (HTML stripped)
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Pull a `<b>Label - </b> value` field out of the description HTML. */
function field(html: string, label: string): string {
  const re = new RegExp(`${label}\\s*-\\s*</b>\\s*([^<]*)`, 'i')
  const m = html.match(re)
  return m?.[1]?.trim() ?? ''
}

/** "...area of ENGLAND (North West)" → "North West". */
function regionFromLocation(location: string): string {
  const m = location.match(/\(([^)]+)\)\s*$/)
  return m?.[1]?.trim() ?? ''
}

export class OutdoorLadsStore {
  private parser = new RssParser()
  private cache: OutdoorLadsEvent[] = []
  private fetchedAt = 0
  private inflight: Promise<OutdoorLadsEvent[]> | null = null

  /** Cached unless stale or `force`. Coalesces concurrent fetches. */
  async getEvents(force = false): Promise<OutdoorLadsEvent[]> {
    if (!force && this.cache.length && Date.now() - this.fetchedAt < TTL_MS) {
      return this.cache
    }
    if (this.inflight) return this.inflight
    this.inflight = this.fetchAndParse()
      .then((events) => {
        this.cache = events
        this.fetchedAt = Date.now()
        return events
      })
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }

  getStatus(): { count: number; fetchedAt: number; feedUrl: string } {
    return { count: this.cache.length, fetchedAt: this.fetchedAt, feedUrl: FEED_URL }
  }

  private async fetchAndParse(): Promise<OutdoorLadsEvent[]> {
    const feed = await this.parser.parseURL(FEED_URL)
    const events: OutdoorLadsEvent[] = []
    for (const item of feed.items) {
      const html = item.content || (item as { description?: string }).description || ''
      const start = item.isoDate || (item.pubDate ? new Date(item.pubDate).toISOString() : '')
      if (!start) continue
      const location = field(html, 'Approximate Location and Region')
      const descHtml = html.split(/Event Description\s*-\s*<\/b>/i)[1] ?? ''
      events.push({
        id: item.guid || item.link || item.title || start,
        title: (item.title || 'OutdoorLads event').trim(),
        link: item.link || '',
        start,
        eventType: field(html, 'Event Type'),
        region: regionFromLocation(location),
        location,
        description: stripHtml(descHtml).slice(0, 600),
      })
    }
    return events
  }
}
