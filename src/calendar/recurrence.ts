// "Delete this and following events" = truncate the master's RRULE with an
// UNTIL just before the chosen instance (Google's own web UI does the same).

/**
 * Rewrites a recurrence rule set so the series ends before `fromStart`
 * (an instance's start — ISO dateTime, or YYYY-MM-DD for all-day).
 * UNTIL's value type must match DTSTART's (RFC 5545): date-time gets a UTC
 * basic timestamp, all-day gets a bare date. COUNT is dropped — it's mutually
 * exclusive with UNTIL. Non-RRULE lines (EXDATE/RDATE) pass through.
 */
export function truncateRecurrence(recurrence: string[], fromStart: string): string[] {
  const allDay = !fromStart.includes('T')
  const cutoff = new Date(allDay ? `${fromStart}T00:00:00Z` : fromStart).getTime() - 1000
  const until = allDay
    ? new Date(cutoff).toISOString().slice(0, 10).replace(/-/g, '')
    : new Date(cutoff).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return recurrence.map((line) => {
    if (!line.toUpperCase().startsWith('RRULE')) return line
    const parts = line
      .slice(line.indexOf(':') + 1)
      .split(';')
      .filter((p) => p && !/^(UNTIL|COUNT)=/i.test(p))
    return `RRULE:${[...parts, `UNTIL=${until}`].join(';')}`
  })
}
