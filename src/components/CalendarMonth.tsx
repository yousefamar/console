import { useMemo, useRef } from 'react'
import { useCalendarStore } from '@/store/calendar'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { usePullToRefresh } from '@/hooks/usePullToRefresh'
import { ChevronLeft, ChevronRight, Plus, Bell, Square } from 'lucide-react'
import { CalendarMobileControls } from './CalendarMobileControls'

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

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

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 6 rows of 7 days each, anchored to the Monday-start week containing the 1st of currentDate's month. */
function buildMonthWeeks(currentDate: Date): Date[][] {
  const firstOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1)
  let startDow = firstOfMonth.getDay() - 1
  if (startDow < 0) startDow = 6
  const weeks: Date[][] = []
  for (let r = 0; r < 6; r++) {
    const row: Date[] = []
    for (let c = 0; c < 7; c++) {
      const offset = r * 7 + c - startDow
      row.push(new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth(), 1 + offset))
    }
    weeks.push(row)
  }
  return weeks
}

interface CellEvent {
  id: string
  calendarId: string
  accountEmail: string
  summary: string
  startTime: Date
  endTime: Date
  color: string
  colors: string[]
  isAllDay: boolean
  isTask: boolean
  isOwn: boolean
  accepted: boolean
  hasReminder: boolean
  spanStart: string  // YYYY-MM-DD inclusive
  spanEnd: string    // YYYY-MM-DD exclusive
}

interface RowSpan {
  event: CellEvent
  startCol: number
  span: number
  lane: number
}

const MAX_LANES_DESKTOP = 4
const MAX_LANES_MOBILE = 6
const LANE_HEIGHT_DESKTOP = 18
const LANE_HEIGHT_MOBILE = 5
const LANE_GAP_DESKTOP = 2
const LANE_GAP_MOBILE = 1
const CELL_HEADER_HEIGHT = 22

