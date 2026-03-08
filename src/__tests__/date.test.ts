import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { relativeTime, formatTime, formatDate, getSnoozeTime } from '@/utils/date'

describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "now" for less than a minute ago', () => {
    expect(relativeTime(Date.now() - 30_000)).toBe('now')
  })

  it('returns minutes for less than an hour', () => {
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe('5m')
  })

  it('returns hours for less than a day', () => {
    expect(relativeTime(Date.now() - 3 * 60 * 60_000)).toBe('3h')
  })

  it('returns days for less than a week', () => {
    expect(relativeTime(Date.now() - 2 * 24 * 60 * 60_000)).toBe('2d')
  })

  it('returns month/day for same year beyond a week', () => {
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60_000
    const result = relativeTime(twoWeeksAgo)
    // Should be like "Feb 22" (locale-dependent)
    expect(result).not.toMatch(/^\d+[mhd]$/)
  })

  it('includes year for different year', () => {
    const lastYear = new Date('2025-01-15T12:00:00Z').getTime()
    const result = relativeTime(lastYear)
    expect(result).toContain('2025')
  })
})

describe('formatTime', () => {
  it('formats a timestamp to time string', () => {
    const ts = new Date('2026-03-08T14:30:00Z').getTime()
    const result = formatTime(ts)
    // Locale-dependent, but should have hour and minute
    expect(result).toBeTruthy()
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('formatDate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "Today at ..." for today', () => {
    const today = new Date('2026-03-08T09:00:00Z').getTime()
    expect(formatDate(today)).toMatch(/^Today at/)
  })

  it('returns "Yesterday at ..." for yesterday', () => {
    const yesterday = new Date('2026-03-07T09:00:00Z').getTime()
    expect(formatDate(yesterday)).toMatch(/^Yesterday at/)
  })
})

describe('getSnoozeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-08T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('laterToday returns at least 3 hours from now', () => {
    const result = getSnoozeTime('laterToday')
    expect(result).toBeGreaterThanOrEqual(Date.now() + 3 * 60 * 60_000)
  })

  it('tomorrow returns 8am next day', () => {
    const result = getSnoozeTime('tomorrow')
    const date = new Date(result)
    expect(date.getDate()).toBe(9)
    expect(date.getHours()).toBe(8)
    expect(date.getMinutes()).toBe(0)
  })

  it('nextWeek returns Monday 8am', () => {
    const result = getSnoozeTime('nextWeek')
    const date = new Date(result)
    expect(date.getDay()).toBe(1) // Monday
    expect(date.getHours()).toBe(8)
  })

  it('custom returns the provided date', () => {
    const custom = new Date('2026-04-01T15:00:00Z')
    expect(getSnoozeTime('custom', custom)).toBe(custom.getTime())
  })

  it('custom without date returns now', () => {
    const result = getSnoozeTime('custom')
    expect(result).toBe(Date.now())
  })
})
