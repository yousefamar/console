// Platform classification for feed subscriptions — pure, so the unified
// Inbox's route tests (node env) can import it without dragging Dexie in.
//
// A "kind" is the platform a feed comes from, derived from its URLs. It
// drives the Feed column's source-filter chips and the per-row glyph
// (YouTube play button instead of a generic RSS icon, etc). Everything not
// recognised is plain `rss`.

export type FeedKind = 'youtube' | 'reddit' | 'hn' | 'substack' | 'x' | 'rss'

/** Chip/glyph order — most-populated platforms first, generic RSS last. */
export const FEED_KINDS: FeedKind[] = ['youtube', 'reddit', 'hn', 'substack', 'x', 'rss']

export const FEED_KIND_LABEL: Record<FeedKind, string> = {
  youtube: 'YouTube',
  reddit: 'Reddit',
  hn: 'Hacker News',
  substack: 'Substack',
  x: 'X',
  rss: 'RSS',
}

function host(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Some feeds are proxied (granary, rsshub, kill-the-newsletter) — the real
 *  platform is in the `url=` param or the proxy path, so check those too. */
function candidateHosts(feed: { xmlUrl?: string; siteUrl?: string }): string[] {
  const out = [host(feed.xmlUrl), host(feed.siteUrl)]
  try {
    if (feed.xmlUrl) {
      const inner = new URL(feed.xmlUrl).searchParams.get('url')
      if (inner) out.push(host(inner))
    }
  } catch { /* unparsable — ignore */ }
  return out.filter(Boolean)
}

export function feedKind(feed: { xmlUrl?: string; siteUrl?: string } | undefined): FeedKind {
  if (!feed) return 'rss'
  for (const h of candidateHosts(feed)) {
    if (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be') return 'youtube'
    if (h === 'reddit.com' || h.endsWith('.reddit.com')) return 'reddit'
    if (h === 'hnrss.org' || h === 'news.ycombinator.com') return 'hn'
    if (h.endsWith('.substack.com')) return 'substack'
    if (h === 'x.com' || h === 'twitter.com' || h.endsWith('.twitter.com') || h.startsWith('nitter.')) return 'x'
  }
  const xml = (feed.xmlUrl ?? '').toLowerCase()
  // rsshub-style paths: /twitter/user/…
  if (/\/twitter\//.test(xml)) return 'x'
  return 'rss'
}
