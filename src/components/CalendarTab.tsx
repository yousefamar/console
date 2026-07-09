import { memo, useEffect } from 'react'
import { useCalendarStore } from '@/store/calendar'
import { isSignedIn } from '@/gmail/auth'
import { CalendarSidebar } from './CalendarSidebar'
import { CalendarGrid } from './CalendarGrid'
import { CalendarMonth } from './CalendarMonth'
import { CalendarEventPopover } from './CalendarEventPopover'
import { CalendarEventForm } from './CalendarEventForm'
import { CalendarLocationPicker } from './CalendarLocationPicker'
import { FlightsSheet } from './FlightsSheet'
import { useFlightsStore } from '@/store/flights'
import { useIsMobile } from '@/hooks/useMediaQuery'

export const CalendarTab = memo(function CalendarTab() {
  const connected = useCalendarStore((s) => s.connected)
  const loading = useCalendarStore((s) => s.loading)
  const calendars = useCalendarStore((s) => s.calendars)
  const view = useCalendarStore((s) => s.view)
  const showEventForm = useCalendarStore((s) => s.showEventForm)
  const selectedEventId = useCalendarStore((s) => s.selectedEventId)
  const locationPickerEvent = useCalendarStore((s) => s.locationPickerEvent)
  const isMobile = useIsMobile()

  useEffect(() => {
    // Bounded-retry boot chain. The pane is pre-rendered at app boot, so this
    // effect fires while auth is still hydrating and the hub may be mid-restart
    // — a single failed attempt used to leave the pane stuck on "Loading
    // calendars..." forever (isSignedIn() flips true later but an []-deps
    // effect never re-fires). Retry with backoff until accounts land.
    let cancelled = false
    const delays = [0, 1500, 4000, 10000, 25000]
    void (async () => {
      for (const d of delays) {
        if (d) await new Promise((r) => setTimeout(r, d))
        if (cancelled) return
        if (!isSignedIn()) continue
        const store = useCalendarStore.getState()
        try {
          await store.loadAccounts()
          if (useCalendarStore.getState().accounts.length === 0) continue
          await useCalendarStore.getState().fetchCalendars()
          await useCalendarStore.getState().fetchEvents()
          // Initialise flight watchlists so the mobile button shows a fresh
          // count even before the user opens the sheet. Idempotent.
          void useFlightsStore.getState().init()
          return
        } catch {
          // hub unreachable — next attempt
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (!isSignedIn()) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-4">
        <p className="text-sm text-text-secondary">Sign in with Google to view your calendar</p>
      </div>
    )
  }

  if (!connected && calendars.length === 0 && !loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-4">
        <p className="text-sm text-text-secondary">Loading calendars...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0">
      {!isMobile && (
        <div className="w-52 flex-shrink-0 border-r border-border overflow-y-auto">
          <CalendarSidebar />
        </div>
      )}

      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {view === 'month' ? <CalendarMonth /> : <CalendarGrid />}
      </div>

      {selectedEventId && <CalendarEventPopover />}
      {showEventForm && <CalendarEventForm />}
      {locationPickerEvent && <CalendarLocationPicker />}
      {isMobile && <FlightsSheet />}
    </div>
  )
})
