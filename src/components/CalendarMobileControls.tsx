import { useCalendarStore } from '@/store/calendar'

/**
 * View switcher + Today button for the calendar header. Shown on mobile only —
 * desktop has these controls in the sidebar, which is hidden at phone widths.
 */
export function CalendarMobileControls() {
  const view = useCalendarStore((s) => s.view)
  const setView = useCalendarStore((s) => s.setView)
  const navigateToday = useCalendarStore((s) => s.navigateToday)

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
    </div>
  )
}
