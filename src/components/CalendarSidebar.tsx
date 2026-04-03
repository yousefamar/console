import { useMemo } from 'react'
import { useCalendarStore } from '@/store/calendar'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export function CalendarSidebar() {
  const currentDate = useCalendarStore((s) => s.currentDate)
  const view = useCalendarStore((s) => s.view)
  const calendars = useCalendarStore((s) => s.calendars)
  const visibleCalendarIds = useCalendarStore((s) => s.visibleCalendarIds)
  const navigateToday = useCalendarStore((s) => s.navigateToday)
  const navigateToDate = useCalendarStore((s) => s.navigateToDate)
  const setView = useCalendarStore((s) => s.setView)
  const toggleCalendarVisibility = useCalendarStore((s) => s.toggleCalendarVisibility)

  return (
    <div className="py-2 px-2 space-y-3">
      {/* Today button + view toggle */}
      <div className="flex items-center gap-1">
        <button
          onClick={navigateToday}
          className="px-2 py-0.5 text-[10px] font-medium bg-surface-2 text-text-primary rounded-sm border border-border hover:bg-surface-1 transition-colors"
        >
          Today
        </button>
        <div className="flex-1" />
        <button
          onClick={() => setView('week')}
          className={`px-1.5 py-0.5 text-[10px] rounded-sm transition-colors ${
            view === 'week' ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          W
        </button>
        <button
          onClick={() => setView('day')}
          className={`px-1.5 py-0.5 text-[10px] rounded-sm transition-colors ${
            view === 'day' ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          D
        </button>
      </div>

      {/* Mini month picker */}
      <MiniMonth currentDate={currentDate} onSelectDate={navigateToDate} />

      {/* Calendar list */}
      <div>
        <div className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider px-1 mb-1">
          Calendars
        </div>
        {calendars.map((cal) => (
          <label
            key={cal.id}
            className="flex items-center gap-1.5 px-1 py-0.5 cursor-pointer hover:bg-surface-1 rounded-sm transition-colors"
          >
            <input
              type="checkbox"
              checked={visibleCalendarIds.has(cal.id)}
              onChange={() => toggleCalendarVisibility(cal.id)}
              className="sr-only"
            />
            <span
              className="w-2.5 h-2.5 rounded-sm flex-shrink-0 border"
              style={{
                backgroundColor: visibleCalendarIds.has(cal.id) ? cal.backgroundColor : 'transparent',
                borderColor: cal.backgroundColor,
              }}
            />
            <span className="text-xs text-text-secondary truncate">
              {cal.summary}
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// Mini month calendar
// --------------------------------------------------------------------------

function MiniMonth({ currentDate, onSelectDate }: {
  currentDate: Date
  onSelectDate: (d: Date) => void
}) {
  const { month, year, weeks, prevMonth, nextMonth } = useMiniMonth(currentDate)

  const today = new Date()
  const todayStr = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`
  const selectedStr = `${currentDate.getFullYear()}-${currentDate.getMonth()}-${currentDate.getDate()}`

  return (
    <div>
      <div className="flex items-center justify-between px-1 mb-1">
        <button
          onClick={() => onSelectDate(prevMonth)}
          className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5"
        >
          <ChevronLeft size={12} />
        </button>
        <span className="text-xs text-text-primary font-medium">
          {month} {year}
        </span>
        <button
          onClick={() => onSelectDate(nextMonth)}
          className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5"
        >
          <ChevronRight size={12} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0">
        {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => (
          <div key={d} className="text-center text-[9px] text-text-tertiary py-0.5">
            {d}
          </div>
        ))}
        {weeks.flat().map((day, i) => {
          const dayStr = `${day.year}-${day.month}-${day.day}`
          const isToday = dayStr === todayStr
          const isSelected = dayStr === selectedStr
          const isCurrentMonth = day.month === currentDate.getMonth()

          return (
            <button
              key={i}
              onClick={() => onSelectDate(new Date(day.year, day.month, day.day))}
              className={`text-center text-[10px] py-0.5 rounded-sm transition-colors ${
                isSelected
                  ? 'bg-accent text-white'
                  : isToday
                    ? 'bg-surface-2 text-text-primary font-medium'
                    : isCurrentMonth
                      ? 'text-text-secondary hover:bg-surface-1'
                      : 'text-text-tertiary hover:bg-surface-1'
              }`}
            >
              {day.day}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function useMiniMonth(currentDate: Date) {
  return useMemo(() => {
    const year = currentDate.getFullYear()
    const monthIdx = currentDate.getMonth()
    const month = currentDate.toLocaleString('default', { month: 'long' })

    const firstDay = new Date(year, monthIdx, 1)
    const lastDay = new Date(year, monthIdx + 1, 0)

    // Monday-start: 0=Mon, 6=Sun
    let startDow = firstDay.getDay() - 1
    if (startDow < 0) startDow = 6

    const days: Array<{ day: number; month: number; year: number }> = []

    // Fill previous month days
    for (let i = startDow - 1; i >= 0; i--) {
      const d = new Date(year, monthIdx, -i)
      days.push({ day: d.getDate(), month: d.getMonth(), year: d.getFullYear() })
    }

    // Current month days
    for (let d = 1; d <= lastDay.getDate(); d++) {
      days.push({ day: d, month: monthIdx, year })
    }

    // Fill remaining to complete 6 rows
    while (days.length < 42) {
      const d = new Date(year, monthIdx + 1, days.length - lastDay.getDate() - startDow + 1)
      days.push({ day: d.getDate(), month: d.getMonth(), year: d.getFullYear() })
    }

    // Split into weeks
    const weeks: typeof days[] = []
    for (let i = 0; i < days.length; i += 7) {
      weeks.push(days.slice(i, i + 7))
    }

    const prevMonth = new Date(year, monthIdx - 1, 1)
    const nextMonth = new Date(year, monthIdx + 1, 1)

    return { month, year, weeks, prevMonth, nextMonth }
  }, [currentDate.getFullYear(), currentDate.getMonth()])
}
