// InboxDayRail — thin single-day calendar on the right of the Inbox pane, so
// events can be created without leaving triage (click a slot → the standard
// CalendarEventForm; click an event → edit).
//
// Deliberately NOT CalendarGrid: it keeps its OWN date (paging here must not
// navigate the Calendar pane, whose currentDate is global store state) and
// reads Dexie via liveQuery so optimistic creates/deletes appear instantly
// without touching the calendar store's pane-scoped `events` array.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { CalendarDays, ChevronLeft, ChevronRight, PanelRightClose } from 'lucide-react'
import { db } from '@/db'
import { useCalendarStore, fromDbEvent } from '@/store/calendar'
import { optimisticallyDeleted } from '@/calendar/sync'
import { getPref, setPref } from '@/prefs'
import { CalendarEventForm } from './CalendarEventForm'
import type { DbCalendarEvent } from '@/calendar/types'

const HOUR_H = 40 // px per hour — denser than the main grid's 48
const SNAP_MIN = 30
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

interface RailEvent {
  key: string
  summary: string
  start: Date
  end: Date
  color: string
  /** Dexie row — absent for overlay (synthetic, read-only) events. */
  row?: DbCalendarEvent
}

/** Greedy lane layout per overlap-cluster: side-by-side events share the
 *  column width equally within their cluster. */
function layoutLanes(events: RailEvent[]): Array<RailEvent & { lane: number; lanes: number }> {
  const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime())
  const out: Array<RailEvent & { lane: number; lanes: number }> = []
  let cluster: Array<RailEvent & { lane: number; lanes: number }> = []
  let laneEnds: number[] = []
  let clusterEnd = -1
  const flush = () => {
    for (const e of cluster) e.lanes = laneEnds.length
    out.push(...cluster)
    cluster = []
    laneEnds = []
  }
  for (const ev of sorted) {
    const t = ev.start.getTime()
    if (cluster.length && t >= clusterEnd) flush()
    let lane = laneEnds.findIndex((end) => end <= t)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(ev.end.getTime())
    } else {
      laneEnds[lane] = ev.end.getTime()
    }
    clusterEnd = Math.max(clusterEnd, ev.end.getTime())
    cluster.push({ ...ev, lane, lanes: 1 })
  }
  flush()
  return out
}

