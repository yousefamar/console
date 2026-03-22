import { useRef, useMemo } from 'react'
import { useInboxStore } from '@/store/inbox'
import { useUiStore } from '@/store/ui'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { getSnoozeTime } from '@/utils/date'
import { DateTimePicker } from './DateTimePicker'

export function SnoozePicker() {
  const snoozeThread = useInboxStore((s) => s.snoozeThread)
  const setShowSnoozePicker = useUiStore((s) => s.setShowSnoozePicker)
  const isMobile = useIsMobile()
  const dateInputRef = useRef<HTMLInputElement>(null)
  const laterTodayLabel = useMemo(() => getLaterTodayLabel(), [])

  function handleSnooze(option: 'laterToday' | 'tomorrow' | 'nextWeek') {
    snoozeThread(option)
    setShowSnoozePicker(false)
  }

  function handleCustom(date: Date) {
    snoozeThread('custom', date)
    setShowSnoozePicker(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={() => setShowSnoozePicker(false)}
      />

      {/* Hidden native picker for mobile */}
      {isMobile && (
        <input
          ref={dateInputRef}
          type="datetime-local"
          className="fixed opacity-0 pointer-events-none"
          onChange={(e) => {
            if (e.target.value) handleCustom(new Date(e.target.value))
          }}
        />
      )}

      {/* Modal */}
      <div className="relative z-10 w-full md:w-72 rounded-t-md md:rounded-sm border border-border bg-surface-1 shadow-lg animate-slide-up">
        <div className="border-b border-border px-4 py-2">
          <h3 className="text-sm font-medium text-text-primary">Snooze until</h3>
        </div>

        <div className="py-1">
          <SnoozeOption
            label="Later today"
            shortcut="1"
            description={laterTodayLabel}
            onClick={() => handleSnooze('laterToday')}
          />
          <SnoozeOption
            label="Tomorrow"
            shortcut="2"
            description="8:00 AM"
            onClick={() => handleSnooze('tomorrow')}
          />
          <SnoozeOption
            label="Next week"
            shortcut="3"
            description="Mon, 8:00 AM"
            onClick={() => handleSnooze('nextWeek')}
          />

          <div className="mx-3 my-1 border-t border-border" />

          {isMobile ? (
            <button
              onClick={() => dateInputRef.current?.showPicker()}
              className="flex w-full items-center px-4 py-3 text-sm text-text-secondary hover:bg-surface-2 active:bg-surface-2 transition-colors duration-fast"
            >
              Pick date & time
            </button>
          ) : (
            <div className="px-4 py-2">
              <DateTimePicker onSelect={handleCustom} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SnoozeOption({
  label,
  shortcut,
  description,
  onClick,
}: {
  label: string
  shortcut: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between px-4 py-3 md:py-1.5 text-sm hover:bg-surface-2 active:bg-surface-2 transition-colors duration-fast"
    >
      <div className="flex items-center gap-2">
        <span className="w-4 text-center text-xs text-text-tertiary">{shortcut}</span>
        <span className="text-text-primary">{label}</span>
      </div>
      <span className="text-xs text-text-tertiary">{description}</span>
    </button>
  )
}

function getLaterTodayLabel(): string {
  const time = new Date(getSnoozeTime('laterToday'))
  return time.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
