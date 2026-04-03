import { create } from 'zustand'
import { db } from '@/db'
import * as api from '@/calendar/api'
import type { CalendarInfo, CalendarEvent, DbCalendarInfo, DbCalendarEvent } from '@/calendar/types'

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function eventStartTime(e: CalendarEvent): string {
  return e.start.dateTime || e.start.date || ''
}

function eventEndTime(e: CalendarEvent): string {
  return e.end.dateTime || e.end.date || ''
}

function isAllDay(e: CalendarEvent): boolean {
  return !e.start.dateTime && !!e.start.date
}

function toDbEvent(e: CalendarEvent, calendarId: string): DbCalendarEvent {
  return {
    id: e.id,
    calendarId,
    compoundKey: `${calendarId}:${e.id}`,
    summary: e.summary || '(No title)',
    description: e.description,
    location: e.location,
    startTime: eventStartTime(e),
    endTime: eventEndTime(e),
    allDay: isAllDay(e),
    status: e.status,
    attendeesJson: e.attendees ? JSON.stringify(e.attendees) : undefined,
    organizerEmail: e.organizer?.email,
    organizerName: e.organizer?.displayName,
    colorId: e.colorId,
    recurringEventId: e.recurringEventId,
    htmlLink: e.htmlLink,
    hangoutLink: e.hangoutLink,
    conferenceDataJson: e.conferenceData ? JSON.stringify(e.conferenceData) : undefined,
    eventType: e.eventType,
    workingLocationJson: e.workingLocationProperties ? JSON.stringify(e.workingLocationProperties) : undefined,
    created: e.created,
    updated: e.updated,
  }
}

function fromDbEvent(d: DbCalendarEvent): CalendarEvent {
  return {
    id: d.id,
    calendarId: d.calendarId,
    summary: d.summary,
    description: d.description,
    location: d.location,
    start: d.allDay ? { date: d.startTime } : { dateTime: d.startTime },
    end: d.allDay ? { date: d.endTime } : { dateTime: d.endTime },
    status: d.status as CalendarEvent['status'],
    attendees: d.attendeesJson ? JSON.parse(d.attendeesJson) : undefined,
    organizer: d.organizerEmail ? { email: d.organizerEmail, displayName: d.organizerName } : undefined,
    colorId: d.colorId,
    recurringEventId: d.recurringEventId,
    htmlLink: d.htmlLink,
    hangoutLink: d.hangoutLink,
    conferenceData: d.conferenceDataJson ? JSON.parse(d.conferenceDataJson) : undefined,
    eventType: d.eventType as CalendarEvent['eventType'],
    workingLocationProperties: d.workingLocationJson ? JSON.parse(d.workingLocationJson) : undefined,
    created: d.created,
    updated: d.updated,
  } as CalendarEvent
}

function weekStart(d: Date): Date {
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1) // Monday start
  return new Date(d.getFullYear(), d.getMonth(), diff)
}