export const InboxDayRail = memo(function InboxDayRail() {
  const [date, setDate] = useState(() => startOfDay(new Date()))
  const [collapsed, setCollapsed] = useState(() => getPref<boolean>(COLLAPSED_PREF, false))
  const [rows, setRows] = useState<DbCalendarEvent[]>([])
  const [now, setNow] = useState(() => new Date())
  const calendars = useCalendarStore((s) => s.calendars)
  const visibleCalendarIds = useCalendarStore((s) => s.visibleCalendarIds)
  const overlaySources = useCalendarStore((s) => s.overlaySources)
  const showEventForm = useCalendarStore((s) => s.showEventForm)
  const openCreateForm = useCalendarStore((s) => s.openCreateForm)
  const openEditForm = useCalendarStore((s) => s.openEditForm)
  const scrollRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const calColorMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of calendars) m.set(c.id, c.backgroundColor)
    return m
  }, [calendars])

  const { timed, allDay } = useMemo(() => {
    const seen = new Set<string>()
    const timedEvents: RailEvent[] = []
    const allDayEvents: RailEvent[] = []
    for (const r of rows) {
      if (!visibleCalendarIds.has(r.calendarId)) continue
      if (optimisticallyDeleted.has(r.compoundKey)) continue
      const color = calColorMap.get(r.calendarId) || '#3b82f6'
      if (r.allDay) {
        allDayEvents.push({ key: r.compoundKey, summary: r.summary, start: date, end: date, color, row: r })
        continue
      }
      const start = new Date(r.startTime)
      const end = new Date(r.endTime || r.startTime)
      if (!isSameDay(start, date)) continue
      // Merge duplicates shared across calendars (same key as CalendarGrid).
      const mergeKey = `${start.getTime()}_${end.getTime()}_${r.summary}`
      if (seen.has(mergeKey)) continue
      seen.add(mergeKey)
      timedEvents.push({ key: r.compoundKey, summary: r.summary, start, end, color, row: r })
    }
    // Read-only overlay events (Meetup/OutdoorLads) — in-memory only.
    for (const { events } of Object.values(overlaySources)) {
      for (const ev of events) {
        if (!visibleCalendarIds.has(ev.calendarId) || !ev.start.dateTime) continue
        const start = new Date(ev.start.dateTime)
        if (!isSameDay(start, date)) continue
        const end = ev.end.dateTime ? new Date(ev.end.dateTime) : new Date(start.getTime() + 3600_000)
        timedEvents.push({
          key: `${ev.calendarId}:${ev.id}`,
          summary: ev.summary,
          start, end,
          color: calColorMap.get(ev.calendarId) || '#8b5cf6',
        })
      }
    }
    return { timed: layoutLanes(timedEvents), allDay: allDayEvents }
  }, [rows, visibleCalendarIds, calColorMap, overlaySources, date, dateKey])

  const isToday = isSameDay(now, date)

  // Land the viewport near the action: today → just above now; other days → 8am.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const anchorHour = isToday ? Math.max(now.getHours() - 1.5, 0) : 8
    el.scrollTop = anchorHour * HOUR_H
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey, collapsed])

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      setPref(COLLAPSED_PREF, !v)
      return !v
    })
  }

  const onSlotClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const minutes = Math.floor(((e.clientY - rect.top) / HOUR_H) * 60 / SNAP_MIN) * SNAP_MIN
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minutes)
    openCreateForm(start, new Date(start.getTime() + 3600_000))
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
        {showEventForm && <CalendarEventForm />}
      </div>
    )
  }

  return (
    <div className="w-56 flex-shrink-0 border-l border-border flex flex-col overflow-hidden">
      {/* Header: matches the pane's ColumnHeader family */}
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <button onClick={() => setDate((d) => addDays(d, -1))} className="text-text-tertiary hover:text-text-primary p-0.5" title="Previous day">
          <ChevronLeft size={12} />
        </button>
        <span className="relative flex items-center gap-1 min-w-0">
          <button
            onClick={() => dateInputRef.current?.showPicker()}
            className={`truncate text-[11px] ${isToday ? 'text-text-primary font-medium' : 'text-text-secondary'} hover:text-text-primary`}
            title="Pick a date"
          >
            {date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
          </button>
          <input
            ref={dateInputRef}
            type="date"
            value={dateKey}
            onChange={(e) => {
              const [y, m, d] = e.target.value.split('-').map(Number)
              if (y && m && d) setDate(new Date(y, m - 1, d))
            }}
            className="absolute inset-0 opacity-0 pointer-events-none"
            tabIndex={-1}
          />
          {!isToday && (
            <button
              onClick={() => setDate(startOfDay(new Date()))}
              className="text-[10px] text-accent hover:underline flex-shrink-0"
              title="Jump to today"
            >
              today
            </button>
          )}
        </span>
        <span className="flex items-center gap-1">
          <button onClick={() => setDate((d) => addDays(d, 1))} className="text-text-tertiary hover:text-text-primary p-0.5" title="Next day">
            <ChevronRight size={12} />
          </button>
          <button onClick={toggleCollapsed} className="text-text-tertiary hover:text-text-primary p-0.5" title="Collapse">
            <PanelRightClose size={12} />
          </button>
        </span>
      </div>

      {/* All-day chips */}
      {allDay.length > 0 && (
        <div className="border-b border-border px-1.5 py-1 flex flex-col gap-0.5 max-h-20 overflow-y-auto">
          {allDay.map((ev) => (
            <button
              key={ev.key}
              onClick={() => ev.row && openEditForm(fromDbEvent(ev.row))}
              className="truncate rounded-sm px-1.5 py-0.5 text-left text-[10px] text-white"
              style={{ backgroundColor: ev.color }}
              title={ev.summary}
            >
              {ev.summary || '(untitled)'}
            </button>
          ))}
        </div>
      )}

      {/* 24h column */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="relative cursor-crosshair" style={{ height: 24 * HOUR_H }} onClick={onSlotClick} title="Click to create an event">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="absolute left-0 right-0 border-t border-border/40" style={{ top: h * HOUR_H }}>
              <span className="pl-1 text-[9px] text-text-tertiary/70 select-none">{String(h).padStart(2, '0')}</span>
            </div>
          ))}
          {isToday && (
            <div
              className="absolute left-0 right-0 border-t border-red-500 z-10 pointer-events-none"
              style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_H }}
            />
          )}
          {timed.map((ev) => {
            const startMin = ev.start.getHours() * 60 + ev.start.getMinutes()
            const durMin = Math.max((ev.end.getTime() - ev.start.getTime()) / 60_000, 20)
            return (
              <button
                key={ev.key}
                onClick={(e) => {
                  e.stopPropagation()
                  if (ev.row) openEditForm(fromDbEvent(ev.row))
                }}
                className={`absolute overflow-hidden rounded-sm px-1 text-left text-[10px] leading-tight text-white ${ev.row ? '' : 'cursor-default opacity-80'}`}
                style={{
                  top: (startMin / 60) * HOUR_H,
                  height: Math.max((durMin / 60) * HOUR_H - 1, 12),
                  // 16px gutter for the hour labels; lanes split the rest.
                  left: `calc(16px + (100% - 18px) * ${ev.lane / ev.lanes})`,
                  width: `calc((100% - 18px) * ${1 / ev.lanes} - 1px)`,
                  backgroundColor: ev.color,
                }}
                title={`${ev.summary} · ${ev.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
              >
                {ev.summary || '(untitled)'}
              </button>
            )
          })}
        </div>
      </div>

      {showEventForm && <CalendarEventForm />}
    </div>
  )
})
