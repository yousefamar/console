import { useEffect, useMemo, useRef, useState } from 'react'
import { useCalendarStore } from '@/store/calendar'
import { showConfirm } from '@/dialog'
import type { CalendarEvent } from '@/calendar/types'
import { sanitizeAndLinkify } from '@/utils/html'
import {
  X, MapPin, Clock, Users, Video,
  ExternalLink, Pencil, Trash2,
  Check, HelpCircle, XCircle,
  Bell, BellOff,
} from 'lucide-react'

export function CalendarEventPopover({ eventsOverride }: { eventsOverride?: CalendarEvent[] } = {}) {
  const storeEvents = useCalendarStore((s) => s.events)
  const events = eventsOverride ?? storeEvents
  const calendars = useCalendarStore((s) => s.calendars)
  const selectedEventId = useCalendarStore((s) => s.selectedEventId)
  const selectEvent = useCalendarStore((s) => s.selectEvent)
  const rsvp = useCalendarStore((s) => s.rsvp)
  const setReminder = useCalendarStore((s) => s.setReminder)
  const deleteEvent = useCalendarStore((s) => s.deleteEvent)
  const openEditForm = useCalendarStore((s) => s.openEditForm)
  const ref = useRef<HTMLDivElement>(null)
  const [deleteScopeFor, setDeleteScopeFor] = useState<CalendarEvent | null>(null)
  const scopeDialogOpen = useRef(false)
  scopeDialogOpen.current = deleteScopeFor !== null

  const event = events.find((e) => e.id === selectedEventId)
  const calendar = event ? calendars.find((c) => c.id === event.calendarId) : null

  // Close on Escape or click outside
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (scopeDialogOpen.current) {
        setDeleteScopeFor(null)
        return
      }
      selectEvent(null)
    }
    const handleClick = (e: MouseEvent) => {
      // The delete-scope dialog renders outside `ref` — don't let a click in it
      // (or its backdrop) tear down the popover underneath it.
      if (scopeDialogOpen.current) return
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

  // Conference link — append authuser for Google Meet so it opens with the right
  // account. The identity to join AS is the one invited, which is NOT necessarily
  // `event.accountEmail` (that's just whichever account's token fetched the event;
  // for a delegated/shared calendar it's the wrong Google identity and Meet then
  // asks to request access). Prefer, in order: the self attendee, a self organizer,
  // the calendar id when it looks like an address (shared cals are keyed by email),
  // then the fetching account.
  const rawMeetLink = event.hangoutLink
    || event.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === 'video')?.uri
  const joinAs = selfAttendee?.email
    || (event.organizer?.self ? event.organizer.email : undefined)
    || (event.calendarId.includes('@') && !event.calendarId.endsWith('.calendar.google.com')
      ? event.calendarId
      : undefined)
    || event.accountEmail
  const meetLink = rawMeetLink && rawMeetLink.includes('meet.google.com') && joinAs
    ? `${rawMeetLink}${rawMeetLink.includes('?') ? '&' : '?'}authuser=${encodeURIComponent(joinAs)}`
    : rawMeetLink

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
            <DescriptionBlock description={event.description} />
          )}
        </div>

        {/* Reminders */}
        {isOwner && !isAllDay && (
          <ReminderPicker
            reminders={event.reminders}
            defaultReminders={calendar?.defaultReminders}
            onChange={(minutes) => setReminder(event.calendarId, event.accountEmail, event.id, minutes)}
          />
        )}

        {/* RSVP buttons */}
        {canRsvp && (
          <div className="px-3 py-2 border-t border-border">
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">RSVP</div>
            <div className="flex gap-1">
              <RsvpButton
                label="Accept"
                icon={<Check size={11} />}
                active={selfAttendee.responseStatus === 'accepted'}
                onClick={() => rsvp(event.calendarId, event.accountEmail, event.id, 'accepted')}
              />
              <RsvpButton
                label="Maybe"
                icon={<HelpCircle size={11} />}
                active={selfAttendee.responseStatus === 'tentative'}
                onClick={() => rsvp(event.calendarId, event.accountEmail, event.id, 'tentative')}
              />
              <RsvpButton
                label="Decline"
                icon={<XCircle size={11} />}
                active={selfAttendee.responseStatus === 'declined'}
                onClick={() => rsvp(event.calendarId, event.accountEmail, event.id, 'declined')}
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
                onClick={async () => {
                  // A recurring instance gets the GCal-style scope dialog;
                  // a one-off keeps the plain confirm.
                  if (event.recurringEventId) {
                    setDeleteScopeFor(event)
                    return
                  }
                  if (await showConfirm('Delete this event?', { title: 'Delete event', danger: true, confirmLabel: 'Delete' })) {
                    deleteEvent(event.calendarId, event.accountEmail, event.id)
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

      {deleteScopeFor && (
        <DeleteScopeDialog
          event={deleteScopeFor}
          onClose={() => setDeleteScopeFor(null)}
          onDone={() => { setDeleteScopeFor(null); selectEvent(null) }}
        />
      )}
    </div>
  )
}

// GCal-parity scope chooser for deleting a recurring event's instance.
function DeleteScopeDialog({ event, onClose, onDone }: {
  event: CalendarEvent
  onClose: () => void
  onDone: () => void
}) {
  const deleteEvent = useCalendarStore((s) => s.deleteEvent)
  const deleteFollowingEvents = useCalendarStore((s) => s.deleteFollowingEvents)
  const deleteAllEvents = useCalendarStore((s) => s.deleteAllEvents)
  const [scope, setScope] = useState<'this' | 'following' | 'all'>('this')
  const masterId = event.recurringEventId!
  const instanceStart = event.start.dateTime || event.start.date || ''

  const confirm = () => {
    if (scope === 'this') {
      deleteEvent(event.calendarId, event.accountEmail, event.id)
    } else if (scope === 'following') {
      deleteFollowingEvents(event.calendarId, event.accountEmail, masterId, instanceStart)
    } else {
      deleteAllEvents(event.calendarId, event.accountEmail, masterId)
    }
    onDone()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={(e) => { e.stopPropagation(); onClose() }}>
      <div
        className="bg-surface-0 border border-border rounded-sm shadow-lg w-72 animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3 pb-2">
          <h3 className="text-sm font-medium text-text-primary">
            Delete repeat event &ldquo;{event.summary}&rdquo;
          </h3>
        </div>
        <div className="px-4 py-2 space-y-1.5">
          {([
            ['this', 'This event'],
            ['following', 'This and following events'],
            ['all', 'All events'],
          ] as const).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="delete-scope" checked={scope === value} onChange={() => setScope(value)} className="accent-accent" />
              <span className="text-xs text-text-primary">{label}</span>
            </label>
          ))}
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-border">
          <button onClick={onClose} className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary transition-colors">
            Cancel
          </button>
          <div className="flex-1" />
          <button
            onClick={confirm}
            className="px-3 py-1 text-xs font-medium bg-red-500 text-white rounded-sm hover:bg-red-400 transition-colors"
          >
            Delete
          </button>
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

const REMINDER_PRESETS = [
  { minutes: 0, label: 'At start' },
  { minutes: 5, label: '5 min' },
  { minutes: 10, label: '10 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hr' },
] as const

function DescriptionBlock({ description }: { description: string }) {
  const html = useMemo(() => sanitizeAndLinkify(description), [description])
  return (
    <div
      className="text-xs text-text-tertiary mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words [&_a]:text-text-secondary [&_a]:underline [&_a:hover]:text-text-primary"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function ReminderPicker({ reminders, defaultReminders, onChange }: {
  reminders?: { useDefault: boolean; overrides?: Array<{ method: string; minutes: number }> }
  defaultReminders?: Array<{ method: string; minutes: number }>
  onChange: (minutes: number | null) => void
}) {
  // Resolve useDefault to actual reminder minutes
  const effectiveOverrides = reminders?.useDefault !== false
    ? defaultReminders
    : reminders?.overrides
  const activeMinutes = effectiveOverrides?.[0]?.minutes
  const hasReminder = !!effectiveOverrides?.length

  return (
    <div className="px-3 py-2 border-t border-border">
      <div className="flex items-center gap-1.5 mb-1">
        {hasReminder
          ? <Bell size={10} className="text-text-tertiary" />
          : <BellOff size={10} className="text-text-tertiary" />}
        <span className="text-[10px] text-text-tertiary uppercase tracking-wider">Reminder</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {REMINDER_PRESETS.map((p) => (
          <button
            key={p.minutes}
            onClick={() => onChange(activeMinutes === p.minutes ? null : p.minutes)}
            className={`px-2 py-0.5 text-xs rounded-sm border transition-colors ${
              activeMinutes === p.minutes
                ? 'bg-surface-2 border-border-strong text-text-primary'
                : 'border-border text-text-secondary hover:bg-surface-1'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}
