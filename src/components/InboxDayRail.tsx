// InboxDayRail — thin single-day calendar on the right of the Inbox pane, so
// events can be created without leaving triage. Rendering is the REAL
// CalendarGrid in host mode (daysOverride/eventsOverride) — drag-to-create,
// drag-move/resize, the event popover, and the event form are all the
// Calendar tab's own components, so the two panes can't drift.
//
// What stays local: the date (paging here must not navigate the Calendar
// pane, whose currentDate is global store state) and the event source — a
// Dexie liveQuery so optimistic creates/deletes appear instantly without
// touching the calendar store's pane-scoped `events` array.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { CalendarDays, ChevronLeft, ChevronRight, PanelRightClose } from 'lucide-react'
import { db } from '@/db'
import { useCalendarStore, fromDbEvent } from '@/store/calendar'
import { optimisticallyDeleted } from '@/calendar/sync'
import { getPref, setPref } from '@/prefs'
import { CalendarGrid } from './CalendarGrid'
import { CalendarEventForm } from './CalendarEventForm'
import { CalendarEventPopover } from './CalendarEventPopover'
import type { CalendarEvent, DbCalendarEvent } from '@/calendar/types'

const COLLAPSED_PREF = 'inboxDayRailCollapsed'

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}
function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const InboxDayRail = memo(function InboxDayRail() {
  const [date, setDate] = useState(() => startOfDay(new Date()))
  const [collapsed, setCollapsed] = useState(() => getPref<boolean>(COLLAPSED_PREF, false))
  const [rows, setRows] = useState<DbCalendarEvent[]>([])
  const visibleCalendarIds = useCalendarStore((s) => s.visibleCalendarIds)
  const overlaySources = useCalendarStore((s) => s.overlaySources)
  const showEventForm = useCalendarStore((s) => s.showEventForm)
  const selectedEventId = useCalendarStore((s) => s.selectedEventId)
  const dateInputRef = useRef<HTMLInputElement>(null)
  const dateKey = localDateStr(date)

  // Dexie is the source of truth: optimistic creates land there first, so the
  // liveQuery refires the moment the form submits — no store round-trip.
  useEffect(() => {
    const rangeStart = startOfDay(date)
    const rangeEnd = addDays(rangeStart, 1)
    const sub = liveQuery(async () => {
      const timed = await db.calendarEvents
        .where('startTime')
        .between(rangeStart.toISOString(), rangeEnd.toISOString(), true, false)
        .toArray()
      // All-day rows store startTime as a bare YYYY-MM-DD.
      const allDay = await db.calendarEvents.where('startTime').equals(dateKey).toArray()
      return [...timed, ...allDay]
    }).subscribe({ next: setRows, error: (e) => console.error('[inbox-rail]', e) })
    return () => sub.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey])

  // Backfill from Google when paging outside the calendar pane's fetched
  // range (debounced against rapid paging). Writes to Dexie → liveQuery.
  useEffect(() => {
    const t = setTimeout(() => {
      const s = startOfDay(date)
      void useCalendarStore.getState().fetchEvents(s, addDays(s, 1))
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey])

  // Same shape loadEventsFromDb produces: visible, non-deleted Dexie rows
  // mapped via fromDbEvent, then in-memory overlay events (Meetup etc.).
  const events = useMemo<CalendarEvent[]>(() => {
    const out: CalendarEvent[] = []
    for (const r of rows) {
      if (!visibleCalendarIds.has(r.calendarId)) continue
      if (optimisticallyDeleted.has(r.compoundKey)) continue
      out.push(fromDbEvent(r))
    }
    const dayStart = startOfDay(date).getTime()
    const dayEnd = addDays(date, 1).getTime()
    for (const { events: overlayEvents } of Object.values(overlaySources)) {
      for (const ev of overlayEvents) {
        if (!visibleCalendarIds.has(ev.calendarId) || !ev.start.dateTime) continue
        const t = new Date(ev.start.dateTime).getTime()
        if (t >= dayStart && t < dayEnd) out.push(ev)
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, visibleCalendarIds, overlaySources, dateKey])

  const days = useMemo(() => [date], [dateKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const isToday = isSameDay(new Date(), date)

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      setPref(COLLAPSED_PREF, !v)
      return !v
    })
  }

  if (collapsed) {
    return (
      <div className="w-8 flex-shrink-0 border-l border-border flex flex-col items-center pt-2">
        <button
          onClick={toggleCollapsed}
          className="text-text-tertiary hover:text-text-primary"
          title="Show day calendar"
        >
          <CalendarDays size={14} />
        </button>
      </div>
    )
  }

  return (
    <div className="w-64 flex-shrink-0 border-l border-border flex flex-col overflow-hidden">
      {/* Date nav header — replaces the grid's week-oriented header */}
      <div className="relative flex items-center justify-between border-b border-border px-2 py-1 flex-shrink-0">
        <button onClick={toggleCollapsed} className="text-text-tertiary hover:text-text-primary p-0.5" title="Collapse">
          <PanelRightClose size={12} />
        </button>
        <span className="flex items-center gap-0.5 min-w-0">
          <button onClick={() => setDate((d) => addDays(d, -1))} className="text-text-tertiary hover:text-text-primary p-0.5" title="Previous day">
            <ChevronLeft size={12} />
          </button>
          <button
            onClick={() => dateInputRef.current?.showPicker()}
            className={`truncate text-[11px] ${isToday ? 'text-text-primary font-medium' : 'text-text-secondary'} hover:text-text-primary`}
            title="Pick a date"
          >
            {date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
          </button>
          <button onClick={() => setDate((d) => addDays(d, 1))} className="text-text-tertiary hover:text-text-primary p-0.5" title="Next day">
            <ChevronRight size={12} />
          </button>
        </span>
        {/* Today chip mirrors the Calendar header's Event-button styling;
            invisible (not absent) when already on today so the nav cluster
            stays centered. */}
        <button
          onClick={() => setDate(startOfDay(new Date()))}
          className={`px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-text-primary bg-surface-2 border border-border rounded-sm transition-colors ${isToday ? 'invisible' : ''}`}
          title="Jump to today"
        >
          Today
        </button>
        {/* Hidden input anchors the native date picker. It spans the full
            rail width so the popup's left edge aligns with the rail's left
            edge — the one placement that keeps a ~250px popup on-screen for
            a right-edge rail (label-anchored clipped right; a 0×0 input
            anchored left of the label made Chrome fall back to screen-left). */}
        <input
          ref={dateInputRef}
          type="date"
          value={dateKey}
          onChange={(e) => {
            const [y, m, d] = e.target.value.split('-').map(Number)
            if (y && m && d) setDate(new Date(y, m - 1, d))
          }}
          className="absolute left-0 right-0 top-full h-0 opacity-0 pointer-events-none"
          tabIndex={-1}
        />
      </div>

      {/* The Calendar tab's own grid, pinned to one day */}
      <CalendarGrid
        daysOverride={days}
        eventsOverride={events}
        hideHeader
        scrollToHour={isToday ? Math.max(new Date().getHours() - 1.5, 0) : 8}
      />

      {/* Same popover/form the Calendar tab mounts — with the rail's event
          source so a click resolves against what's actually rendered. */}
      {selectedEventId && <CalendarEventPopover eventsOverride={events} />}
      {showEventForm && <CalendarEventForm />}
    </div>
  )
})
