import { Plane } from 'lucide-react'
import { useCalendarStore } from '@/store/calendar'
import { useFlightsStore } from '@/store/flights'

/**
 * View switcher + Today button for the calendar header. Shown on mobile only —
 * desktop has these controls in the sidebar, which is hidden at phone widths.
 */
export function CalendarMobileControls() {
  const view = useCalendarStore((s) => s.view)
  const setView = useCalendarStore((s) => s.setView)
  const navigateToday = useCalendarStore((s) => s.navigateToday)
  const watchlistCount = useFlightsStore((s) => s.watchlists.length)
  const setSheetOpen = useFlightsStore((s) => s.setSheetOpen)

  const btn = (key: 'month' | 'week' | 'day', label: string) => (
    <button
      onClick={() => setView(key)}
      className={`px-1.5 py-0.5 text-[10px] rounded-sm transition-colors ${
        view === key ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={navigateToday}
        className="px-2 py-0.5 text-[10px] font-medium bg-surface-2 text-text-primary rounded-sm border border-border hover:bg-surface-1 transition-colors mr-1"
      >
        Today
      </button>
      {btn('month', 'M')}
      {btn('week', 'W')}
      {btn('day', 'D')}
      <button
        onClick={() => setSheetOpen(true)}
        aria-label="Flight watchlists"
        className="relative ml-1 p-1 text-text-tertiary hover:text-text-secondary transition-colors"
      >
        <Plane size={14} />
        {watchlistCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 text-[8px] font-mono text-accent">
            {watchlistCount}
          </span>
        )}
      </button>
    </div>
  )
}
