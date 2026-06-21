import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { rot13, cacheFromApiRecord, typeName, sizeName, logTypeName } from '../geocaching/types.js'
import { parseSearchResults, parseLogbook, parseCacheDetail, parseDegMin, htmlToText } from '../geocaching/parse.js'
import { extractVerificationToken, getLoggedUser } from '../geocaching/session.js'
import { RateLimiter, RateLimitExceededError } from '../geocaching/rate-limit.js'

describe('rot13 (hint decode)', () => {
  it('round-trips and decodes a hint', () => {
    expect(rot13('Under the rock')).toBe('Haqre gur ebpx')
    expect(rot13('Haqre gur ebpx')).toBe('Under the rock')
    expect(rot13(rot13('Mixed 123!'))).toBe('Mixed 123!')
  })
})

describe('enum mappings', () => {
  it('maps cache type / size / log type ids', () => {
    expect(typeName(2)).toBe('Traditional')
    expect(typeName(8)).toBe('Mystery')
    expect(typeName(999)).toBe('Unknown')
    expect(sizeName(2)).toBe('micro')
    expect(sizeName(8)).toBe('small')
    expect(logTypeName('2')).toBe('found_it')
    expect(logTypeName('3')).toBe('didnt_find_it')
  })
})

describe('cacheFromApiRecord (search/v2 → summary)', () => {
  it('maps the verified pycaching fields', () => {
    const c = cacheFromApiRecord({
      code: 'GC123',
      name: 'Test',
      geocacheType: 2,
      containerType: 2,
      difficulty: 1.5,
      terrain: 2,
      owner: { username: 'bob' },
      placedDate: '2020-01-02T00:00:00',
      favoritePoints: 5,
      premiumOnly: false,
      postedCoordinates: { latitude: 51.4, longitude: -0.9 },
      cacheStatus: 0,
      userFound: true,
    })
    expect(c.code).toBe('GC123')
    expect(c.type).toBe('Traditional')
    expect(c.size).toBe('micro')
    expect(c.difficulty).toBe(1.5)
    expect(c.found).toBe(true)
    expect(c.owner).toBe('bob')
    expect(c.hidden).toBe('2020-01-02')
    expect(c.lat).toBe(51.4)
    expect(c.lon).toBe(-0.9)
    expect(c.status).toBe('enabled')
  })

  it('tolerates missing coords / owner', () => {
    const c = cacheFromApiRecord({ code: 'GC9', name: 'x' })
    expect(c.lat).toBeNull()
    expect(c.owner).toBe('')
    expect(c.found).toBe(false)
  })
})

describe('parseSearchResults', () => {
  it('extracts caches + total', () => {
    const page = parseSearchResults({ results: [{ code: 'GC1', name: 'A', geocacheType: 3 }], total: 7 })
    expect(page.total).toBe(7)
    expect(page.caches[0].type).toBe('Multi-cache')
  })
  it('handles empty / malformed', () => {
    expect(parseSearchResults({}).caches).toEqual([])
    expect(parseSearchResults(null).total).toBe(0)
  })
})

describe('parseLogbook', () => {
  it('maps log entries', () => {
    const logs = parseLogbook({ data: [{ LogGuid: 'g1', LogTypeImage: '2.png', LogText: 'TFTC', Visited: '2026-06-01', UserName: 'alice' }] })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ id: 'g1', type: 'found_it', text: 'TFTC', date: '2026-06-01', author: 'alice' })
  })
  it('strips HTML + decodes entities from log text', () => {
    const logs = parseLogbook({ data: [{ LogGuid: 'g', LogTypeImage: '2.png', LogText: '<p><strong>TFTC</strong> &amp; nice walk</p>', Visited: '2026-06-01', UserName: 'a' }] })
    expect(logs[0].text).toBe('TFTC & nice walk')
  })
})

