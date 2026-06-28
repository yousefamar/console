import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, readFileSync } from 'node:fs'
import { eventFromNode, eventEndMs, isExpired, type MeetupEvent } from '../meetup/types.js'
import { MeetupEventStore } from '../meetup/store.js'

function node(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '123',
    title: 'Reading Geek Night',
    dateTime: '2026-07-07T19:00:00+01:00',
    endTime: '2026-07-07T22:00:00+01:00',
    eventUrl: 'https://www.meetup.com/rgn/events/123/',
    eventType: 'PHYSICAL',
    isOnline: false,
    going: { totalCount: 42 },
    group: { name: 'Reading Geek Night', urlname: 'rgn' },
    venue: { name: 'Zerodegrees', address: '9 Bridge St', city: 'Reading', lat: 51.4536, lon: -0.9733 },
    ...over,
  }
}

describe('eventFromNode (gql node → summary)', () => {
  it('maps the verified eventSearch fields', () => {
    const ev = eventFromNode(node())
    expect(ev.id).toBe('123')
    expect(ev.title).toBe('Reading Geek Night')
    expect(ev.eventType).toBe('PHYSICAL')
    expect(ev.going).toBe(42)
    expect(ev.groupUrlname).toBe('rgn')
    expect(ev.venueName).toBe('Zerodegrees')
    expect(ev.lat).toBe(51.4536)
    expect(ev.lon).toBe(-0.9733)
  })

  it('online events have no coords and normalise eventType', () => {
    const ev = eventFromNode(node({ eventType: 'online', isOnline: true, venue: null }))
    expect(ev.eventType).toBe('ONLINE')
    expect(ev.isOnline).toBe(true)
    expect(ev.lat).toBeNull()
    expect(ev.lon).toBeNull()
  })

  it('tolerates missing fields', () => {
    const ev = eventFromNode({ id: '9' })
    expect(ev.title).toBe('')
    expect(ev.going).toBe(0)
    expect(ev.groupName).toBe('')
    expect(ev.eventType).toBe('PHYSICAL')
  })

  it('falls back to a non-HYBRID/ONLINE type as PHYSICAL', () => {
    expect(eventFromNode(node({ eventType: 'WHATEVER' })).eventType).toBe('PHYSICAL')
  })
})

describe('eventEndMs / isExpired', () => {
  it('uses endTime when present', () => {
    const ev = { dateTime: '2026-07-07T19:00:00Z', endTime: '2026-07-07T22:00:00Z' }
    expect(eventEndMs(ev)).toBe(Date.parse('2026-07-07T22:00:00Z'))
  })
  it('falls back to start + 3h without endTime', () => {
    const ev = { dateTime: '2026-07-07T19:00:00Z', endTime: '' }
    expect(eventEndMs(ev)).toBe(Date.parse('2026-07-07T19:00:00Z') + 3 * 3600_000)
  })
  it('returns Infinity for an unparseable date (never prune)', () => {
    expect(eventEndMs({ dateTime: 'not a date' })).toBe(Infinity)
  })
  it('isExpired compares against now', () => {
    const past = { dateTime: '2020-01-01T00:00:00Z', endTime: '2020-01-01T01:00:00Z' }
    const future = { dateTime: '2090-01-01T00:00:00Z', endTime: '2090-01-01T01:00:00Z' }
    const now = Date.parse('2026-06-28T00:00:00Z')
    expect(isExpired(past, now)).toBe(true)
    expect(isExpired(future, now)).toBe(false)
  })
})

describe('MeetupEventStore', () => {
  const file = join(tmpdir(), `meetup-${process.pid}-${Math.floor(performance.now())}.json`)
  const mk = (id: string, end: string): MeetupEvent => ({
    id,
    title: `e${id}`,
    dateTime: end,
    endTime: end,
    eventUrl: '',
    eventType: 'PHYSICAL',
    isOnline: false,
    going: 0,
    groupName: '',
    groupUrlname: '',
    venueName: '',
    venueAddress: '',
    venueCity: '',
    lat: 1,
    lon: 2,
    fetchedAt: 0,
  })

  it('upserts, preserves detail across refresh, prunes expired, strips detail in snapshot', () => {
    try {
      const store = new MeetupEventStore(file)
      store.upsert([mk('1', '2090-01-01T00:00:00Z'), mk('2', '2020-01-01T00:00:00Z')])
      store.setDetail('1', { description: 'hello', fetchedAt: 0 })
      // refresh '1' with a fresh summary — detail must survive
      store.upsert([mk('1', '2090-01-01T00:00:00Z')])
      expect(store.get('1')?.detail?.description).toBe('hello')

      // prune drops the 2020 event
      const removed = store.prune(Date.parse('2026-06-28T00:00:00Z'))
      expect(removed).toBe(1)
      expect(store.get('2')).toBeUndefined()

      // snapshot prunes + strips detail
      const snap = store.getSnapshot()
      expect(snap.events).toHaveLength(1)
      expect('detail' in snap.events[0]).toBe(false)

      // persisted to disk
      const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { events: MeetupEvent[] }
      expect(onDisk.events.map((e) => e.id)).toEqual(['1'])
    } finally {
      rmSync(file, { force: true })
    }
  })
})
