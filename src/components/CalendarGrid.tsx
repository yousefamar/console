import { useMemo, useCallback, useState, useRef, useEffect } from 'react'
import { useCalendarStore } from '@/store/calendar'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'

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
  const mix = (c: number) => Math.round(c * 0.3 + 20)
  const br = (c: number) => Math.round(c * 0.7 + 60)
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

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
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
  summary: string
  startTime: Date
  endTime: Date
  allDay: boolean
  color: string
  top: number
  height: number
  left: number
  width: number
  column: number
  hangoutLink?: string
  location?: string
}

type DragMode = 'create' | 'move' | 'resize'

interface DragState {
  mode: DragMode
  dayIdx: number
  startY: number       // px position where drag started (grid-relative)
  currentY: number     // current px position
  eventId?: string     // for move/resize
  eventOrigTop?: number
  eventOrigHeight?: number
  offsetY?: number     // mouse offset from event top (for move)
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

  const [drag, setDrag] = useState<DragState | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const colRefs = useRef<(HTMLDivElement | null)[]>([])

  const calColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of calendars) map.set(c.id, c.backgroundColor)
    return map
  }, [calendars])

  const days = useMemo(() => {
    if (view === 'day') return [currentDate]
    const start = weekStart(currentDate)
    return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  }, [currentDate, view])

  const today = new Date()

  const { allDayEvents, timedEvents } = useMemo(() => {
    const allDay: typeof events = []
    const timed: typeof events = []
    for (const e of events) {
      if (e.start.date && !e.start.dateTime) allDay.push(e)
      else timed.push(e)
    }
    return { allDayEvents: allDay, timedEvents: timed }
  }, [events])

  const positionedEvents = useMemo(() => {
    const positioned: PositionedEvent[] = []

    for (let colIdx = 0; colIdx < days.length; colIdx++) {
      const day = days[colIdx]!
      const dayEvents = timedEvents
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
          return {
            id: e.id, calendarId: e.calendarId, summary: e.summary,
            startTime: start, endTime: end, allDay: false,
            color: calColorMap.get(e.calendarId) || '#3b82f6',
            top: (startMinutes / 60) * HOUR_HEIGHT,
            height: (duration / 60) * HOUR_HEIGHT,
            left: 0, width: 1, column: colIdx,
            hangoutLink: e.hangoutLink, location: e.location,
          }
        })
        .sort((a, b) => a.top - b.top || b.height - a.height)

      const groups: PositionedEvent[][] = []
      for (const ev of dayEvents) {
        let placed = false
        for (const group of groups) {
          if (group.some((g) => ev.top < g.top + g.height && ev.top + ev.height > g.top)) {
            group.push(ev); placed = true; break
          }
        }
        if (!placed) groups.push([ev])
      }

      for (const group of groups) {
        const n = group.length
        for (let i = 0; i < n; i++) {
          group[i]!.left = i / n
          group[i]!.width = 1 / n
        }
        positioned.push(...group)
      }
    }
    return positioned
  }, [timedEvents, days, calColorMap])

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
    setDrag({ mode: 'create', dayIdx, startY: snapped, currentY: snapped })
    e.preventDefault()
  }, [])

  // --- Drag-to-move: mousedown on event ---
  const handleEventMouseDown = useCallback((e: React.MouseEvent, ev: PositionedEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const col = colRefs.current[ev.column]
    if (!col) return
    const rect = col.getBoundingClientRect()
    const y = e.clientY - rect.top
    setDrag({
      mode: 'move', dayIdx: ev.column,
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
      mode: 'resize', dayIdx: ev.column,
      startY: y, currentY: y,
      eventId: ev.id, eventOrigTop: ev.top, eventOrigHeight: ev.height,
    })
    e.preventDefault()
  }, [])

  // --- Global mousemove/mouseup for drag ---
  useEffect(() => {
    if (!drag) return

    const handleMouseMove = (e: MouseEvent) => {
      const col = colRefs.current[drag.dayIdx]
      if (!col) return
      const rect = col.getBoundingClientRect()
      const y = e.clientY - rect.top
      setDrag((d) => d ? { ...d, currentY: y } : null)
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
          // Too small — treat as click, create 1-hour event
          const minutes = pxToMinutes(snapToGrid(d.startY))
          const day = days[d.dayIdx]!
          const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes)
          const end = new Date(start.getTime() + 3600000)
          openCreateForm(start, end)
        } else {
          const startMin = pxToMinutes(snapToGrid(topPx))
          const endMin = pxToMinutes(snapToGrid(bottomPx))
          const day = days[d.dayIdx]!
          const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, startMin)
          const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, endMin)
          openCreateForm(start, end)
        }
      } else if (d.mode === 'move' && d.eventId) {
        const newTop = snapToGrid(d.eventOrigTop! + (d.currentY - d.startY))
        const startMin = pxToMinutes(Math.max(0, newTop))
        const endMin = startMin + pxToMinutes(d.eventOrigHeight!)
        const day = days[d.dayIdx]!
        const ev = events.find((e) => e.id === d.eventId)
        if (ev) {
          const newStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, startMin)
          const newEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, endMin)
          updateEvent(ev.calendarId, ev.id, {
            start: { dateTime: newStart.toISOString() },
            end: { dateTime: newEnd.toISOString() },
          })
        }
      } else if (d.mode === 'resize' && d.eventId) {
        const newHeight = snapToGrid(d.eventOrigHeight! + (d.currentY - d.startY))
        const endMin = pxToMinutes(d.eventOrigTop!) + pxToMinutes(Math.max(SNAP_PX, newHeight))
        const day = days[d.dayIdx]!
        const ev = events.find((e) => e.id === d.eventId)
        if (ev) {
          const newEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, endMin)
          updateEvent(ev.calendarId, ev.id, {
            end: { dateTime: newEnd.toISOString() },
          })
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

      {/* Day headers */}
      <div className="flex border-b border-border flex-shrink-0">
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

      {/* All-day events bar */}
      {allDayEvents.length > 0 && (
        <div className="flex border-b border-border flex-shrink-0 min-h-6">
          <div className="w-12 flex-shrink-0 text-[9px] text-text-tertiary text-right pr-1 pt-0.5">all-day</div>
          {days.map((day, dayIdx) => {
            const dayStr = day.toISOString().split('T')[0]
            const dayAllDay = allDayEvents.filter((e) => dayStr! >= e.start.date! && dayStr! < e.end.date!)
            return (
              <div key={dayIdx} className="flex-1 border-l border-border px-0.5 py-0.5 space-y-0.5">
                {dayAllDay.map((e) => {
                  const muted = muteColor(calColorMap.get(e.calendarId) || '#3b82f6')
                  return (
                    <button key={e.id} onClick={() => selectEvent(e.id)}
                      className={`w-full text-left px-1 py-0 text-[10px] rounded-sm truncate transition-colors border-l-2 ${selectedEventId === e.id ? 'ring-1 ring-white/30' : ''}`}
                      style={{ backgroundColor: muted.bg, borderLeftColor: muted.border, color: muted.text }}>
                      {e.summary}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
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

                  return (
                    <div
                      key={ev.id}
                      onMouseDown={(e) => handleEventMouseDown(e, ev)}
                      onClick={(e) => { e.stopPropagation(); if (!drag) selectEvent(ev.id) }}
                      className={`absolute z-10 rounded-sm overflow-hidden text-left cursor-grab border-l-2 ${
                        selectedEventId === ev.id ? 'ring-1 ring-white/30 brightness-125' : 'hover:brightness-125'
                      } ${isDragging ? 'opacity-40' : ''}`}
                      style={{
                        top: ev.top,
                        height: Math.max(ev.height, 18),
                        left: `${ev.left * 100}%`,
                        width: `calc(${ev.width * 100}% - 2px)`,
                        backgroundColor: muted.bg,
                        borderLeftColor: muted.border,
                      }}
                    >
                      <div className="px-1 py-0.5 h-full overflow-hidden">
                        <div className="text-[10px] font-medium truncate leading-tight" style={{ color: muted.text }}>
                          {ev.summary}
                        </div>
                        {ev.height > 30 && (
                          <div className="text-[9px] truncate" style={{ color: muted.text, opacity: 0.7 }}>
                            {formatTime(ev.startTime)} – {formatTime(ev.endTime)}
                          </div>
                        )}
                        {ev.height > 50 && ev.location && (
                          <div className="text-[9px] truncate" style={{ color: muted.text, opacity: 0.5 }}>
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
    </div>
  )
}
