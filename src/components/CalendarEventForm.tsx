import { useState, useEffect } from 'react'
import { useCalendarStore } from '@/store/calendar'
import { X } from 'lucide-react'
import type { CalendarEvent } from '@/calendar/types'

export function CalendarEventForm() {
  const calendars = useCalendarStore((s) => s.calendars)
  const editingEvent = useCalendarStore((s) => s.editingEvent)
  const newEventStart = useCalendarStore((s) => s.newEventStart)
  const newEventEnd = useCalendarStore((s) => s.newEventEnd)
  const closeEventForm = useCalendarStore((s) => s.closeEventForm)
  const createEvent = useCalendarStore((s) => s.createEvent)
  const updateEvent = useCalendarStore((s) => s.updateEvent)

  const isEdit = !!editingEvent
  const writableCalendars = calendars.filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer')
  const primaryCalendar = writableCalendars.find((c) => c.primary) || writableCalendars[0]

  const [title, setTitle] = useState('')
  const [calendarId, setCalendarId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [startTime, setStartTime] = useState('')
  const [endDate, setEndDate] = useState('')
  const [endTime, setEndTime] = useState('')
  const [allDay, setAllDay] = useState(false)
  const [location, setLocation] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  // Initialize form values
  useEffect(() => {
    if (editingEvent) {
      setTitle(editingEvent.summary || '')
      setCalendarId(editingEvent.calendarId)
      setLocation(editingEvent.location || '')
      setDescription(editingEvent.description || '')

      if (editingEvent.start.date) {
        setAllDay(true)
        setStartDate(editingEvent.start.date)
        setEndDate(editingEvent.end.date || editingEvent.start.date)
      } else if (editingEvent.start.dateTime) {
        setAllDay(false)
        const s = new Date(editingEvent.start.dateTime)
        const e = new Date(editingEvent.end.dateTime!)
        setStartDate(formatDateInput(s))
        setStartTime(formatTimeInput(s))
        setEndDate(formatDateInput(e))
        setEndTime(formatTimeInput(e))
      }
    } else {
      setCalendarId(primaryCalendar?.id || '')
      const s = newEventStart || new Date()
      const e = newEventEnd || new Date(s.getTime() + 3600000)
      setStartDate(formatDateInput(s))
      setStartTime(formatTimeInput(s))
      setEndDate(formatDateInput(e))
      setEndTime(formatTimeInput(e))
    }
  }, [editingEvent, newEventStart, newEventEnd, primaryCalendar])

  const handleSubmit = async () => {
    if (!title.trim() || !calendarId) return
    setSaving(true)

    const eventData: Partial<CalendarEvent> = {
      summary: title.trim(),
      location: location.trim() || undefined,
      description: description.trim() || undefined,
    }

    if (allDay) {
      eventData.start = { date: startDate }
      eventData.end = { date: endDate || startDate }
    } else {
      eventData.start = { dateTime: new Date(`${startDate}T${startTime}`).toISOString() }
      eventData.end = { dateTime: new Date(`${endDate}T${endTime}`).toISOString() }
    }

    // Find the account that owns the selected calendar
    const cal = calendars.find((c) => c.id === calendarId)
    const accountEmail = cal?.accountEmail || ''

    if (isEdit) {
      await updateEvent(calendarId, accountEmail, editingEvent!.id, eventData)
    } else {
      await createEvent(calendarId, accountEmail, eventData)
    }

    setSaving(false)
    closeEventForm()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={closeEventForm}>
      <div
        className="bg-surface-0 border border-border rounded-sm shadow-lg w-96 max-w-[90vw] animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-text-primary">
            {isEdit ? 'Edit Event' : 'New Event'}
          </span>
          <button
            onClick={closeEventForm}
            className="text-text-tertiary hover:text-text-secondary"
          >
            <X size={14} />
          </button>
        </div>

        {/* Form */}
        <div className="px-3 py-3 space-y-3">
          {/* Title */}
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="Event title"
            className="w-full bg-surface-1 border border-border rounded-sm px-2 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-text-tertiary"
            autoFocus
          />

          {/* Calendar selector */}
          {writableCalendars.length > 1 && (
            <div>
              <label className="text-[10px] text-text-tertiary uppercase tracking-wider">Calendar</label>
              <select
                value={calendarId}
                onChange={(e) => setCalendarId(e.target.value)}
                className="w-full bg-surface-1 border border-border rounded-sm px-2 py-1 text-xs text-text-primary outline-none mt-0.5"
              >
                {writableCalendars.map((c) => (
                  <option key={c.id} value={c.id}>{c.summary}</option>
                ))}
              </select>
            </div>
          )}

          {/* All-day toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              className="accent-text-primary"
            />
            <span className="text-xs text-text-secondary">All day</span>
          </label>

          {/* Date/Time */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-text-tertiary uppercase tracking-wider">Start</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => { setStartDate(e.target.value); if (!endDate || endDate < e.target.value) setEndDate(e.target.value) }}
                className="w-full bg-surface-1 border border-border rounded-sm px-2 py-1 text-xs text-text-primary outline-none mt-0.5"
              />
              {!allDay && (
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full bg-surface-1 border border-border rounded-sm px-2 py-1 text-xs text-text-primary outline-none mt-1"
                />
              )}
            </div>
            <div>
              <label className="text-[10px] text-text-tertiary uppercase tracking-wider">End</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full bg-surface-1 border border-border rounded-sm px-2 py-1 text-xs text-text-primary outline-none mt-0.5"
              />
              {!allDay && (
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full bg-surface-1 border border-border rounded-sm px-2 py-1 text-xs text-text-primary outline-none mt-1"
                />
              )}
            </div>
          </div>

          {/* Location */}
          <div>
            <label className="text-[10px] text-text-tertiary uppercase tracking-wider">Location</label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Add location"
              className="w-full bg-surface-1 border border-border rounded-sm px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary outline-none mt-0.5"
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-[10px] text-text-tertiary uppercase tracking-wider">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add description"
              rows={3}
              className="w-full bg-surface-1 border border-border rounded-sm px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary outline-none mt-0.5 resize-none"
            />
          </div>

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || saving}
            className="w-full px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-sm hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Event'}
          </button>
        </div>
      </div>
    </div>
  )
}

function formatDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatTimeInput(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