function weekEnd(d: Date): Date {
  const start = weekStart(d)
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

interface CalendarState {
  calendars: CalendarInfo[]
  events: CalendarEvent[]
  loading: boolean
  connected: boolean

  currentDate: Date
  view: 'week' | 'day'
  selectedEventId: string | null
  showEventForm: boolean
  editingEvent: CalendarEvent | null
  newEventStart: Date | null
  newEventEnd: Date | null
  locationPickerEvent: CalendarEvent | null

  visibleCalendarIds: Set<string>

  // Actions
  fetchCalendars: () => Promise<void>
  fetchEvents: (start?: Date, end?: Date) => Promise<void>
  refreshAll: () => Promise<void>
  navigateWeek: (delta: number) => void
  navigateToday: () => void
  navigateToDate: (date: Date) => void
  setView: (v: 'week' | 'day') => void
  selectEvent: (id: string | null) => void
  toggleCalendarVisibility: (calId: string) => void

  // CRUD
  createEvent: (calendarId: string, event: Partial<CalendarEvent>) => Promise<void>
  updateEvent: (calendarId: string, eventId: string, updates: Partial<CalendarEvent>) => Promise<void>
  deleteEvent: (calendarId: string, eventId: string) => Promise<void>
  rsvp: (calendarId: string, eventId: string, status: 'accepted' | 'declined' | 'tentative') => Promise<void>
  updateLocation: (calendarId: string, eventId: string, locationType: string, customLabel?: string) => Promise<void>
  openLocationPicker: (event: CalendarEvent) => void
  closeLocationPicker: () => void

  // Event form
  openCreateForm: (start?: Date, end?: Date) => void
  openEditForm: (event: CalendarEvent) => void
  closeEventForm: () => void

  // Load from DB
  loadEventsFromDb: () => Promise<void>
}

export const useCalendarStore = create<CalendarState>((set, get) => ({
  calendars: [],
  events: [],
  loading: false,
  connected: false,

  currentDate: new Date(),
  view: 'week',
  selectedEventId: null,
  showEventForm: false,
  editingEvent: null,
  newEventStart: null,
  newEventEnd: null,
  locationPickerEvent: null,

  visibleCalendarIds: new Set<string>(),

  fetchCalendars: async () => {
    try {
      const res = await api.getCalendarList()
      const calendars = res.items.filter((c) => c.selected !== false)
      calendars.sort((a, b) => (a.primary ? -1 : b.primary ? 1 : a.summary.localeCompare(b.summary)))

      // Persist to IDB
      const dbItems: DbCalendarInfo[] = calendars.map((c) => ({
        id: c.id,
        summary: c.summary,
        backgroundColor: c.backgroundColor,
        foregroundColor: c.foregroundColor,
        selected: c.selected,
        accessRole: c.accessRole,
        primary: c.primary,
        timeZone: c.timeZone,
      }))
      await db.calendarList.bulkPut(dbItems)

      // Initialize visibility: show all calendars that user has selected in Google
      const { visibleCalendarIds } = get()
      const savedIds = localStorage.getItem('calendar-visible-ids')
      let newVisible: Set<string>
      if (savedIds) {
        newVisible = new Set(JSON.parse(savedIds) as string[])
      } else if (visibleCalendarIds.size === 0) {
        newVisible = new Set(calendars.map((c) => c.id))
      } else {
        newVisible = visibleCalendarIds
      }

      set({ calendars, connected: true, visibleCalendarIds: newVisible })
    } catch (err) {
      console.error('Failed to fetch calendars:', err)
      // Try loading from IDB
      const dbItems = await db.calendarList.toArray()
      if (dbItems.length > 0) {
        set({ calendars: dbItems as CalendarInfo[], connected: false })
      }
    }
  },

  fetchEvents: async (start?: Date, end?: Date) => {
    const { calendars, visibleCalendarIds, currentDate } = get()
    if (calendars.length === 0) return

    set({ loading: true })

    const rangeStart = start || addDays(weekStart(currentDate), -7)
    const rangeEnd = end || addDays(weekEnd(currentDate), 7)
    const timeMin = rangeStart.toISOString()
    const timeMax = rangeEnd.toISOString()

    const visibleCals = calendars.filter((c) => visibleCalendarIds.has(c.id))

    try {
      const results = await Promise.allSettled(
        visibleCals.map(async (cal) => {
          const res = await api.getEvents(cal.id, timeMin, timeMax)
          return { calId: cal.id, items: res.items || [] }
        })
      )

      const dbEvents: DbCalendarEvent[] = []
      for (const result of results) {
        if (result.status === 'fulfilled') {
          for (const event of result.value.items) {
            if (event.status === 'cancelled') continue
            dbEvents.push(toDbEvent(event, result.value.calId))
          }
        }
      }

      if (dbEvents.length > 0) {
        await db.calendarEvents.bulkPut(dbEvents)
      }

      set({ loading: false })
      await get().loadEventsFromDb()
    } catch (err) {
      console.error('Failed to fetch calendar events:', err)
      set({ loading: false })
      await get().loadEventsFromDb()
    }
  },

  refreshAll: async () => {
    await get().fetchCalendars()
    await get().fetchEvents()
  },

  navigateWeek: (delta) => {
    const { currentDate, view } = get()
    const days = view === 'week' ? 7 * delta : delta
    const newDate = addDays(currentDate, days)
    set({ currentDate: newDate, selectedEventId: null })
    get().fetchEvents(
      addDays(weekStart(newDate), -7),
      addDays(weekEnd(newDate), 7),
    )
  },

  navigateToday: () => {
    set({ currentDate: new Date(), selectedEventId: null })
    get().fetchEvents()
  },

  navigateToDate: (date) => {
    set({ currentDate: date, selectedEventId: null })
    get().fetchEvents(
      addDays(weekStart(date), -7),
      addDays(weekEnd(date), 7),
    )
  },

  setView: (v) => set({ view: v }),

  selectEvent: (id) => set({ selectedEventId: id }),

  toggleCalendarVisibility: (calId) => {
    set((s) => {
      const next = new Set(s.visibleCalendarIds)
      if (next.has(calId)) next.delete(calId)
      else next.add(calId)
      localStorage.setItem('calendar-visible-ids', JSON.stringify(Array.from(next)))
      return { visibleCalendarIds: next }
    })
    get().loadEventsFromDb()
  },

  // CRUD
  createEvent: async (calendarId, event) => {
    try {
      const created = await api.createEvent(calendarId, event)
      await db.calendarEvents.put(toDbEvent(created, calendarId))
      await get().loadEventsFromDb()
    } catch (err) {
      console.error('Failed to create event:', err)
    }
  },

  updateEvent: async (calendarId, eventId, updates) => {
    // Optimistic: update in IDB first
    const compoundKey = `${calendarId}:${eventId}`
    const existing = await db.calendarEvents.get(compoundKey)

    try {
      // For full update, we need the complete event. Use PATCH for partial updates.
      const updated = await api.patchEvent(calendarId, eventId, updates)
      await db.calendarEvents.put(toDbEvent(updated, calendarId))
      await get().loadEventsFromDb()
    } catch (err) {
      console.error('Failed to update event:', err)
      // Revert
      if (existing) {
        await db.calendarEvents.put(existing)
        await get().loadEventsFromDb()
      }
    }
  },

  deleteEvent: async (calendarId, eventId) => {
    const compoundKey = `${calendarId}:${eventId}`
    const existing = await db.calendarEvents.get(compoundKey)

    // Optimistic
    await db.calendarEvents.delete(compoundKey)
    await get().loadEventsFromDb()

    try {
      await api.deleteEvent(calendarId, eventId)
    } catch (err) {
      console.error('Failed to delete event:', err)
      // Revert
      if (existing) {
        await db.calendarEvents.put(existing)
        await get().loadEventsFromDb()
      }
    }
  },

  rsvp: async (calendarId, eventId, status) => {
    const compoundKey = `${calendarId}:${eventId}`
    const existing = await db.calendarEvents.get(compoundKey)
    if (!existing) return

    const event = fromDbEvent(existing)
    const attendees = event.attendees?.map((a) =>
      a.self ? { ...a, responseStatus: status } : a
    )

    try {
      const updated = await api.patchEvent(calendarId, eventId, { attendees })
      await db.calendarEvents.put(toDbEvent(updated, calendarId))
      await get().loadEventsFromDb()
    } catch (err) {
      console.error('Failed to RSVP:', err)
    }
  },

  // Working location
  updateLocation: async (calendarId, eventId, locationType, customLabel) => {
    const props: CalendarEvent['workingLocationProperties'] =
      locationType === 'homeOffice' ? { type: 'homeOffice' }
      : locationType === 'officeLocation' ? { type: 'officeLocation', officeLocation: { label: customLabel } }
      : { type: 'customLocation', customLocation: { label: customLabel || '' } }

    try {
      // Working location events: only patch workingLocationProperties.
      // Summary is auto-derived by Google — setting it directly causes 400.
      const updated = await api.patchEvent(calendarId, eventId, {
        workingLocationProperties: props,
      } as Partial<CalendarEvent>)
      await db.calendarEvents.put(toDbEvent(updated, calendarId))
      await get().loadEventsFromDb()
    } catch (err) {
      console.error('Failed to update location:', err)
    }
    set({ locationPickerEvent: null })
  },

  openLocationPicker: (event) => set({ locationPickerEvent: event }),
  closeLocationPicker: () => set({ locationPickerEvent: null }),

  // Event form
  openCreateForm: (start, end) => {
    const now = new Date()
    const defaultStart = start || new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0)
    const defaultEnd = end || new Date(defaultStart.getTime() + 60 * 60 * 1000)
    set({ showEventForm: true, editingEvent: null, newEventStart: defaultStart, newEventEnd: defaultEnd })
  },

  openEditForm: (event) => {
    set({ showEventForm: true, editingEvent: event })
  },

  closeEventForm: () => {
    set({ showEventForm: false, editingEvent: null, newEventStart: null, newEventEnd: null })
  },

  loadEventsFromDb: async () => {
    const { currentDate, view, visibleCalendarIds } = get()

    const rangeStart = view === 'week'
      ? addDays(weekStart(currentDate), -1)
      : new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate())
    const rangeEnd = view === 'week'
      ? addDays(weekEnd(currentDate), 1)
      : addDays(currentDate, 1)

    const startStr = rangeStart.toISOString()
    const endStr = rangeEnd.toISOString()

    const dbEvents = await db.calendarEvents
      .where('startTime')
      .between(startStr, endStr, true, true)
      .toArray()

    // Also fetch all-day events (date format YYYY-MM-DD)
    const startDate = rangeStart.toISOString().split('T')[0]!
    const endDate = rangeEnd.toISOString().split('T')[0]!
    const allDayEvents = await db.calendarEvents
      .where('startTime')
      .between(startDate, endDate + 'Z', true, true)
      .toArray()

    // Merge and deduplicate
    const seen = new Set<string>()
    const merged: DbCalendarEvent[] = []
    for (const e of [...dbEvents, ...allDayEvents]) {
      if (!seen.has(e.compoundKey) && visibleCalendarIds.has(e.calendarId)) {
        seen.add(e.compoundKey)
        merged.push(e)
      }
    }

    merged.sort((a, b) => a.startTime.localeCompare(b.startTime))
    set({ events: merged.map(fromDbEvent) })
  },
}))
