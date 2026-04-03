import { useMemo, useCallback } from 'react'
import { useCalendarStore } from '@/store/calendar'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const HOUR_HEIGHT = 48 // pixels per hour
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



interface PositionedEvent {
  id: string
  calendarId: string
  summary: string
  startTime: Date
  endTime: Date
  allDay: boolean
  color: string
  top: number       // px from top of time grid
  height: number    // px
  left: number      // 0-1 fraction
  width: number     // 0-1 fraction
  column: number    // day column index
  hangoutLink?: string
  location?: string
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

  // Separate all-day and timed events
  const { allDayEvents, timedEvents } = useMemo(() => {
    const allDay: typeof events = []
    const timed: typeof events = []
    for (const e of events) {
      if (e.start.date && !e.start.dateTime) allDay.push(e)
      else timed.push(e)
    }
    return { allDayEvents: allDay, timedEvents: timed }
  }, [events])

  // Position timed events with overlap handling
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
            id: e.id,
            calendarId: e.calendarId,
            summary: e.summary,
            startTime: start,
            endTime: end,
            allDay: false,
            color: calColorMap.get(e.calendarId) || '#3b82f6',
            top: (startMinutes / 60) * HOUR_HEIGHT,
            height: (duration / 60) * HOUR_HEIGHT,
            left: 0,
            width: 1,
            column: colIdx,
            hangoutLink: e.hangoutLink,
            location: e.location,
          }
        })
        .sort((a, b) => a.top - b.top || b.height - a.height)

      // Overlap layout: assign columns
      const groups: PositionedEvent[][] = []
      for (const ev of dayEvents) {
        let placed = false
        for (const group of groups) {
          const overlaps = group.some((g) => ev.top < g.top + g.height && ev.top + ev.height > g.top)
          if (overlaps) {
            group.push(ev)
            placed = true
            break
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

  // Header date range display
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

  const handleTimeSlotClick = useCallback((dayIdx: number, hour: number) => {
    const day = days[dayIdx]!
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0)
    const end = new Date(start.getTime() + 60 * 60 * 1000)
    openCreateForm(start, end)
  }, [days, openCreateForm])

  // Current time indicator
  const nowMinutes = today.getHours() * 60 + today.getMinutes()
  const nowTop = (nowMinutes / 60) * HOUR_HEIGHT

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border flex-shrink-0">
        <button
          onClick={() => navigateWeek(-1)}
          className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          onClick={() => navigateWeek(1)}
          className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5"
        >
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
        {/* Time gutter */}
        <div className="w-12 flex-shrink-0" />
        {/* Day columns */}
        {days.map((day, i) => {
          const isToday = isSameDay(day, today)
          return (
            <div
              key={i}
              className={`flex-1 text-center py-1 border-l border-border ${
                isToday ? 'bg-accent/5' : ''
              }`}
            >
              <div className="text-[10px] text-text-tertiary uppercase">{DAY_NAMES[day.getDay() === 0 ? 6 : day.getDay() - 1]}</div>
              <div className={`text-sm font-medium ${
                isToday ? 'text-accent' : 'text-text-primary'
              }`}>
                {day.getDate()}
              </div>
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
            const dayAllDay = allDayEvents.filter((e) => {
              const startStr = e.start.date!
              const endStr = e.end.date!
              return dayStr! >= startStr && dayStr! < endStr
            })
            return (
              <div key={dayIdx} className="flex-1 border-l border-border px-0.5 py-0.5 space-y-0.5">
                {dayAllDay.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => selectEvent(e.id)}
                    className={`w-full text-left px-1 py-0 text-[10px] rounded-sm truncate transition-colors ${
                      selectedEventId === e.id ? 'ring-1 ring-accent' : ''
                    }`}
                    style={{
                      backgroundColor: calColorMap.get(e.calendarId) || '#3b82f6',
                      color: '#fff',
                    }}
                  >
                    {e.summary}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      )}

      {/* Time grid */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden relative">
        <div className="flex" style={{ minHeight: 24 * HOUR_HEIGHT }}>
          {/* Time labels */}
          <div className="w-12 flex-shrink-0 relative">
            {HOURS.map((h) => (
              <div
                key={h}
                className="absolute right-1 text-[10px] text-text-tertiary"
                style={{ top: h * HOUR_HEIGHT - 6 }}
              >
                {h === 0 ? '' : `${h}:00`}
              </div>
            ))}
          </div>

          {/* Day columns with events */}
          {days.map((day, dayIdx) => {
            const isToday = isSameDay(day, today)
            const dayEvents = positionedEvents.filter((e) => e.column === dayIdx)

            return (
              <div
                key={dayIdx}
                className={`flex-1 relative border-l border-border ${isToday ? 'bg-accent/3' : ''}`}
              >
                {/* Hour gridlines */}
                {HOURS.map((h) => (
                  <div
                    key={h}
                    className="absolute w-full border-t border-border/50 cursor-pointer hover:bg-surface-1/50 transition-colors"
                    style={{ top: h * HOUR_HEIGHT, height: HOUR_HEIGHT }}
                    onClick={() => handleTimeSlotClick(dayIdx, h)}
                  />
                ))}

                {/* Current time indicator */}
                {isToday && (
                  <div
                    className="absolute left-0 right-0 z-20 pointer-events-none"
                    style={{ top: nowTop }}
                  >
                    <div className="flex items-center">
                      <div className="w-2 h-2 rounded-full bg-red-500 -ml-1" />
                      <div className="flex-1 h-px bg-red-500" />
                    </div>
                  </div>
                )}

                {/* Events */}
                {dayEvents.map((ev) => (
                  <button
                    key={ev.id}
                    onClick={(e) => { e.stopPropagation(); selectEvent(ev.id) }}
                    className={`absolute z-10 rounded-sm overflow-hidden text-left transition-shadow hover:shadow-md cursor-pointer ${
                      selectedEventId === ev.id ? 'ring-1 ring-white/50 shadow-md' : ''
                    }`}
                    style={{
                      top: ev.top,
                      height: Math.max(ev.height, 18),
                      left: `${ev.left * 100}%`,
                      width: `calc(${ev.width * 100}% - 2px)`,
                      backgroundColor: ev.color,
                    }}
                  >
                    <div className="px-1 py-0.5 h-full overflow-hidden">
                      <div className="text-[10px] font-medium text-white truncate leading-tight">
                        {ev.summary}
                      </div>
                      {ev.height > 30 && (
                        <div className="text-[9px] text-white/75 truncate">
                          {formatTime(ev.startTime)} – {formatTime(ev.endTime)}
                        </div>
                      )}
                      {ev.height > 50 && ev.location && (
                        <div className="text-[9px] text-white/60 truncate">
                          {ev.location}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
