import type { CalendarEvent } from './types'

/** Local YYYY-MM-DD (avoids the UTC shift of toISOString). */
export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * A TIMED event that crosses local midnight (Fri 16:00 → Sun 15:00) can't sit in
 * the hour grid — one column, `end − start` minutes — so it rides the all-day
 * bar as a spanning block instead, Google-style. Returns the all-day-shaped
 * `{start:{date}, end:{date}}` (end EXCLUSIVE, like Google) for such an event,
 * or null when it fits in one day. An event ending exactly at midnight still
 * belongs to its start day.
 */
export function multiDaySpan(e: CalendarEvent): { start: string; end: string } | null {
  if (!e.start.dateTime || !e.end.dateTime) return null
  const start = new Date(e.start.dateTime)
  const end = new Date(e.end.dateTime)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null
  // End at 00:00 → the last day is the previous one.
  const lastInstant = new Date(end.getTime() - 1)
  const startDay = localDateStr(start)
  const lastDay = localDateStr(lastInstant)
  if (startDay === lastDay) return null
  const exclusiveEnd = new Date(lastInstant)
  exclusiveEnd.setHours(0, 0, 0, 0)
  exclusiveEnd.setDate(exclusiveEnd.getDate() + 1)
  return { start: startDay, end: localDateStr(exclusiveEnd) }
}

/** The event re-shaped for the all-day bar; dateTimes are kept so detail views still show the real times. */
export function asAllDaySpan(e: CalendarEvent, span: { start: string; end: string }): CalendarEvent {
  return { ...e, start: { ...e.start, date: span.start }, end: { ...e.end, date: span.end } }
}
