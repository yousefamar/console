import { describe, it, expect } from 'vitest'
import { truncateRecurrence } from '@/calendar/recurrence'

describe('truncateRecurrence', () => {
  it('appends UNTIL just before the cut instance (timed)', () => {
    const out = truncateRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=MO'], '2026-08-24T10:00:00Z')
    expect(out).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260824T095959Z'])
  })

  it('respects timezone offsets in the instance start', () => {
    const out = truncateRecurrence(['RRULE:FREQ=WEEKLY'], '2026-08-24T10:00:00+01:00')
    expect(out).toEqual(['RRULE:FREQ=WEEKLY;UNTIL=20260824T085959Z'])
  })

  it('uses a bare date for all-day series', () => {
    const out = truncateRecurrence(['RRULE:FREQ=DAILY'], '2026-08-24')
    expect(out).toEqual(['RRULE:FREQ=DAILY;UNTIL=20260823'])
  })

  it('replaces an existing UNTIL', () => {
    const out = truncateRecurrence(['RRULE:FREQ=DAILY;UNTIL=20270101T000000Z'], '2026-08-24T10:00:00Z')
    expect(out).toEqual(['RRULE:FREQ=DAILY;UNTIL=20260824T095959Z'])
  })

  it('drops COUNT (mutually exclusive with UNTIL)', () => {
    const out = truncateRecurrence(['RRULE:FREQ=DAILY;COUNT=30'], '2026-08-24T10:00:00Z')
    expect(out).toEqual(['RRULE:FREQ=DAILY;UNTIL=20260824T095959Z'])
  })

  it('passes through non-RRULE lines untouched', () => {
    const out = truncateRecurrence(
      ['EXDATE;TZID=Europe/London:20260817T100000', 'RRULE:FREQ=WEEKLY'],
      '2026-08-24T10:00:00Z',
    )
    expect(out[0]).toBe('EXDATE;TZID=Europe/London:20260817T100000')
    expect(out[1]).toBe('RRULE:FREQ=WEEKLY;UNTIL=20260824T095959Z')
  })
})
