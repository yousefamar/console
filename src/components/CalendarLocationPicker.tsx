import { useState, useEffect, useMemo, useRef } from 'react'
import { useCalendarStore } from '@/store/calendar'
import { MapPin, Home, Building2, X } from 'lucide-react'

export function CalendarLocationPicker() {
  const event = useCalendarStore((s) => s.locationPickerEvent)
  const events = useCalendarStore((s) => s.events)
  const updateLocation = useCalendarStore((s) => s.updateLocation)
  const closeLocationPicker = useCalendarStore((s) => s.closeLocationPicker)
  const ref = useRef<HTMLDivElement>(null)

  const [customLabel, setCustomLabel] = useState('')
  const [showCustom, setShowCustom] = useState(false)

  // Collect known office locations from existing location events
  const knownOffices = useMemo(() => {
    const offices = new Set<string>()
    for (const e of events) {
      if (e.eventType === 'workingLocation' && e.workingLocationProperties) {
        const props = e.workingLocationProperties
        if (props.type === 'officeLocation' && props.officeLocation?.label) {
          offices.add(props.officeLocation.label)
        }
      }
    }
    return Array.from(offices).sort()
  }, [events])

  // Current location type
  const currentType = event?.workingLocationProperties?.type
  const currentLabel = currentType === 'officeLocation'
    ? event?.workingLocationProperties?.officeLocation?.label
    : currentType === 'customLocation'
      ? event?.workingLocationProperties?.customLocation?.label
      : undefined

  useEffect(() => {
    if (!event) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLocationPicker()
    }
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeLocationPicker()
    }
    window.addEventListener('keydown', handleKey)
    window.addEventListener('mousedown', handleClick)
    return () => {
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('mousedown', handleClick)
    }
  }, [event, closeLocationPicker])

  if (!event) return null

  const dateStr = event.start.date
    ? new Date(event.start.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : ''

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20" onClick={closeLocationPicker}>
      <div
        ref={ref}
        className="bg-surface-0 border border-border rounded-sm shadow-lg w-64 animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <div className="flex items-center gap-1.5">
            <MapPin size={12} className="text-text-tertiary" />
            <span className="text-xs font-medium text-text-primary">Working location</span>
          </div>
          <button onClick={closeLocationPicker} className="text-text-tertiary hover:text-text-secondary">
            <X size={14} />
          </button>
        </div>

        {/* Date */}
        <div className="px-3 py-1.5 text-[10px] text-text-tertiary border-b border-border">
          {dateStr}
        </div>

        {/* Options */}
        <div className="py-1">
          {/* Home */}
          <button
            onClick={() => updateLocation(event.calendarId, event.id, 'homeOffice')}
            className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors ${
              currentType === 'homeOffice' ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-1'
            }`}
          >
            <Home size={12} className="text-text-tertiary" />
            Home
          </button>

          {/* Known offices */}
          {knownOffices.map((office) => (
            <button
              key={office}
              onClick={() => updateLocation(event.calendarId, event.id, 'officeLocation', office)}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors ${
                currentType === 'officeLocation' && currentLabel === office ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-1'
              }`}
            >
              <Building2 size={12} className="text-text-tertiary" />
              {office}
            </button>
          ))}

          {/* If no known offices, show a default "Office" option */}
          {knownOffices.length === 0 && (
            <button
              onClick={() => updateLocation(event.calendarId, event.id, 'officeLocation', 'Office')}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors ${
                currentType === 'officeLocation' ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-1'
              }`}
            >
              <Building2 size={12} className="text-text-tertiary" />
              Office
            </button>
          )}

          {/* Custom */}
          <div className="border-t border-border mt-1 pt-1">
            {showCustom ? (
              <div className="px-3 py-1 flex items-center gap-1.5">
                <MapPin size={12} className="text-text-tertiary flex-shrink-0" />
                <input
                  type="text"
                  value={customLabel}
                  onChange={(e) => setCustomLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customLabel.trim()) {
                      updateLocation(event.calendarId, event.id, 'customLocation', customLabel.trim())
                    }
                  }}
                  placeholder="Custom location..."
                  className="flex-1 bg-surface-1 border border-border rounded-sm px-1.5 py-0.5 text-xs text-text-primary placeholder:text-text-tertiary outline-none"
                  autoFocus
                />
              </div>
            ) : (
              <button
                onClick={() => setShowCustom(true)}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-text-tertiary hover:text-text-secondary hover:bg-surface-1 transition-colors"
              >
                <MapPin size={12} />
                Custom location...
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
