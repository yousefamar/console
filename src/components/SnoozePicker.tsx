import { useEffect, useRef, useMemo } from 'react'
import { useUiStore } from '@/store/ui'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { getSnoozeTime } from '@/utils/date'
// `SnoozeOption` is also the local option-row component's name.
import { applySnooze, type SnoozeOption as SnoozeChoice } from '@/inbox/snooze'
import { DateTimePicker } from './DateTimePicker'

/** Rendered only while `ui.snoozeTarget` is set — one picker for every
 *  source (mail, chat, feed item, agent session) and both the legacy panes
 *  and the unified Inbox; `applySnooze` routes the choice. */
export function SnoozePicker() {
  const target = useUiStore((s) => s.snoozeTarget)
  const closeSnoozePicker = useUiStore((s) => s.closeSnoozePicker)
  const isMobile = useIsMobile()
  const dateInputRef = useRef<HTMLInputElement>(null)
  const laterTodayLabel = useMemo(() => getLaterTodayLabel(), [])

  function snooze(option: SnoozeChoice, customDate?: Date) {
    if (target) applySnooze(target, option, customDate)
    else closeSnoozePicker()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const option = e.key === '1' ? 'laterToday' : e.key === '2' ? 'tomorrow' : e.key === '3' ? 'nextWeek' : null
      if (!option) return
      e.preventDefault()
      e.stopPropagation()
      snooze(option)
    }
    // Capture phase: the pane keybindings listen on window too.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={closeSnoozePicker}
      />

      {/* Hidden native picker for mobile */}
      {isMobile && (
        <input
          ref={dateInputRef}
          type="datetime-local"
          className="fixed opacity-0 pointer-events-none"
          onChange={(e) => {
            if (e.target.value) snooze('custom', new Date(e.target.value))
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
            onClick={() => snooze('laterToday')}
          />
          <SnoozeOption
            label="Tomorrow"
            shortcut="2"
            description="8:00 AM"
            onClick={() => snooze('tomorrow')}
          />
          <SnoozeOption
            label="Next week"
            shortcut="3"
            description="Mon, 8:00 AM"
            onClick={() => snooze('nextWeek')}
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
              <DateTimePicker onSelect={(d) => snooze('custom', d)} />
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
