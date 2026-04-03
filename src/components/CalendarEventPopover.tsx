import { useEffect, useRef } from 'react'
import { useCalendarStore } from '@/store/calendar'
import {
  X, MapPin, Clock, Users, Video,
  ExternalLink, Pencil, Trash2,
  Check, HelpCircle, XCircle,
} from 'lucide-react'

export function CalendarEventPopover() {
  const events = useCalendarStore((s) => s.events)
  const calendars = useCalendarStore((s) => s.calendars)
  const selectedEventId = useCalendarStore((s) => s.selectedEventId)
  const selectEvent = useCalendarStore((s) => s.selectEvent)
  const rsvp = useCalendarStore((s) => s.rsvp)
  const deleteEvent = useCalendarStore((s) => s.deleteEvent)
  const openEditForm = useCalendarStore((s) => s.openEditForm)
  const ref = useRef<HTMLDivElement>(null)

  const event = events.find((e) => e.id === selectedEventId)
  const calendar = event ? calendars.find((c) => c.id === event.calendarId) : null

  // Close on Escape or click outside
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') selectEvent(null)
    }
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        selectEvent(null)
      }
    }
    window.addEventListener('keydown', handleKey)
    window.addEventListener('mousedown', handleClick)
    return () => {
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('mousedown', handleClick)
    }
  }, [selectEvent])

  if (!event) return null

  const startDate = event.start.dateTime ? new Date(event.start.dateTime) : null
  const endDate = event.end.dateTime ? new Date(event.end.dateTime) : null
  const isAllDay = !event.start.dateTime && !!event.start.date

  const timeStr = isAllDay
    ? 'All day'
    : startDate && endDate
      ? `${startDate.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${startDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })} – ${endDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`
      : ''

  const selfAttendee = event.attendees?.find((a) => a.self)
  const canRsvp = !!selfAttendee
  const calColor = calendar?.backgroundColor || '#3b82f6'
  const isOwner = calendar?.accessRole === 'owner' || calendar?.accessRole === 'writer'

  // Conference link
  const meetLink = event.hangoutLink
    || event.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === 'video')?.uri

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20" onClick={() => selectEvent(null)}>
      <div
        ref={ref}
        className="bg-surface-0 border border-border rounded-sm shadow-lg w-80 max-w-[90vw] animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-2 px-3 pt-3 pb-2">
          <div
            className="w-3 h-3 rounded-sm flex-shrink-0 mt-0.5"
            style={{ backgroundColor: calColor }}
          />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-text-primary leading-tight">
              {event.summary}
            </h3>
            {calendar && (
              <div className="text-[10px] text-text-tertiary mt-0.5">{calendar.summary}</div>
            )}
          </div>
          <button
            onClick={() => selectEvent(null)}
            className="text-text-tertiary hover:text-text-secondary transition-colors flex-shrink-0"
          >
            <X size={14} />
          </button>
        </div>

        {/* Details */}
        <div className="px-3 pb-2 space-y-1.5">
          {/* Time */}
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <Clock size={11} className="text-text-tertiary flex-shrink-0" />
            {timeStr}
          </div>

          {/* Location */}
          {event.location && (
            <div className="flex items-start gap-2 text-xs text-text-secondary">
              <MapPin size={11} className="text-text-tertiary flex-shrink-0 mt-0.5" />
              <span className="break-words">{event.location}</span>
            </div>
          )}

          {/* Video link */}
          {meetLink && (
            <div className="flex items-center gap-2 text-xs">
              <Video size={11} className="text-text-tertiary flex-shrink-0" />
              <a
                href={meetLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline truncate"
              >
                Join video call
              </a>
            </div>
          )}

          {/* Attendees */}
          {event.attendees && event.attendees.length > 0 && (
            <div className="flex items-start gap-2 text-xs text-text-secondary">
              <Users size={11} className="text-text-tertiary flex-shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                {event.attendees.slice(0, 5).map((a, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <StatusDot status={a.responseStatus} />
                    <span className="truncate">{a.displayName || a.email}</span>
                    {a.organizer && <span className="text-text-tertiary">(organizer)</span>}
                  </div>
                ))}
                {event.attendees.length > 5 && (
                  <div className="text-text-tertiary">+{event.attendees.length - 5} more</div>
                )}
              </div>
            </div>
          )}

          {/* Description snippet */}
          {event.description && (
            <div className="text-xs text-text-tertiary mt-1 line-clamp-3 whitespace-pre-wrap">
              {event.description.replace(/<[^>]*>/g, '').slice(0, 200)}
            </div>
          )}
        </div>

        {/* RSVP buttons */}
        {canRsvp && (
          <div className="px-3 py-2 border-t border-border">
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">RSVP</div>
            <div className="flex gap-1">
              <RsvpButton
                label="Accept"
                icon={<Check size={11} />}
                active={selfAttendee.responseStatus === 'accepted'}
                onClick={() => rsvp(event.calendarId, event.id, 'accepted')}
              />
              <RsvpButton
                label="Maybe"
                icon={<HelpCircle size={11} />}
                active={selfAttendee.responseStatus === 'tentative'}
                onClick={() => rsvp(event.calendarId, event.id, 'tentative')}
              />
              <RsvpButton
                label="Decline"
                icon={<XCircle size={11} />}
                active={selfAttendee.responseStatus === 'declined'}
                onClick={() => rsvp(event.calendarId, event.id, 'declined')}
              />
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="px-3 py-2 border-t border-border flex items-center gap-2">
          {isOwner && (
            <>
              <button
                onClick={() => { openEditForm(event); selectEvent(null) }}
                className="flex items-center gap-1 px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                <Pencil size={11} />
                Edit
              </button>
              <button
                onClick={() => {
                  if (confirm('Delete this event?')) {
                    deleteEvent(event.calendarId, event.id)
                    selectEvent(null)
                  }
                }}
                className="flex items-center gap-1 px-2 py-0.5 text-xs text-red-400 hover:text-red-300 transition-colors"
              >
                <Trash2 size={11} />
                Delete
              </button>
            </>
          )}
          <div className="flex-1" />
          {event.htmlLink && (
            <a
              href={event.htmlLink}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-2 py-0.5 text-xs text-text-tertiary hover:text-text-secondary transition-colors"
            >
              <ExternalLink size={11} />
              Google
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    accepted: 'bg-green-400',
    tentative: 'bg-yellow-400',
    declined: 'bg-red-400',
    needsAction: 'bg-text-tertiary',
  }
  return <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${colors[status] || 'bg-text-tertiary'}`} />
}

function RsvpButton({ label, icon, active, onClick }: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded-sm border transition-colors ${
        active
          ? 'bg-surface-2 border-border-strong text-text-primary'
          : 'border-border text-text-secondary hover:bg-surface-1'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}
