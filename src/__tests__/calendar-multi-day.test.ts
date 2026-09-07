import { describe, it, expect } from 'vitest'
import { multiDaySpan, asAllDaySpan } from '@/calendar/multi-day'
import type { CalendarEvent } from '@/calendar/types'

// Local-time fixtures: the grid buckets by LOCAL day, so build ISO strings from local Dates.
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).toISOString()
const ev = (start: string, end: string): CalendarEvent =>
  ({ id: 'x', calendarId: 'c', accountEmail: 'a', summary: 's', start: { dateTime: start }, end: { dateTime: end }, status: 'confirmed', htmlLink: '', created: '', updated: '' } as CalendarEvent)

describe('multiDaySpan', () => {
  it('spans Fri 16:00 → Sun 15:00 as Fri..Sun (end exclusive = Mon)', () => {
    expect(multiDaySpan(ev(local(2026, 9, 11, 16), local(2026, 9, 13, 15)))).toEqual({ start: '2026-09-11', end: '2026-09-14' })
  })
  it('leaves same-day events alone', () => {
    expect(multiDaySpan(ev(local(2026, 9, 11, 9), local(2026, 9, 11, 17)))).toBeNull()
  })
  it('treats an event ending exactly at midnight as single-day', () => {
    expect(multiDaySpan(ev(local(2026, 9, 11, 22), local(2026, 9, 12, 0)))).toBeNull()
  })
  it('an overnight event (22:00 → 02:00) spans two days', () => {
    expect(multiDaySpan(ev(local(2026, 9, 11, 22), local(2026, 9, 12, 2)))).toEqual({ start: '2026-09-11', end: '2026-09-13' })
  })
  it('ignores all-day, inverted, or unparseable events', () => {
    expect(multiDaySpan({ ...ev(local(2026, 9, 11, 9), local(2026, 9, 12, 9)), start: { date: '2026-09-11' }, end: { date: '2026-09-12' } })).toBeNull()
    expect(multiDaySpan(ev(local(2026, 9, 12, 9), local(2026, 9, 11, 9)))).toBeNull()
    expect(multiDaySpan(ev('nope', 'nope'))).toBeNull()
  })
  it('asAllDaySpan keeps the dateTimes for detail views', () => {
    const e = ev(local(2026, 9, 11, 16), local(2026, 9, 13, 15))
    const out = asAllDaySpan(e, multiDaySpan(e)!)
    expect(out.start).toEqual({ dateTime: e.start.dateTime, date: '2026-09-11' })
    expect(out.end).toEqual({ dateTime: e.end.dateTime, date: '2026-09-14' })
  })
})
