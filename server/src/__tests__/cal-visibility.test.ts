import { describe, it, expect } from 'vitest'
import { attendsEvent, isOwnCalendar, ownEmails, visibleCalendars, type CalendarListEntry } from '../cal/visibility.js'
import { listAllEvents } from '../routes/calendar.js'
import { lateCheck } from '../location/late.js'

const OWN = ownEmails([{ email: 'yousefamar@gmail.com' }, { email: 'yousef@artanis.ai' }, { email: 'yousef@dreamlab.bm' }])

// The live calendarList shape of 2026-09-22, trimmed.
const LIST: CalendarListEntry[] = [
  { id: 'yousefamar@gmail.com', accountEmail: 'yousefamar@gmail.com', primary: true, selected: true, accessRole: 'owner' },
  { id: 'yousef@artanis.ai', accountEmail: 'yousefamar@gmail.com', selected: true, accessRole: 'owner' },
  { id: 'al@group.calendar.google.com', accountEmail: 'yousefamar@gmail.com', selected: true, accessRole: 'owner' },
  { id: 'colours@group.calendar.google.com', accountEmail: 'yousefamar@gmail.com', accessRole: 'owner' },
  { id: 'indieweb@import.calendar.google.com', accountEmail: 'yousefamar@gmail.com', selected: true, accessRole: 'reader' },
  { id: 'yousef@dreamlab.bm', accountEmail: 'yousefamar@gmail.com', selected: true, accessRole: 'reader' },
  { id: 'yousef@artanis.ai', accountEmail: 'yousef@artanis.ai', primary: true, selected: true, accessRole: 'owner' },
  { id: 'sam@artanis.ai', accountEmail: 'yousef@artanis.ai', accessRole: 'owner' },
  { id: 'olly@artanis.ai', accountEmail: 'yousef@artanis.ai', accessRole: 'owner' },
  { id: 'en-gb.uk#holiday@group.v.calendar.google.com', accountEmail: 'yousef@artanis.ai', selected: true, accessRole: 'reader' },
  { id: 'yousef@dreamlab.bm', accountEmail: 'yousef@dreamlab.bm', primary: true, selected: true, accessRole: 'owner' },
]

const SAM_CAL = LIST[7]
const GMAIL = LIST[0]

// Sam's private meetup as the hub read it through yousef@artanis.ai's owner access.
const fishFounders = {
  id: '_84sj0g9k_20260922T170000Z',
  status: 'confirmed',
  summary: 'Fish Founders - Meetup',
  location: "Nando's\n16-18 James Street\nLondon W1U 1EG",
  start: { dateTime: '2026-09-22T18:00:00+01:00' },
  attendees: [
    { email: 'henry@fruitful.app', organizer: true, responseStatus: 'accepted' },
    { email: 'sam@artanis.ai', self: true, responseStatus: 'accepted' },
    { email: 'toby@pallery.com', responseStatus: 'needsAction' },
  ],
}

describe('cal/visibility', () => {
  it('visibleCalendars = ticked calendars, each once, most-access copy kept', () => {
    const vis = visibleCalendars(LIST)
    const ids = vis.map((c) => c.id).sort()
    expect(ids).toEqual([
      'al@group.calendar.google.com',
      'en-gb.uk#holiday@group.v.calendar.google.com',
      'indieweb@import.calendar.google.com',
      'yousef@artanis.ai',
      'yousef@dreamlab.bm',
      'yousefamar@gmail.com',
    ])
    expect(vis.find((c) => c.id === 'yousef@artanis.ai')!.accountEmail).toBe('yousef@artanis.ai')
    expect(vis.find((c) => c.id === 'yousef@dreamlab.bm')!.accountEmail).toBe('yousef@dreamlab.bm')
  })

  it('a colleague calendar he can edit is not his; his secondaries and primaries are', () => {
    expect(isOwnCalendar(SAM_CAL, OWN)).toBe(false)
    expect(isOwnCalendar(LIST[8], OWN)).toBe(false)
    expect(isOwnCalendar(GMAIL, OWN)).toBe(true)
    expect(isOwnCalendar(LIST[1], OWN)).toBe(true)
    expect(isOwnCalendar(LIST[2], OWN)).toBe(true)
    expect(isOwnCalendar(LIST[4], OWN)).toBe(false)
  })

  it('attendsEvent: Sam\'s meetup is not his even with self=accepted on Sam\'s calendar', () => {
    expect(attendsEvent(fishFounders, SAM_CAL, OWN)).toBe(false)
    const invited = { ...fishFounders, attendees: [...fishFounders.attendees, { email: 'Yousef@artanis.ai', responseStatus: 'accepted' }] }
    expect(attendsEvent(invited, SAM_CAL, OWN)).toBe(true)
    const declined = { ...fishFounders, attendees: [...fishFounders.attendees, { email: 'yousef@artanis.ai', responseStatus: 'declined' }] }
    expect(attendsEvent(declined, SAM_CAL, OWN)).toBe(false)
  })

  it('attendsEvent: own calendar — no attendee list counts as going, self-declined does not', () => {
    expect(attendsEvent({ attendees: null }, GMAIL, OWN)).toBe(true)
    expect(attendsEvent({ attendees: [{ email: 'yousefamar@gmail.com', self: true, responseStatus: 'declined' }] }, GMAIL, OWN)).toBe(false)
    expect(attendsEvent({ attendees: [{ self: true, responseStatus: 'declined' }] }, GMAIL, OWN)).toBe(false)
    expect(attendsEvent({ attendees: [{ email: 'someone@else.com', responseStatus: 'accepted' }] }, LIST[2], OWN)).toBe(true)
  })
})

