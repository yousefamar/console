import { describe, it, expect } from 'vitest'
import { FEED_KINDS, feedKind } from '@/feeds/feed-kind'

describe('feedKind', () => {
  it('classifies the platforms by host', () => {
    expect(feedKind({ xmlUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=abc' })).toBe('youtube')
    expect(feedKind({ xmlUrl: 'https://www.reddit.com/r/selfhosted/hot/.rss' })).toBe('reddit')
    expect(feedKind({ xmlUrl: 'https://hnrss.org/frontpage?points=100' })).toBe('hn')
    expect(feedKind({ xmlUrl: 'https://midwits.substack.com/feed' })).toBe('substack')
    expect(feedKind({ xmlUrl: 'https://nitter.net/someone/rss' })).toBe('x')
    expect(feedKind({ xmlUrl: 'https://rsshub.app/twitter/user/someone' })).toBe('x')
  })

  it('falls back to rss for blogs and unknowns', () => {
    expect(feedKind({ xmlUrl: 'https://yaz.in/feed.xml' })).toBe('rss')
    expect(feedKind({ xmlUrl: 'not a url' })).toBe('rss')
    expect(feedKind(undefined)).toBe('rss')
  })

  it('looks through proxies to the wrapped url', () => {
    expect(feedKind({ xmlUrl: 'https://granary.io/url?input=html&output=atom&url=https://www.youtube.com/@x' })).toBe('youtube')
    expect(feedKind({ xmlUrl: 'https://granary.io/url?input=html&output=atom&url=https://yousefamar.com/memo/log/' })).toBe('rss')
  })

  it('uses siteUrl when xmlUrl is opaque', () => {
    expect(feedKind({ xmlUrl: 'https://kill-the-newsletter.com/feeds/abc.xml', siteUrl: 'https://x.com/someone' })).toBe('x')
  })

  it('the chip order starts with the big platforms and ends with rss', () => {
    expect(FEED_KINDS[0]).toBe('youtube')
    expect(FEED_KINDS[FEED_KINDS.length - 1]).toBe('rss')
  })
})