describe('htmlToText', () => {
  it('flattens fragments, breaks paragraphs, decodes entities', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo')
    expect(htmlToText('a<br>b')).toBe('a\nb')
    expect(htmlToText('plain')).toBe('plain')
    expect(htmlToText('')).toBe('')
    expect(htmlToText('&lt;tag&gt; &amp; co')).toBe('<tag> & co')
  })
})

describe('parseCacheDetail', () => {
  const html = `
    <h1 id="ctl00_ContentBody_CacheName">Test Cache</h1>
    <div id="div_hint">Haqre gur ebpx</div>
    <img src="/images/attributes/dogs-yes.gif" alt="Dogs allowed">
    <img src="/images/attributes/bicycles-no.gif" alt="No bikes">
    <img src="/images/attributes/attribute-blank.gif" alt="blank">
    <span class="favorite-value">42</span>
    <script>var userToken = 'ABC.TOKEN';</script>
  `
  const d = parseCacheDetail(html)
  it('decodes the hint', () => expect(d.hint).toBe('Under the rock'))
  it('reads the name + favorites + userToken', () => {
    expect(d.name).toBe('Test Cache')
    expect(d.favorites).toBe(42)
    expect(d.userToken).toBe('ABC.TOKEN')
  })
  it('parses attributes (slug + yes/no), skipping the blank spacer', () => {
    const slugs = d.attributes.map((a) => a.slug)
    expect(slugs).toContain('dogs')
    expect(slugs).toContain('bicycles')
    expect(slugs).not.toContain('attribute')
    expect(d.attributes.find((a) => a.slug === 'dogs')?.enabled).toBe(true)
    expect(d.attributes.find((a) => a.slug === 'bicycles')?.enabled).toBe(false)
  })
})

describe('parseDegMin', () => {
  it('parses N/W degree-minute coordinates', () => {
    const ll = parseDegMin('N 51° 27.123 W 000° 57.456')
    expect(ll).not.toBeNull()
    expect(ll!.lat).toBeCloseTo(51.45205, 3)
    expect(ll!.lon).toBeCloseTo(-0.9576, 3)
  })
  it('returns null for junk', () => expect(parseDegMin('not coords')).toBeNull())
})

describe('session HTML helpers', () => {
  it('extracts the verification token regardless of attribute order', () => {
    expect(extractVerificationToken('<input name="__RequestVerificationToken" value="TOK1">')).toBe('TOK1')
    expect(extractVerificationToken('<input value="TOK2" name="__RequestVerificationToken">')).toBe('TOK2')
  })
  it('reads the logged-in username from page JS', () => {
    expect(getLoggedUser('window.x = { "username": "yousef" }')).toBe('yousef')
    expect(getLoggedUser('no user here')).toBeNull()
  })
})

describe('RateLimiter daily budget', () => {
  it('enforces the daily cap and reports remaining', async () => {
    const file = join(tmpdir(), `gc-budget-${process.pid}-${Math.floor(performance.now())}.json`)
    try {
      const rl = new RateLimiter({ budgetFile: file, minDelayMs: 0, maxDelayMs: 0, dailyCap: 2 })
      await rl.schedule(async () => 'a')
      await rl.schedule(async () => 'b')
      expect(rl.budgetStatus()).toMatchObject({ used: 2, cap: 2, remaining: 0 })
      await expect(rl.schedule(async () => 'c')).rejects.toBeInstanceOf(RateLimitExceededError)
    } finally {
      rmSync(file, { force: true })
    }
  })

  it('serialises (concurrency 1) and preserves order', async () => {
    const file = join(tmpdir(), `gc-budget2-${process.pid}-${Math.floor(performance.now())}.json`)
    try {
      const rl = new RateLimiter({ budgetFile: file, minDelayMs: 0, maxDelayMs: 0, dailyCap: 100 })
      const order: number[] = []
      await Promise.all([1, 2, 3].map((n) => rl.schedule(async () => { order.push(n) })))
      expect(order).toEqual([1, 2, 3])
    } finally {
      rmSync(file, { force: true })
    }
  })
})