describe('listAllEvents', () => {
  const byAccount = new Map<string, CalendarListEntry[]>()
  for (const c of LIST) byAccount.set(c.accountEmail, [...(byAccount.get(c.accountEmail) ?? []), c])
  const authStore = { getGoogleAccounts: () => [...byAccount.keys()].map((email) => ({ email })) } as any
  const fetched: string[] = []
  const eventsByCal: Record<string, unknown[]> = {
    'sam@artanis.ai': [fishFounders],
    'yousef@artanis.ai': [{ id: 'standup', summary: 'Standup', location: 'WeWork Moorgate', start: { dateTime: '2026-09-22T18:00:00+01:00' }, attendees: [{ email: 'yousef@artanis.ai', self: true, responseStatus: 'accepted' }, { email: 'olly@artanis.ai', responseStatus: 'accepted' }] }],
    'yousefamar@gmail.com': [
      { id: 'dentist', summary: 'Dentist', location: 'Reading', start: { dateTime: '2026-09-22T18:00:00+01:00' } },
      { id: 'party', summary: 'Party', location: 'Oxford', start: { dateTime: '2026-09-22T18:00:00+01:00' }, attendees: [{ email: 'yousefamar@gmail.com', self: true, responseStatus: 'declined' }] },
    ],
    'indieweb@import.calendar.google.com': [{ id: 'hwc', summary: 'Homebrew Website Club', location: 'Brighton', start: { dateTime: '2026-09-22T18:00:00+01:00' } }],
  }
  const calendar = {
    getCalendarList: async (acc: string) => ({ items: byAccount.get(acc) ?? [] }),
    getEvents: async (acc: string, calId: string) => { fetched.push(`${acc}/${calId}`); return { items: eventsByCal[calId] ?? [] } },
  } as any

  it('fans out over ticked calendars only, once each, and never reads Sam\'s calendar', async () => {
    fetched.length = 0
    const events = await listAllEvents(calendar, authStore, '2026-09-22T00:00:00Z') as any[]
    expect(fetched).not.toContain('yousef@artanis.ai/sam@artanis.ai')
    expect(fetched.filter((f) => f.endsWith('/yousef@artanis.ai'))).toEqual(['yousef@artanis.ai/yousef@artanis.ai'])
    expect(events.map((e) => e.id).sort()).toEqual(['dentist', 'hwc', 'party', 'standup'])
    expect(events.find((e) => e.id === 'standup')).toMatchObject({ calendarId: 'yousef@artanis.ai', accountEmail: 'yousef@artanis.ai', accessRole: 'owner' })
  })

  it('attending: drops declined invites and subscribed-feed events he is not invited to', async () => {
    const events = await listAllEvents(calendar, authStore, '2026-09-22T00:00:00Z', undefined, 'true', { attending: true }) as any[]
    expect(events.map((e) => e.id).sort()).toEqual(['dentist', 'standup'])
  })

  it('late-check on the attended list never reports the Fish Founders event', async () => {
    const ctx = {
      listEvents: async () => (await listAllEvents(calendar, authStore, '2026-09-22T00:00:00Z', undefined, 'true', { attending: true })) as any,
      geocode: async () => ({ name: 'venue', lat: 51.5, lon: -0.15 }),
      route: async () => ({ durationSec: 3 * 3600, distanceMeters: 100_000 }),
    }
    const r = await lateCheck(ctx, { lat: 51.4, lon: -0.9, tst: 0 } as any, 60, {}, { nowMs: Date.parse('2026-09-22T16:30:00+01:00') })
    expect(r.reports.map((x) => x.summary).sort()).toEqual(['Dentist', 'Standup'])
    expect(r.reports.some((x) => x.summary === 'Fish Founders - Meetup')).toBe(false)
  })
})
