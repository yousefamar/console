import { useState, useMemo } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import clsx from 'clsx'

interface DateTimePickerProps {
  onSelect: (date: Date) => void
}

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const HOURS = Array.from({ length: 24 }, (_, i) => i)

export function DateTimePicker({ onSelect }: DateTimePickerProps) {
  const now = new Date()
  const [viewYear, setViewYear] = useState(now.getFullYear())
  const [viewMonth, setViewMonth] = useState(now.getMonth())
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  const [hour, setHour] = useState(8)
  const [minute, setMinute] = useState(0)

  const today = useMemo(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() }
  }, [])

  const { days, blanks } = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1).getDay()
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
    // Monday-based: Mon=0, Tue=1, ..., Sun=6
    const mondayBased = (firstDay + 6) % 7
    return {
      blanks: mondayBased,
      days: Array.from({ length: daysInMonth }, (_, i) => i + 1),
    }
  }, [viewYear, viewMonth])

  const monthLabel = new Date(viewYear, viewMonth).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
  })

  function isPast(day: number): boolean {
    const d = new Date(viewYear, viewMonth, day, 23, 59, 59)
    return d < now
  }

  function prev() {
    if (viewMonth === 0) {
      setViewMonth(11)
      setViewYear(viewYear - 1)
    } else {
      setViewMonth(viewMonth - 1)
    }
    setSelectedDay(null)
  }

  function next() {
    if (viewMonth === 11) {
      setViewMonth(0)
      setViewYear(viewYear + 1)
    } else {
      setViewMonth(viewMonth + 1)
    }
    setSelectedDay(null)
  }

  function handleConfirm() {
    if (selectedDay === null) return
    onSelect(new Date(viewYear, viewMonth, selectedDay, hour, minute))
  }

  return (
    <div>
      {/* Month navigation */}
      <div className="flex items-center justify-between px-1 pb-2">
        <button
          onClick={prev}
          className="p-0.5 text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="text-xs font-medium text-text-primary">{monthLabel}</span>
        <button
          onClick={next}
          className="p-0.5 text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-0">
        {DAYS.map((d) => (
          <div key={d} className="py-1 text-center text-[10px] text-text-tertiary">
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-0">
        {Array.from({ length: blanks }).map((_, i) => (
          <div key={`b${i}`} />
        ))}
        {days.map((day) => {
          const isToday =
            viewYear === today.year && viewMonth === today.month && day === today.day
          const isSelected = day === selectedDay
          const past = isPast(day)

          return (
            <button
              key={day}
              disabled={past}
              onClick={() => setSelectedDay(day)}
              className={clsx(
                'mx-auto flex h-7 w-7 items-center justify-center text-xs transition-colors duration-fast',
                past && 'text-text-tertiary opacity-40 cursor-default',
                !past && !isSelected && 'text-text-secondary hover:bg-surface-2',
                isSelected && 'bg-accent text-text-inverse',
                isToday && !isSelected && 'font-semibold text-accent',
              )}
            >
              {day}
            </button>
          )
        })}
      </div>

      {/* Time selector */}
      <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
        <select
          value={hour}
          onChange={(e) => setHour(Number(e.target.value))}
          className="flex-1 rounded-sm border border-border bg-surface-0 px-1.5 py-1 text-xs text-text-primary"
        >
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, '0')}
            </option>
          ))}
        </select>
        <span className="text-xs text-text-tertiary">:</span>
        <select
          value={minute}
          onChange={(e) => setMinute(Number(e.target.value))}
          className="w-16 rounded-sm border border-border bg-surface-0 px-1.5 py-1 text-xs text-text-primary"
        >
          {[0, 15, 30, 45].map((m) => (
            <option key={m} value={m}>
              {String(m).padStart(2, '0')}
            </option>
          ))}
        </select>
      </div>

      {/* Confirm */}
      <button
        onClick={handleConfirm}
        disabled={selectedDay === null}
        className="mt-2 w-full rounded-sm bg-accent px-3 py-1 text-xs font-medium text-text-inverse transition-colors duration-fast hover:bg-accent-hover disabled:opacity-40"
      >
        Snooze
      </button>
    </div>
  )
}
