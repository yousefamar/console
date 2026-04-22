// Calendar pane renderer.
//
// Shows the next 4 upcoming events (from now forward) in the visible
// calendars. If an event is currently selected, its details take priority.

import { useCalendarStore } from '@/store/calendar'
import { buildStatus, clipRow, type MirrorFrame, BODY_ROWS } from '../mirror'

function fmtTime(iso: string, allDay: boolean): string {
  if (!iso) return ''
  if (allDay) {
    // YYYY-MM-DD → "DD MMM"
    const d = new Date(iso)
    const dd = String(d.getDate()).padStart(2, '0')
    const mo = d.toLocaleString('en', { month: 'short' })
    return `${dd} ${mo}`
  }
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return `${hh}:${mm}`
  const dd = String(d.getDate()).padStart(2, '0')
  const mo = d.toLocaleString('en', { month: 'short' })
  return `${dd} ${mo} ${hh}:${mm}`
}

export function renderCalendar(): MirrorFrame | null {
  const { events, selectedEventId, visibleCalendarIds } = useCalendarStore.getState()
  const visible = events.filter((e) => visibleCalendarIds.has(e.calendarId))
  const now = Date.now()

  if (selectedEventId) {
    const ev = visible.find((e) => e.id === selectedEventId)
    if (ev) {
      const allDay = !!ev.start.date && !ev.start.dateTime
      const startIso = ev.start.dateTime || ev.start.date || ''
      const startLabel = fmtTime(startIso, allDay)
      const body = [
        clipRow(ev.summary || '(no title)'),
        clipRow(`@ ${startLabel}`),
        clipRow(ev.location ? `📍 ${ev.location}` : ''),
        clipRow(ev.organizer?.displayName ? `by ${ev.organizer.displayName}` : ''),
      ]
      return {
        status: buildStatus(['Calendar', 'event']),
        body,
      }
    }
  }

  const upcoming = visible
    .filter((e) => {
      const iso = e.start.dateTime || e.start.date || ''
      return iso && new Date(iso).getTime() >= now - 60 * 60_000 // include events still ongoing
    })
    .sort((a, b) => {
      const ai = a.start.dateTime || a.start.date || ''
      const bi = b.start.dateTime || b.start.date || ''
      return new Date(ai).getTime() - new Date(bi).getTime()
    })
    .slice(0, BODY_ROWS)

  const body = upcoming.map((e) => {
    const allDay = !!e.start.date && !e.start.dateTime
    const iso = e.start.dateTime || e.start.date || ''
    const label = fmtTime(iso, allDay)
    return clipRow(`${label}  ${e.summary || '(no title)'}`)
  })

  return {
    status: buildStatus(['Calendar', upcoming.length === 0 ? 'clear' : 'upcoming']),
    body,
  }
}