export function CalendarMonth() {
  const events = useCalendarStore((s) => s.events)
  const calendars = useCalendarStore((s) => s.calendars)
  const currentDate = useCalendarStore((s) => s.currentDate)
  const navigateMonth = useCalendarStore((s) => s.navigateMonth)
  const navigateToDate = useCalendarStore((s) => s.navigateToDate)
  const setView = useCalendarStore((s) => s.setView)
  const selectEvent = useCalendarStore((s) => s.selectEvent)
  const selectedEventId = useCalendarStore((s) => s.selectedEventId)
  const openCreateForm = useCalendarStore((s) => s.openCreateForm)
  const accounts = useCalendarStore((s) => s.accounts)

  const ownCalendarIds = useMemo(() => new Set(accounts.map((a) => a.email)), [accounts])
  const isMobile = useIsMobile()
  const MAX_LANES = isMobile ? MAX_LANES_MOBILE : MAX_LANES_DESKTOP
  const LANE_HEIGHT = isMobile ? LANE_HEIGHT_MOBILE : LANE_HEIGHT_DESKTOP
  const LANE_GAP = isMobile ? LANE_GAP_MOBILE : LANE_GAP_DESKTOP
  const gridRef = useRef<HTMLDivElement>(null)

  usePullToRefresh(gridRef, () => useCalendarStore.getState().refreshAll(), isMobile)

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

  const weeks = useMemo(() => buildMonthWeeks(currentDate), [currentDate])
  const monthIdx = currentDate.getMonth()
  const today = new Date()

  // Normalize + dedupe events (merge duplicates across calendars)
  const cellEvents = useMemo<CellEvent[]>(() => {
    const merged = new Map<string, CellEvent>()
    for (const e of events) {
      if (e.eventType === 'workingLocation') continue
      const isAllDay = !!e.start.date && !e.start.dateTime
      const startTime = new Date(isAllDay ? e.start.date! : e.start.dateTime!)
      const endTime = new Date(isAllDay ? (e.end.date || e.start.date!) : e.end.dateTime!)
      const color = calColorMap.get(e.calendarId) || '#3b82f6'
      const spanStart = isAllDay ? e.start.date! : localDateStr(startTime)
      const spanEnd = isAllDay
        ? (e.end.date || e.start.date!)
        : localDateStr(new Date(endTime.getFullYear(), endTime.getMonth(), endTime.getDate() + 1))

      const key = `${startTime.getTime()}_${endTime.getTime()}_${e.summary}`
      const ev: CellEvent = {
        id: e.id,
        calendarId: e.calendarId,
        accountEmail: e.accountEmail,
        summary: e.summary,
        startTime,
        endTime,
        color,
        colors: [color],
        isAllDay,
        isTask: !!e.description?.includes('tasks.google.com/task/'),
        isOwn: ownCalendarIds.has(e.calendarId),
        accepted: !e.attendees || e.organizer?.self || e.attendees.find((a) => a.self)?.responseStatus === 'accepted',
        hasReminder: e.reminders
          ? (e.reminders.useDefault ? !!calHasDefaultReminders.get(e.calendarId) : !!e.reminders.overrides?.length)
          : !!calHasDefaultReminders.get(e.calendarId),
        spanStart,
        spanEnd,
      }
      const existing = merged.get(key)
      if (existing && existing.calendarId !== ev.calendarId) {
        if (!existing.colors.includes(ev.color)) existing.colors.push(ev.color)
        if (ev.isOwn && !existing.isOwn) {
          existing.id = ev.id
          existing.calendarId = ev.calendarId
          existing.accountEmail = ev.accountEmail
          existing.color = ev.color
          existing.isOwn = true
        }
        if (ev.accepted) existing.accepted = true
      } else if (!existing) {
        merged.set(key, ev)
      }
    }
    return Array.from(merged.values())
  }, [events, calColorMap, ownCalendarIds, calHasDefaultReminders])

  // Per-row layout: assigns lanes to multi-day spans and single-day pills.
  // Lane assignment is shared within a row so they don't visually overlap.
  const rowLayouts = useMemo(() => {
    return weeks.map((weekDays) => {
      const rowDayStrs = weekDays.map(localDateStr)
      const lanes: Set<number>[] = Array.from({ length: 7 }, () => new Set<number>())
      const overflow = Array.from({ length: 7 }, () => 0)
      const spans: RowSpan[] = []
      const cellPills: Array<Array<{ event: CellEvent; lane: number }>> = Array.from({ length: 7 }, () => [])

      const firstStr = rowDayStrs[0]!
      // Day-after-last for exclusive comparison
      const afterLast = localDateStr(new Date(weekDays[6]!.getFullYear(), weekDays[6]!.getMonth(), weekDays[6]!.getDate() + 1))

      // Multi-day all-day spans visible in this row
      const multiDay = cellEvents.filter((ev) => {
        if (!ev.isAllDay) return false
        if (ev.spanEnd <= firstStr || ev.spanStart >= afterLast) return false
        const a = new Date(ev.spanStart + 'T00:00')
        const b = new Date(ev.spanEnd + 'T00:00')
        const dayCount = Math.round((b.getTime() - a.getTime()) / 86400000)
        return dayCount > 1
      })
      multiDay.sort((a, b) => {
        if (a.spanStart !== b.spanStart) return a.spanStart < b.spanStart ? -1 : 1
        const aLen = new Date(a.spanEnd).getTime() - new Date(a.spanStart).getTime()
        const bLen = new Date(b.spanEnd).getTime() - new Date(b.spanStart).getTime()
        return bLen - aLen
      })

      for (const ev of multiDay) {
        // Clamp to this row
        let startCol = 0
        while (startCol < 7 && rowDayStrs[startCol]! < ev.spanStart) startCol++
        let endCol = 0
        while (endCol < 7 && rowDayStrs[endCol]! < ev.spanEnd) endCol++
        if (endCol === 0) endCol = 7  // span extends past the row
        if (startCol >= endCol) continue
        const span = endCol - startCol

        let lane = 0
        while (true) {
          let conflict = false
          for (let c = startCol; c < endCol; c++) {
            if (lanes[c]!.has(lane)) { conflict = true; break }
          }
          if (!conflict) break
          lane++
        }
        if (lane >= MAX_LANES) {
          for (let c = startCol; c < endCol; c++) overflow[c]!++
        } else {
          for (let c = startCol; c < endCol; c++) lanes[c]!.add(lane)
          spans.push({ event: ev, startCol, span, lane })
        }
      }

      // Single-day events (timed or 1-day all-day) for each column
      for (let col = 0; col < 7; col++) {
        const dayStr = rowDayStrs[col]!
        const singleDay = cellEvents
          .filter((ev) => {
            const dayLen = (() => {
              const a = new Date(ev.spanStart + 'T00:00')
              const b = new Date(ev.spanEnd + 'T00:00')
              return Math.round((b.getTime() - a.getTime()) / 86400000)
            })()
            if (ev.isAllDay && dayLen > 1) return false
            if (ev.isAllDay) return ev.spanStart === dayStr
            return localDateStr(ev.startTime) === dayStr
          })
          .sort((a, b) => {
            if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1
            return a.startTime.getTime() - b.startTime.getTime()
          })

        for (const ev of singleDay) {
          let lane = 0
          while (lanes[col]!.has(lane)) lane++
          if (lane >= MAX_LANES) {
            overflow[col]!++
          } else {
            lanes[col]!.add(lane)
            cellPills[col]!.push({ event: ev, lane })
          }
        }
      }

      return { spans, cellPills, overflow }
    })
  }, [cellEvents, weeks])

  const headerLabel = `${currentDate.toLocaleDateString(undefined, { month: 'long' })} ${currentDate.getFullYear()}`

  const handleCellClick = (day: Date) => {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0)
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10, 0)
    openCreateForm(start, end)
  }

  const handleMoreClick = (day: Date) => {
    setView('day')
    navigateToDate(day)
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 select-none">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border flex-shrink-0">
        <button onClick={() => navigateMonth(-1)} className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5">
          <ChevronLeft size={14} />
        </button>
        <button onClick={() => navigateMonth(1)} className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5">
          <ChevronRight size={14} />
        </button>
        <span className="text-sm font-medium text-text-primary truncate">{headerLabel}</span>
        <div className="flex-1" />
        {isMobile && <CalendarMobileControls />}
        <button
          onClick={() => openCreateForm()}
          className="flex items-center gap-1 px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary bg-surface-2 border border-border rounded-sm transition-colors"
        >
          <Plus size={11} />
          {!isMobile && 'Event'}
        </button>
      </div>

      {/* Day-name header */}
      <div className="grid grid-cols-7 border-b border-border flex-shrink-0">
        {DAY_NAMES.map((name, i) => (
          <div
            key={name}
            className={`text-center text-[10px] text-text-tertiary uppercase py-1 ${i === 0 ? '' : 'border-l border-border'}`}
          >
            {isMobile ? name[0] : name}
          </div>
        ))}
      </div>

      {/* 6 week rows */}
      <div ref={gridRef} className="flex-1 flex flex-col overflow-y-auto">
        {weeks.map((weekDays, rowIdx) => {
          const rowLayout = rowLayouts[rowIdx]!
          return (
            <div
              key={rowIdx}
              className={`relative flex-1 grid grid-cols-7 ${rowIdx === 0 ? '' : 'border-t border-border'}`}
              style={{ minHeight: isMobile ? 70 : 110 }}
            >
              {/* Day cells */}
              {weekDays.map((day, colIdx) => {
                const isToday = isSameDay(day, today)
                const inMonth = day.getMonth() === monthIdx
                const pills = rowLayout.cellPills[colIdx]!
                const cellOverflow = rowLayout.overflow[colIdx]!
                return (
                  <div
                    key={colIdx}
                    onClick={() => handleCellClick(day)}
                    className={`relative ${colIdx === 0 ? '' : 'border-l border-border'} ${
                      isToday ? 'bg-accent/5' : ''
                    } cursor-pointer hover:bg-surface-1/40 transition-colors overflow-hidden`}
                  >
                    {/* Day number */}
                    <div className="flex items-center justify-end px-1.5 pt-1" style={{ height: CELL_HEADER_HEIGHT }}>
                      <span
                        className={`text-[11px] ${
                          isToday
                            ? 'inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent text-white font-medium'
                            : inMonth
                              ? 'text-text-secondary'
                              : 'text-text-tertiary/50'
                        }`}
                      >
                        {day.getDate()}
                      </span>
                    </div>

                    {/* Single-day pills */}
                    {pills.map(({ event, lane }) => {
                      const muted = muteColor(event.color)
                      const hasMultipleColors = event.colors.length > 1
                      const unaccepted = !event.accepted
                      return (
                        <button
                          key={event.id}
                          onClick={(e) => { e.stopPropagation(); selectEvent(event.id) }}
                          className={`absolute left-1 right-1 rounded-sm overflow-hidden text-left px-1 ${
                            unaccepted ? 'border border-dashed' : hasMultipleColors ? 'border border-black/30' : 'border-l-2 border border-black/30'
                          } ${selectedEventId === event.id ? 'ring-1 ring-white/30 brightness-125' : 'hover:brightness-125'}`}
                          style={{
                            top: CELL_HEADER_HEIGHT + lane * (LANE_HEIGHT + LANE_GAP),
                            height: LANE_HEIGHT,
                            backgroundColor: unaccepted ? 'transparent' : muted.bg,
                            borderTopColor: unaccepted ? muted.border : undefined,
                            borderRightColor: unaccepted ? muted.border : undefined,
                            borderBottomColor: unaccepted ? muted.border : undefined,
                            borderLeftColor: muted.border,
                          }}
                        >
                          {!isMobile && (
                            <div className="flex items-center gap-1 leading-[16px]" style={{ color: muted.text }}>
                              {event.isTask && <Square size={8} className="flex-shrink-0 opacity-70" strokeWidth={2.5} />}
                              {event.hasReminder && <Bell size={8} className="flex-shrink-0 opacity-70" />}
                              {!event.isAllDay && (
                                <span className="text-[10px] tabular-nums opacity-80 flex-shrink-0">
                                  {formatTime(event.startTime)}
                                </span>
                              )}
                              <span className="text-[10px] truncate">{event.summary}</span>
                            </div>
                          )}
                        </button>
                      )
                    })}

                    {/* Overflow link */}
                    {cellOverflow > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleMoreClick(day) }}
                        className="absolute left-1 right-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors text-left px-1"
                        style={{ top: CELL_HEADER_HEIGHT + MAX_LANES * (LANE_HEIGHT + LANE_GAP) }}
                      >
                        {isMobile ? `+${cellOverflow}` : `+${cellOverflow} more`}
                      </button>
                    )}
                  </div>
                )
              })}

              {/* Multi-day spanning bars — percentage-positioned over the row */}
              {rowLayout.spans.map((s, i) => {
                const ev = s.event
                const muted = muteColor(ev.color)
                const unaccepted = !ev.accepted
                return (
                  <button
                    key={`${ev.id}-${i}`}
                    onClick={(e) => { e.stopPropagation(); selectEvent(ev.id) }}
                    className={`absolute rounded-sm overflow-hidden text-left px-1.5 ${
                      unaccepted ? 'border border-dashed' : 'border-l-2 border border-black/30'
                    } ${selectedEventId === ev.id ? 'ring-1 ring-white/30 brightness-125' : 'hover:brightness-125'}`}
                    style={{
                      left: `calc(${(s.startCol / 7) * 100}% + 4px)`,
                      width: `calc(${(s.span / 7) * 100}% - 8px)`,
                      top: CELL_HEADER_HEIGHT + s.lane * (LANE_HEIGHT + LANE_GAP),
                      height: LANE_HEIGHT,
                      backgroundColor: unaccepted ? 'transparent' : muted.bg,
                      borderTopColor: unaccepted ? muted.border : undefined,
                      borderRightColor: unaccepted ? muted.border : undefined,
                      borderBottomColor: unaccepted ? muted.border : undefined,
                      borderLeftColor: muted.border,
                      color: muted.text,
                      lineHeight: `${LANE_HEIGHT}px`,
                      zIndex: 5,
                    }}
                  >
                    {!isMobile && <span className="text-[10px] truncate block">{ev.summary}</span>}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
