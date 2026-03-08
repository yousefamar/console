import type { CalendarEvent } from '@/gmail/types'
import { Calendar, MapPin, Users } from 'lucide-react'

interface CalendarEventCardProps {
  event: CalendarEvent
}

export function CalendarEventCard({ event }: CalendarEventCardProps) {
  const isCancelled = event.status === 'CANCELLED' || event.method === 'CANCEL'
  const startDate = new Date(event.start)
  const endDate = new Date(event.end)
  const isAllDay = startDate.getHours() === 0 && startDate.getMinutes() === 0 &&
    endDate.getHours() === 0 && endDate.getMinutes() === 0
  const isSameDay = startDate.toDateString() === endDate.toDateString()

  return (
    <div className="mx-4 mb-3 rounded-sm border border-border bg-surface-1 overflow-hidden">
      {/* Color bar */}
      <div className={`h-1 ${isCancelled ? 'bg-destructive' : 'bg-accent'}`} />

      <div className="px-3 py-2.5 space-y-2">
        {/* Title */}
        <div className="flex items-start gap-2">
          <Calendar size={14} className="text-text-tertiary mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <span className={`text-sm font-medium ${isCancelled ? 'line-through text-text-tertiary' : 'text-text-primary'}`}>
              {event.summary}
            </span>
            {isCancelled && (
              <span className="ml-2 text-xs text-destructive font-medium">Cancelled</span>
            )}
          </div>
        </div>

        {/* Date/time */}
        <div className="flex items-center gap-2 text-xs text-text-secondary pl-5">
          {isAllDay ? (
            isSameDay
              ? formatDay(startDate)
              : `${formatDay(startDate)} – ${formatDay(endDate)}`
          ) : (
            isSameDay
              ? `${formatDay(startDate)}, ${formatTime(startDate)} – ${formatTime(endDate)}`
              : `${formatDay(startDate)} ${formatTime(startDate)} – ${formatDay(endDate)} ${formatTime(endDate)}`
          )}
        </div>

        {/* Location */}
        {event.location && (
          <div className="flex items-center gap-2 text-xs text-text-secondary pl-5">
            <MapPin size={11} className="text-text-tertiary flex-shrink-0" />
            <span className="truncate">{event.location}</span>
          </div>
        )}

        {/* Attendees */}
        {event.attendees && event.attendees.length > 0 && (
          <div className="flex items-start gap-2 text-xs text-text-secondary pl-5">
            <Users size={11} className="text-text-tertiary flex-shrink-0 mt-0.5" />
            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
              {event.attendees.map((a, i) => (
                <span key={i} className="flex items-center gap-0.5">
                  <StatusDot status={a.status} />
                  {a.name || a.email}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: string }) {
  const color = status === 'accepted'
    ? 'bg-success'
    : status === 'declined'
      ? 'bg-destructive'
      : status === 'tentative'
        ? 'bg-warning'
        : 'bg-text-tertiary'

  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color} flex-shrink-0`} />
}

function formatDay(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}
