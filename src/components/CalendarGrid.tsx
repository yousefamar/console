import { useMemo, useCallback, useState, useRef, useEffect } from 'react'
import { useCalendarStore } from '@/store/calendar'
import { ChevronLeft, ChevronRight, Plus, MapPin, Square, Bell } from 'lucide-react'

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const HOUR_HEIGHT = 48 // pixels per hour
const SNAP_MINUTES = 15
const SNAP_PX = (SNAP_MINUTES / 60) * HOUR_HEIGHT // 12px

function muteColor(hex: string): { bg: string; border: string; text: string } {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const mix = (c: number) => Math.round(c * 0.35 + 25)
  const br = (c: number) => Math.round(c * 0.5 + 160)
  return {
    bg: `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`,
    border: hex,
    text: `rgb(${br(r)}, ${br(g)}, ${br(b)})`,
  }
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function weekStart(d: Date): Date {
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  return new Date(d.getFullYear(), d.getMonth(), diff)
}

function locationLabel(e: { summary?: string; workingLocationProperties?: { type: string; officeLocation?: { label?: string }; customLocation?: { label?: string } } }): string {
  const p = e.workingLocationProperties
  if (p) {
    if (p.type === 'homeOffice') return 'Home'
    if (p.type === 'officeLocation') return p.officeLocation?.label || 'Office'
    if (p.type === 'customLocation') return p.customLocation?.label || 'Custom'
  }
  // Fallback to summary if no properties (e.g. stale cache)
  const s = e.summary
  if (s && s !== '(No title)') return s
  return 'Home'
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Local YYYY-MM-DD (avoids UTC shift from toISOString) */
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

function snapToGrid(px: number): number {
  return Math.round(px / SNAP_PX) * SNAP_PX
}

function pxToMinutes(px: number): number {
  return Math.round((px / HOUR_HEIGHT) * 60 / SNAP_MINUTES) * SNAP_MINUTES
}

function formatMinutes(m: number): string {
  const h = Math.floor(m / 60)
  const min = m % 60
  return `${h}:${String(min).padStart(2, '0')}`
}

interface PositionedEvent {
  id: string
  calendarId: string
  accountEmail: string
  summary: string
  startTime: Date
  endTime: Date
  allDay: boolean
  color: string
  colors: string[]     // all calendar colors (for merged duplicates)
  top: number
  height: number
  left: number
  width: number
  column: number
  hangoutLink?: string
  location?: string
  recurringEventId?: string
  isTask: boolean      // Google Task (has tasks.google.com link in description)
  isOwn: boolean       // true if calendarId matches a connected account email
  accepted: boolean  // false = needsAction, tentative, or declined
  hasReminder: boolean // has non-default reminder override
}

type DragMode = 'create' | 'move' | 'resize'

interface DragState {
  mode: DragMode
  dayIdx: number
  origDayIdx: number   // day column where drag started (for cross-day detection)
  startY: number       // px position where drag started (grid-relative)
  currentY: number     // current px position
  eventId?: string     // for move/resize
  eventOrigTop?: number
  eventOrigHeight?: number
  offsetY?: number     // mouse offset from event top (for move)
}

interface PendingRecurringEdit {
  event: PositionedEvent
  newStart: Date
  newEnd: Date
}

// --------------------------------------------------------------------------
// CalendarGrid
// --------------------------------------------------------------------------

export function CalendarGrid() {
  const events = useCalendarStore((s) => s.events)
  const calendars = useCalendarStore((s) => s.calendars)
  const currentDate = useCalendarStore((s) => s.currentDate)
  const view = useCalendarStore((s) => s.view)
  const navigateWeek = useCalendarStore((s) => s.navigateWeek)
  const selectEvent = useCalendarStore((s) => s.selectEvent)
  const selectedEventId = useCalendarStore((s) => s.selectedEventId)
  const openCreateForm = useCalendarStore((s) => s.openCreateForm)
  const updateEvent = useCalendarStore((s) => s.updateEvent)
  const openLocationPicker = useCalendarStore((s) => s.openLocationPicker)
  const accounts = useCalendarStore((s) => s.accounts)

  // Set of account emails — used to identify "my own" calendar copies during merge
  const ownCalendarIds = useMemo(() => new Set(accounts.map((a) => a.email)), [accounts])

  const [drag, setDrag] = useState<DragState | null>(null)
  const [pendingEdit, setPendingEdit] = useState<PendingRecurringEdit | null>(null)
  const didDragRef = useRef(false) // suppresses click after drag
  const gridRef = useRef<HTMLDivElement>(null)
  const colRefs = useRef<(HTMLDivElement | null)[]>([])

  const calColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of calendars) map.set(c.id, c.backgroundColor)
    return map
  }, [calendars])

  const calHasDefaultReminders = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const c of calendars) map.set(c.id, !!c.defaultReminders?.length)
    return map
  }, [calendars])

  const days = useMemo(() => {
    if (view === 'day') return [currentDate]
    const start = weekStart(currentDate)
    return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  }, [currentDate, view])

  const today = new Date()

  const { locationEvents, allDayEvents, timedEvents } = useMemo(() => {
    const locations: typeof events = []
    const allDay: typeof events = []
    const timed: typeof events = []
    for (const e of events) {
      if (e.eventType === 'workingLocation') locations.push(e)
      else if (e.start.date && !e.start.dateTime) allDay.push(e)
      else timed.push(e)
    }
    return { locationEvents: locations, allDayEvents: allDay, timedEvents: timed }
  }, [events])

  const positionedEvents = useMemo(() => {
    const positioned: PositionedEvent[] = []

    for (let colIdx = 0; colIdx < days.length; colIdx++) {
      const day = days[colIdx]!
      const rawEvents = timedEvents
        .filter((e) => {
          const start = new Date(e.start.dateTime!)
          return isSameDay(start, day)
        })
        .map((e) => {
          const start = new Date(e.start.dateTime!)
          const end = new Date(e.end.dateTime!)
          const startMinutes = start.getHours() * 60 + start.getMinutes()
          const endMinutes = end.getHours() * 60 + end.getMinutes()
          const duration = Math.max(endMinutes - startMinutes, 15)
          const color = calColorMap.get(e.calendarId) || '#3b82f6'
          return {
            id: e.id, calendarId: e.calendarId, accountEmail: e.accountEmail, summary: e.summary,
            startTime: start, endTime: end, allDay: false,
            color, colors: [color],
            top: (startMinutes / 60) * HOUR_HEIGHT,
            height: (duration / 60) * HOUR_HEIGHT,
            left: 0, width: 1, column: colIdx,
            hangoutLink: e.hangoutLink, location: e.location,
            recurringEventId: e.recurringEventId,
            isTask: !!e.description?.includes('tasks.google.com/task/'),
            isOwn: ownCalendarIds.has(e.calendarId),
            accepted: !e.attendees || e.attendees.find(a => a.self)?.responseStatus === 'accepted',
            hasReminder: e.reminders
              ? (e.reminders.useDefault ? !!calHasDefaultReminders.get(e.calendarId) : !!e.reminders.overrides?.length)
              : !!calHasDefaultReminders.get(e.calendarId),
          }
        })

      // Merge duplicate events (same summary + same start/end across different calendars)
      const merged: PositionedEvent[] = []
      const mergeKey = (ev: PositionedEvent) => `${ev.startTime.getTime()}_${ev.endTime.getTime()}_${ev.summary}`
      const mergeMap = new Map<string, PositionedEvent>()
      for (const ev of rawEvents) {
        const key = mergeKey(ev)
        const existing = mergeMap.get(key)
        if (existing && existing.calendarId !== ev.calendarId) {
          // Duplicate from another calendar — merge colors and accepted status
          if (!existing.colors.includes(ev.color)) {
            existing.colors.push(ev.color)
          }
          // Prefer the user's own calendar copy for display + popover/RSVP
          if (ev.isOwn && !existing.isOwn) {
            existing.id = ev.id
            existing.calendarId = ev.calendarId
            existing.accountEmail = ev.accountEmail
            existing.color = ev.color
            existing.isOwn = true
          }
          // If any copy is accepted, the merged event is accepted
          if (ev.accepted) existing.accepted = true
        } else if (!existing) {
          mergeMap.set(key, ev)
          merged.push(ev)
        }
      }

      const dayEvents = merged.sort((a, b) => a.top - b.top || b.height - a.height)

      // Column assignment: place each event in the first column where it doesn't
      // overlap any existing event. This stacks non-overlapping events vertically
      // instead of giving every connected event its own column.
      const columns: PositionedEvent[][] = []
      for (const ev of dayEvents) {
        let placed = false
        for (let c = 0; c < columns.length; c++) {
          const overlaps = columns[c]!.some((g) => ev.top < g.top + g.height && ev.top + ev.height > g.top)
          if (!overlaps) {
            columns[c]!.push(ev)
            ev.column = colIdx // day column (unchanged)
            placed = true
            break
          }
        }
        if (!placed) {
          columns.push([ev])
        }
      }

      // Assign left/width based on how many columns are needed at each event's position
      for (let c = 0; c < columns.length; c++) {
        for (const ev of columns[c]!) {
          // Count how many columns have events overlapping this event's time range
          let maxCols = columns.length
          // Find the actual number of concurrent columns at this event's time
          let concurrent = 0
          for (const col of columns) {
            if (col.some((g) => ev.top < g.top + g.height && ev.top + ev.height > g.top)) {
              concurrent++
            }
          }
          maxCols = Math.max(concurrent, 1)
          ev.left = c / maxCols
          ev.width = 1 / maxCols
        }
      }

      for (const col of columns) positioned.push(...col)
    }
    return positioned
  }, [timedEvents, days, calColorMap, ownCalendarIds])

  const headerLabel = useMemo(() => {
    if (view === 'day') {
      return currentDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    }
    const start = days[0]!
    const end = days[6]!
    if (start.getMonth() === end.getMonth()) {
      return `${start.toLocaleDateString(undefined, { month: 'long' })} ${start.getDate()}\u2013${end.getDate()}, ${start.getFullYear()}`
    }
    return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} \u2013 ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
  }, [days, view, currentDate])

  // --- Drag-to-create: mousedown on empty grid ---
  const handleGridMouseDown = useCallback((e: React.MouseEvent, dayIdx: number) => {
    if (e.button !== 0) return
    const col = colRefs.current[dayIdx]
    if (!col) return
    const rect = col.getBoundingClientRect()
    const y = e.clientY - rect.top
    const snapped = snapToGrid(y)
    setDrag({ mode: 'create', dayIdx, origDayIdx: dayIdx, startY: snapped, currentY: snapped })
    e.preventDefault()
  }, [])

  // --- Drag-to-move: mousedown on event ---
  const handleEventMouseDown = useCallback((e: React.MouseEvent, ev: PositionedEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    didDragRef.current = false
    const col = colRefs.current[ev.column]
    if (!col) return
    const rect = col.getBoundingClientRect()
    const y = e.clientY - rect.top
    setDrag({
      mode: 'move', dayIdx: ev.column, origDayIdx: ev.column,
      startY: y, currentY: y,
      eventId: ev.id, eventOrigTop: ev.top, eventOrigHeight: ev.height,
      offsetY: y - ev.top,
    })
    e.preventDefault()
  }, [])

  // --- Drag-to-resize: mousedown on bottom edge ---
  const handleResizeMouseDown = useCallback((e: React.MouseEvent, ev: PositionedEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const col = colRefs.current[ev.column]
    if (!col) return
    const rect = col.getBoundingClientRect()
    const y = e.clientY - rect.top
    setDrag({
      mode: 'resize', dayIdx: ev.column, origDayIdx: ev.column,
      startY: y, currentY: y,
      eventId: ev.id, eventOrigTop: ev.top, eventOrigHeight: ev.height,
    })
    e.preventDefault()
  }, [])

  // --- Global mousemove/mouseup for drag ---
  useEffect(() => {
    if (!drag) return

    const handleMouseMove = (e: MouseEvent) => {
      // Detect which day column the cursor is over
      let newDayIdx = drag.dayIdx
      for (let i = 0; i < colRefs.current.length; i++) {
        const c = colRefs.current[i]
        if (!c) continue
        const r = c.getBoundingClientRect()
        if (e.clientX >= r.left && e.clientX < r.right) {
          newDayIdx = i
          break
        }
      }
      const col = colRefs.current[newDayIdx]
      if (!col) return
      const rect = col.getBoundingClientRect()
      const y = e.clientY - rect.top
      didDragRef.current = true
      setDrag((d) => d ? { ...d, currentY: y, dayIdx: newDayIdx } : null)
    }

    const handleMouseUp = () => {
      if (!drag) return
      const d = drag
      setDrag(null)

      if (d.mode === 'create') {
        const topPx = Math.min(d.startY, d.currentY)
        const bottomPx = Math.max(d.startY, d.currentY)
        const height = bottomPx - topPx
        if (height < SNAP_PX) {
          // Too small — ignore click, only dragging creates events
          return
        } else {
          const startMin = pxToMinutes(snapToGrid(topPx))
          const endMin = pxToMinutes(snapToGrid(bottomPx))
          const day = days[d.dayIdx]!
          const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, startMin)
          const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, endMin)
          openCreateForm(start, end)
        }
      } else if (d.mode === 'move' && d.eventId && didDragRef.current) {
        const newTop = snapToGrid(d.eventOrigTop! + (d.currentY - d.startY))
        if (newTop === d.eventOrigTop && d.dayIdx === d.origDayIdx) return // no change
        const startMin = pxToMinutes(Math.max(0, newTop))
        const endMin = startMin + pxToMinutes(d.eventOrigHeight!)
        const day = days[d.dayIdx]!
        const posEv = positionedEvents.find((e) => e.id === d.eventId)
        if (posEv) {
          const newStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, startMin)
          const newEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, endMin)
          if (posEv.recurringEventId) {
            setPendingEdit({ event: posEv, newStart, newEnd })
          } else {
            updateEvent(posEv.calendarId, posEv.accountEmail, posEv.id, {
              start: { dateTime: newStart.toISOString() },
              end: { dateTime: newEnd.toISOString() },
            })
          }
        }
      } else if (d.mode === 'resize' && d.eventId && didDragRef.current) {
        const newHeight = snapToGrid(d.eventOrigHeight! + (d.currentY - d.startY))
        if (newHeight === d.eventOrigHeight) return // no change
        const endMin = pxToMinutes(d.eventOrigTop!) + pxToMinutes(Math.max(SNAP_PX, newHeight))
        const day = days[d.dayIdx]!
        const posEv = positionedEvents.find((e) => e.id === d.eventId)
        if (posEv) {
          const startMin2 = pxToMinutes(d.eventOrigTop!)
          const newStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, startMin2)
          const newEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, endMin)
          if (posEv.recurringEventId) {
            setPendingEdit({ event: posEv, newStart, newEnd })
          } else {
            updateEvent(posEv.calendarId, posEv.accountEmail, posEv.id, {
              end: { dateTime: newEnd.toISOString() },
            })
          }
        }
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [drag, days, events, openCreateForm, updateEvent])

  // Compute drag preview
  const dragPreview = useMemo(() => {
    if (!drag) return null
    if (drag.mode === 'create') {
      const top = snapToGrid(Math.min(drag.startY, drag.currentY))
      const bottom = snapToGrid(Math.max(drag.startY, drag.currentY))
      const height = Math.max(bottom - top, SNAP_PX)
      return { dayIdx: drag.dayIdx, top, height, startMin: pxToMinutes(top), endMin: pxToMinutes(top + height) }
    }
    if (drag.mode === 'move') {
      const newTop = snapToGrid(drag.eventOrigTop! + (drag.currentY - drag.startY))
      return { dayIdx: drag.dayIdx, top: Math.max(0, newTop), height: drag.eventOrigHeight! }
    }
    if (drag.mode === 'resize') {
      const newHeight = snapToGrid(drag.eventOrigHeight! + (drag.currentY - drag.startY))
      return { dayIdx: drag.dayIdx, top: drag.eventOrigTop!, height: Math.max(SNAP_PX, newHeight) }
    }
    return null
  }, [drag])

  const nowMinutes = today.getHours() * 60 + today.getMinutes()
  const nowTop = (nowMinutes / 60) * HOUR_HEIGHT

  return (
    <div className="flex flex-col flex-1 min-h-0 select-none">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border flex-shrink-0">
        <button onClick={() => navigateWeek(-1)} className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5">
          <ChevronLeft size={14} />
        </button>
        <button onClick={() => navigateWeek(1)} className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5">
          <ChevronRight size={14} />
        </button>
        <span className="text-sm font-medium text-text-primary">{headerLabel}</span>
        <div className="flex-1" />
        <button
          onClick={() => openCreateForm()}
          className="flex items-center gap-1 px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary bg-surface-2 border border-border rounded-sm transition-colors"
        >
          <Plus size={11} />
          Event
        </button>
      </div>

      {/* Day headers — pr-1.5 matches scrollbar width (6px) in time grid */}
      <div className="flex border-b border-border flex-shrink-0 pr-1.5">
        <div className="w-12 flex-shrink-0" />
        {days.map((day, i) => {
          const isToday = isSameDay(day, today)
          return (
            <div key={i} className={`flex-1 text-center py-1 border-l border-border ${isToday ? 'bg-accent/5' : ''}`}>
              <div className="text-[10px] text-text-tertiary uppercase">{DAY_NAMES[day.getDay() === 0 ? 6 : day.getDay() - 1]}</div>
              <div className={`text-sm font-medium ${isToday ? 'text-accent' : 'text-text-primary'}`}>{day.getDate()}</div>
            </div>
          )
        })}
      </div>

      {/* Working location row */}
      {locationEvents.length > 0 && (
        <div className="flex border-b border-border flex-shrink-0 pr-1.5">
          <div className="w-12 flex-shrink-0 flex items-center justify-end pr-1">
            <MapPin size={10} className="text-text-tertiary" />
          </div>
          {days.map((day, dayIdx) => {
            const dayStr = localDateStr(day)
            const dayLocation = locationEvents.find((e) => dayStr! >= e.start.date! && dayStr! < e.end.date!)
            return (
              <div key={dayIdx} className="flex-1 border-l border-border px-1 py-0.5">
                {dayLocation ? (
                  <button
                    onClick={() => openLocationPicker(dayLocation)}
                    className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors truncate block w-full text-left"
                    title="Click to edit location"
                  >
                    {locationLabel(dayLocation)}
                  </button>
                ) : (
                  <span className="text-[10px] text-text-tertiary/30">—</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* All-day events bar */}
      {allDayEvents.length > 0 && (
        <AllDayBar
          events={allDayEvents}
          days={days}
          calColorMap={calColorMap}
          selectedEventId={selectedEventId}
          selectEvent={selectEvent}
        />
      )}

      {/* Time grid */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden relative" ref={gridRef}>
        <div className="flex" style={{ minHeight: 24 * HOUR_HEIGHT }}>
          {/* Time labels */}
          <div className="w-12 flex-shrink-0 relative">
            {HOURS.map((h) => (
              <div key={h} className="absolute right-1 text-[10px] text-text-tertiary" style={{ top: h * HOUR_HEIGHT - 6 }}>
                {h === 0 ? '' : `${h}:00`}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((day, dayIdx) => {
            const isToday = isSameDay(day, today)
            const dayEvents = positionedEvents.filter((e) => e.column === dayIdx)

            return (
              <div
                key={dayIdx}
                ref={(el) => { colRefs.current[dayIdx] = el }}
                className={`flex-1 relative border-l border-border ${isToday ? 'bg-accent/3' : ''}`}
                onMouseDown={(e) => handleGridMouseDown(e, dayIdx)}
              >
                {/* Hour gridlines */}
                {HOURS.map((h) => (
                  <div key={h} className="absolute w-full border-t border-border/50" style={{ top: h * HOUR_HEIGHT, height: HOUR_HEIGHT }} />
                ))}

                {/* Current time indicator */}
                {isToday && (
                  <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: nowTop }}>
                    <div className="flex items-center">
                      <div className="w-2 h-2 rounded-full bg-red-500 -ml-1" />
                      <div className="flex-1 h-px bg-red-500" />
                    </div>
                  </div>
                )}

                {/* Drag preview */}
                {dragPreview && dragPreview.dayIdx === dayIdx && (
                  <div
                    className="absolute left-0 right-0 z-30 rounded-sm border border-accent pointer-events-none"
                    style={{
                      top: dragPreview.top,
                      height: dragPreview.height,
                      backgroundColor: drag?.mode === 'create' ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.25)',
                    }}
                  >
                    {drag?.mode === 'create' && dragPreview.startMin !== undefined && (
                      <div className="px-1 py-0.5 text-[10px] text-accent">
                        {formatMinutes(dragPreview.startMin!)} – {formatMinutes(dragPreview.endMin!)}
                      </div>
                    )}
                  </div>
                )}

                {/* Events */}
                {dayEvents.map((ev) => {
                  const muted = muteColor(ev.color)
                  const isDragging = drag && (drag.mode === 'move' || drag.mode === 'resize') && drag.eventId === ev.id
                  const unaccepted = !ev.accepted

                  const hasMultipleColors = ev.colors.length > 1
                  const stripeWidth = 3 // px per stripe
                  const totalStripeWidth = hasMultipleColors ? ev.colors.length * stripeWidth : 0

                  return (
                    <div
                      key={ev.id}
                      onMouseDown={(e) => handleEventMouseDown(e, ev)}
                      onClick={(e) => { e.stopPropagation(); if (!drag && !didDragRef.current) selectEvent(ev.id); didDragRef.current = false }}
                      className={`absolute z-10 rounded-sm overflow-hidden text-left cursor-grab ${
                        unaccepted ? 'border border-dashed' : hasMultipleColors ? 'border border-black/30' : 'border-l-2 border border-black/30'
                      } ${
                        selectedEventId === ev.id ? 'ring-1 ring-white/30 brightness-125' : 'hover:brightness-125'
                      } ${isDragging ? 'opacity-40' : ''}`}
                      style={{
                        top: ev.top + 1,
                        height: Math.max(ev.height - 2, 16),
                        left: `${ev.left * 100}%`,
                        width: `calc(${ev.width * 100}% - 3px)`,
                        backgroundColor: unaccepted ? 'transparent' : muted.bg,
                        borderTopColor: unaccepted ? muted.border : undefined,
                        borderRightColor: unaccepted ? muted.border : undefined,
                        borderBottomColor: unaccepted ? muted.border : undefined,
                        borderLeftColor: unaccepted ? muted.border : hasMultipleColors ? undefined : muted.border,
                      }}
                    >
                      {/* Multi-calendar color stripes */}
                      {hasMultipleColors && (
                        <div className="absolute left-0 top-0 bottom-0 flex">
                          {ev.colors.map((c, i) => (
                            <div key={i} style={{ width: stripeWidth, backgroundColor: c }} />
                          ))}
                        </div>
                      )}
                      <div className="py-0.5 h-full overflow-hidden" style={{ paddingLeft: hasMultipleColors ? totalStripeWidth + 3 : 4 }}>
                        <div className="text-[10px] font-medium truncate leading-tight flex items-center gap-1" style={{ color: muted.text }}>
                          {ev.isTask && <Square size={8} className="flex-shrink-0 opacity-70" strokeWidth={2.5} />}
                          {ev.hasReminder && <Bell size={8} className="flex-shrink-0 opacity-70" />}
                          <span className="truncate">{ev.summary}</span>
                        </div>
                        {ev.height > 30 && (
                          <div className="text-[9px] truncate" style={{ color: muted.text, opacity: 0.8 }}>
                            {formatTime(ev.startTime)} – {formatTime(ev.endTime)}
                          </div>
                        )}
                        {ev.height > 50 && ev.location && (
                          <div className="text-[9px] truncate" style={{ color: muted.text, opacity: 0.65 }}>
                            {ev.location}
                          </div>
                        )}
                      </div>
                      {/* Resize handle */}
                      <div
                        onMouseDown={(e) => handleResizeMouseDown(e, ev)}
                        className="absolute bottom-0 left-0 right-0 h-2 cursor-s-resize hover:bg-white/10"
                      />
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {/* Recurring event edit dialog */}
      {pendingEdit && (
        <RecurringEditDialog
          pending={pendingEdit}
          onThisEvent={() => {
            const { event, newStart, newEnd } = pendingEdit
            updateEvent(event.calendarId, event.accountEmail, event.id, {
              start: { dateTime: newStart.toISOString() },
              end: { dateTime: newEnd.toISOString() },
            })
            setPendingEdit(null)
          }}
          onAllEvents={() => {
            const { event, newStart, newEnd } = pendingEdit
            // Patch the master recurring event
            updateEvent(event.calendarId, event.accountEmail, event.recurringEventId!, {
              start: { dateTime: newStart.toISOString() },
              end: { dateTime: newEnd.toISOString() },
            })
            setPendingEdit(null)
          }}
          onDiscard={() => setPendingEdit(null)}
        />
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// RecurringEditDialog
// --------------------------------------------------------------------------

function RecurringEditDialog({ pending, onThisEvent, onAllEvents, onDiscard }: {
  pending: PendingRecurringEdit
  onThisEvent: () => void
  onAllEvents: () => void
  onDiscard: () => void
}) {
  const [scope, setScope] = useState<'this' | 'all'>('this')
  const { event, newStart, newEnd } = pending

  const oldTime = `${formatTime(event.startTime)}\u2013${formatTime(event.endTime)}`
  const newTime = `${newStart.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}\u2013${newEnd.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onDiscard}>
      <div
        className="bg-surface-0 border border-border rounded-sm shadow-lg w-80 animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3 pb-2">
          <h3 className="text-sm font-medium text-text-primary">
            Edit repeat event &ldquo;{event.summary}&rdquo;
          </h3>
        </div>

        <div className="px-4 py-2 space-y-1.5">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="scope" checked={scope === 'this'} onChange={() => setScope('this')} className="accent-accent" />
            <span className="text-xs text-text-primary">This event</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} className="accent-accent" />
            <span className="text-xs text-text-primary">All events</span>
          </label>
        </div>

        <div className="px-4 py-2 text-xs">
          <div className="flex items-baseline gap-1.5">
            <span className="text-text-tertiary">Time</span>
            <div>
              <span className="text-text-secondary line-through">{oldTime}</span>
              <span className="text-text-tertiary mx-1">&rarr;</span>
              <span className="text-accent font-medium">{newTime}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-border">
          <button onClick={onDiscard} className="px-2 py-1 text-xs text-red-400 hover:text-red-300 transition-colors">
            Discard change
          </button>
          <div className="flex-1" />
          <button
            onClick={scope === 'this' ? onThisEvent : onAllEvents}
            className="px-3 py-1 text-xs font-medium bg-accent text-white rounded-sm hover:bg-accent-hover transition-colors"
          >
            Save event
          </button>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// AllDayBar — renders multi-day events as spanning rectangles
// --------------------------------------------------------------------------

import type { CalendarEvent } from '@/calendar/types'

function AllDayBar({ events, days, calColorMap, selectedEventId, selectEvent }: {
  events: CalendarEvent[]
  days: Date[]
  calColorMap: Map<string, string>
  selectedEventId: string | null
  selectEvent: (id: string | null) => void
}) {
  // Compute layout: each event gets a startCol, spanCols, and row
  const layout = useMemo(() => {
    const dayStrs = days.map(localDateStr)
    const firstDay = dayStrs[0]!
    const lastDay = dayStrs[dayStrs.length - 1]!

    // Filter to events visible in this week
    const visible = events.filter((e) => {
      const eStart = e.start.date!
      const eEnd = e.end.date!
      return eEnd > firstDay && eStart <= lastDay
    })

    // Compute column positions
    const positioned = visible.map((e) => {
      const eStart = e.start.date!
      const eEnd = e.end.date!

      // Find first visible day
      let startCol = dayStrs.findIndex((d) => d >= eStart)
      if (startCol < 0) startCol = 0

      // Find last visible day (end date is exclusive in Google Calendar)
      let endCol = dayStrs.findIndex((d) => d >= eEnd)
      if (endCol < 0) endCol = days.length
      // endCol is exclusive, so span = endCol - startCol
      const span = Math.max(endCol - startCol, 1)

      return { event: e, startCol, span }
    })

    // Row assignment — greedy: place each event in the first row where it fits
    const rows: Array<Array<{ startCol: number; endCol: number }>> = []
    const result: Array<{ event: CalendarEvent; startCol: number; span: number; row: number }> = []

    // Sort by start col, then by longer span first
    positioned.sort((a, b) => a.startCol - b.startCol || b.span - a.span)

    for (const p of positioned) {
      const endCol = p.startCol + p.span
      let placed = false
      for (let r = 0; r < rows.length; r++) {
        const conflicts = rows[r]!.some((occ) => p.startCol < occ.endCol && endCol > occ.startCol)
        if (!conflicts) {
          rows[r]!.push({ startCol: p.startCol, endCol })
          result.push({ ...p, row: r })
          placed = true
          break
        }
      }
      if (!placed) {
        rows.push([{ startCol: p.startCol, endCol }])
        result.push({ ...p, row: rows.length - 1 })
      }
    }

    return { items: result, rowCount: rows.length }
  }, [events, days])

  const ROW_HEIGHT = 18
  const totalHeight = Math.max(layout.rowCount * (ROW_HEIGHT + 2) + 4, 24)
  const numDays = days.length

  return (
    <div className="flex border-b border-border flex-shrink-0 pr-1.5" style={{ height: totalHeight }}>
      <div className="w-12 flex-shrink-0 text-[9px] text-text-tertiary text-right pr-1 pt-0.5">all-day</div>
      <div className="flex-1 relative">
        {/* Column borders */}
        {days.map((_, i) => (
          <div key={i} className="absolute top-0 bottom-0 border-l border-border" style={{ left: `${(i / numDays) * 100}%` }} />
        ))}
        {/* Spanning event blocks */}
        {layout.items.map(({ event, startCol, span, row }) => {
          const muted = muteColor(calColorMap.get(event.calendarId) || '#3b82f6')
          const leftPct = (startCol / numDays) * 100
          const widthPct = (span / numDays) * 100
          return (
            <button
              key={event.id}
              onClick={() => selectEvent(event.id)}
              className={`absolute text-left px-1.5 text-[10px] rounded-sm truncate border-l-2 border border-black/30 transition-colors hover:brightness-125 ${
                selectedEventId === event.id ? 'ring-1 ring-white/30 brightness-125' : ''
              }`}
              style={{
                top: row * (ROW_HEIGHT + 2) + 2,
                height: ROW_HEIGHT,
                left: `calc(${leftPct}% + 2px)`,
                width: `calc(${widthPct}% - 4px)`,
                backgroundColor: muted.bg,
                borderLeftColor: muted.border,
                color: muted.text,
                lineHeight: `${ROW_HEIGHT}px`,
              }}
            >
              {event.summary}
            </button>
          )
        })}
      </div>
    </div>
  )
}
