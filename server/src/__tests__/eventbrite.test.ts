import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventbriteStore, adaptEventbriteEvent, parseEventbriteRef } from '../eventbrite.js'

describe('parseEventbriteRef', () => {
  it('reads organiser + event URLs and bare ids', () => {
    expect(parseEventbriteRef('https://www.eventbrite.co.uk/o/wilding-with-harry-121041407049')).toEqual({ kind: 'organizer', id: '121041407049' })
    expect(parseEventbriteRef('https://www.eventbrite.co.uk/o/wilding-with-harry-121041407049?aff=x#foo')).toEqual({ kind: 'organizer', id: '121041407049' })
    expect(parseEventbriteRef('https://www.eventbrite.co.uk/e/reading-death-cafe-tickets-1990270996126')).toEqual({ kind: 'event', id: '1990270996126' })
    expect(parseEventbriteRef('https://www.eventbrite.com/e/x-tickets-1990270996126/')).toEqual({ kind: 'event', id: '1990270996126' })
    expect(parseEventbriteRef(' 121041407049 ')).toEqual({ kind: 'organizer', id: '121041407049' })
    expect(parseEventbriteRef('https://example.com/o/foo-123456')).toBeNull()
    expect(parseEventbriteRef('nonsense')).toBeNull()
  })
})

describe('adaptEventbriteEvent', () => {
  const org = { id: '1', name: 'Wilding with Harry' }
  it('flattens the API shape and keeps the real end time', () => {
    const ev = adaptEventbriteEvent({
      id: '99', name: { text: ' Wilding Camp ' }, summary: 'A weekend in the woods', url: 'https://eb/e/99',
      start: { utc: '2026-09-25T08:30:00Z' }, end: { utc: '2026-09-27T14:00:00Z' }, online_event: false,
      venue: { name: 'Sparrows Campsite', address: { localized_address_display: 'Halstead, CO9 1RS' } },
    }, org)
    expect(ev).toEqual({
      id: '99', title: 'Wilding Camp', url: 'https://eb/e/99', start: '2026-09-25T08:30:00Z', end: '2026-09-27T14:00:00Z',
      organizerId: '1', organizerName: 'Wilding with Harry', venueName: 'Sparrows Campsite', address: 'Halstead, CO9 1RS',
      online: false, summary: 'A weekend in the woods',
    })
  })
  it('drops events without a start', () => {
    expect(adaptEventbriteEvent({ id: '1' }, org)).toBeNull()
  })
})

describe('EventbriteStore', () => {
  function fakeFetch(routes: Record<string, unknown>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input)
      // Longest match wins: `/organizers/<id>/` must not shadow `/organizers/<id>/events/`.
      const key = Object.keys(routes).filter((k) => url.includes(k)).sort((x, y) => y.length - x.length)[0]
      const hit = key ? (routes[key] as { __status?: number; body?: unknown }) : undefined
      const status = hit ? (hit.__status ?? 200) : 404
      const body = hit ? (hit.__status ? hit.body : hit) : { error: 'NOT_FOUND', error_description: url }
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
  }

  it('returns nothing without a token and reports unconfigured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eb-'))
    const store = new EventbriteStore(dir, fakeFetch({}))
    expect(store.configured()).toBe(false)
    expect(await store.getEvents()).toEqual([])
    expect(store.getStatus()).toMatchObject({ configured: false, organizers: [], count: 0 })
  })

  it('stores the token 0600, follows via event URL (resolving the organiser) and lists live events across organisers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eb-'))
    const store = new EventbriteStore(dir, fakeFetch({
      '/events/1990270996126/': { organizer: { id: '121043375734', name: 'Reading Death Collective' } },
      '/organizers/121043375734/': { id: '121043375734', name: 'Reading Death Collective' },
      '/organizers/121043375734/events/': { events: [{ id: 'b', name: { text: 'Death Cafe' }, start: { utc: '2026-11-04T18:30:00Z' }, end: { utc: '2026-11-04T20:30:00Z' } }], pagination: { has_more_items: false } },
      '/organizers/121041407049/': { id: '121041407049', name: 'Wilding' },
      '/organizers/121041407049/events/': { events: [{ id: 'a', name: { text: 'Camp' }, start: { utc: '2026-09-25T08:30:00Z' } }], pagination: { has_more_items: false } },
    }))
    store.setToken('  secret  ')
    expect((statSync(join(dir, 'eventbrite.json')).mode & 0o777)).toBe(0o600)
    expect(readFileSync(join(dir, 'eventbrite.json'), 'utf8')).toContain('"secret"')

    const org = await store.addOrganizer('https://www.eventbrite.co.uk/e/reading-death-cafe-tickets-1990270996126')
    expect(org).toEqual({ id: '121043375734', name: 'Reading Death Collective' })
    await store.addOrganizer('121041407049')
    await store.addOrganizer('121041407049') // idempotent
    expect(store.organizers().map((o) => o.id)).toEqual(['121043375734', '121041407049'])

    const events = await store.getEvents()
    expect(events.map((e) => [e.id, e.organizerName])).toEqual([['a', 'Wilding'], ['b', 'Reading Death Collective']]) // sorted by start
    expect(events[1]!.end).toBe('2026-11-04T20:30:00Z')
    expect(events[0]!.end).toBe('2026-09-25T08:30:00Z') // no end → start

    const status = store.getStatus()
    expect(status).toMatchObject({ configured: true, count: 2, lastError: null })
    expect(JSON.stringify(status)).not.toContain('secret')

    expect(store.removeOrganizer('121041407049')).toBe(true)
    expect(store.removeOrganizer('121041407049')).toBe(false)
    expect(store.getStatus().count).toBe(1)
  })

  it('surfaces API errors as lastError and rejects bad refs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eb-'))
    const store = new EventbriteStore(dir, fakeFetch({}))
    store.setToken('t')
    await expect(store.addOrganizer('nonsense')).rejects.toThrow(/not an Eventbrite/)
    await expect(store.addOrganizer('123456789')).rejects.toThrow(/Eventbrite 404/)
    store.setToken('t')
    await store.addOrganizer('123456789').catch(() => {})
    // Force a fetch with a followed organiser whose events call 404s.
    const bad = new EventbriteStore(dir, fakeFetch({
      '/organizers/100000000001/': { id: '100000000001', name: 'x' },
      '/organizers/100000000001/events/': { __status: 404, body: { error: 'NOT_FOUND', error_description: 'gone' } },
    }))
    await bad.addOrganizer('100000000001')
    await expect(bad.getEvents(true)).rejects.toThrow(/Eventbrite 404/)
    expect(bad.getStatus().lastError).toMatch(/Eventbrite 404/)
  })
})
