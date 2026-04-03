import { useEffect } from 'react'
import { useCalendarStore } from '@/store/calendar'
import { isSignedIn } from '@/gmail/auth'
import { CalendarSidebar } from './CalendarSidebar'
import { CalendarGrid } from './CalendarGrid'
import { CalendarEventPopover } from './CalendarEventPopover'
import { CalendarEventForm } from './CalendarEventForm'
import { CalendarLocationPicker } from './CalendarLocationPicker'
import { useIsMobile } from '@/hooks/useMediaQuery'

export function CalendarTab() {
  const connected = useCalendarStore((s) => s.connected)
  const loading = useCalendarStore((s) => s.loading)
  const calendars = useCalendarStore((s) => s.calendars)
  const showEventForm = useCalendarStore((s) => s.showEventForm)
  const selectedEventId = useCalendarStore((s) => s.selectedEventId)
  const locationPickerEvent = useCalendarStore((s) => s.locationPickerEvent)
  const isMobile = useIsMobile()

  useEffect(() => {
    if (isSignedIn()) {
      const store = useCalendarStore.getState()
      store.fetchCalendars().then(() => store.fetchEvents())
    }
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
      {/* Sidebar — hidden on mobile */}
      {!isMobile && (
        <div className="w-52 flex-shrink-0 border-r border-border overflow-y-auto">
          <CalendarSidebar />
        </div>
      )}

      {/* Calendar grid */}
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <CalendarGrid />
      </div>

      {/* Event popover */}
      {selectedEventId && <CalendarEventPopover />}

      {/* Event form modal */}
      {showEventForm && <CalendarEventForm />}

      {/* Location picker */}
      {locationPickerEvent && <CalendarLocationPicker />}
    </div>
  )
}
