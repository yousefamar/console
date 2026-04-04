import { create } from 'zustand'
import { db } from '@/db'
import * as api from '@/calendar/api'
import { getAccounts, addCalendarAccount, removeCalendarAccount, type CalendarAccount } from '@/calendar/accounts'
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

function compoundKey(accountEmail: string, calendarId: string, eventId: string): string {
  return `${accountEmail}:${calendarId}:${eventId}`
}

function toDbEvent(e: CalendarEvent, calendarId: string, accountEmail: string): DbCalendarEvent {
  return {
    id: e.id,
    calendarId,
    accountEmail,
    compoundKey: compoundKey(accountEmail, calendarId, e.id),
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
    accountEmail: d.accountEmail,
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
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
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
  accounts: CalendarAccount[]
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
  loadAccounts: () => Promise<void>
  addAccount: () => Promise<void>
  removeAccount: (email: string) => Promise<void>
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
  createEvent: (calendarId: string, accountEmail: string, event: Partial<CalendarEvent>) => Promise<void>
  updateEvent: (calendarId: string, accountEmail: string, eventId: string, updates: Partial<CalendarEvent>) => Promise<void>
  deleteEvent: (calendarId: string, accountEmail: string, eventId: string) => Promise<void>
  rsvp: (calendarId: string, accountEmail: string, eventId: string, status: 'accepted' | 'declined' | 'tentative') => Promise<void>
  updateLocation: (calendarId: string, accountEmail: string, eventId: string, locationType: string, customLabel?: string) => Promise<void>

  // Event form
  openCreateForm: (start?: Date, end?: Date) => void
  openEditForm: (event: CalendarEvent) => void
  closeEventForm: () => void
  openLocationPicker: (event: CalendarEvent) => void
  closeLocationPicker: () => void

  loadEventsFromDb: () => Promise<void>
}

export const useCalendarStore = create<CalendarState>((set, get) => ({
  accounts: [],
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

  // --- Accounts ---

  loadAccounts: async () => {
    const accounts = await getAccounts()
    set({ accounts })
  },

  addAccount: async () => {
    try {
      await addCalendarAccount()
      const accounts = await getAccounts()
      set({ accounts })
      // Fetch calendars for the new account
      await get().fetchCalendars()
      await get().fetchEvents()
    } catch (err) {
      console.error('Failed to add calendar account:', err)
    }
  },

  removeAccount: async (email) => {
    await removeCalendarAccount(email)
    const accounts = await getAccounts()
    set({ accounts })
    // Reload calendars without the removed account
    const calendars = get().calendars.filter((c) => c.accountEmail !== email)
    set({ calendars })
    await get().loadEventsFromDb()
  },

  // --- Fetch ---

  fetchCalendars: async () => {
    const { accounts } = get()
    if (accounts.length === 0) return

    try {
      const allCalendars: CalendarInfo[] = []

      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const res = await api.getCalendarList(account.email)
          return { accountEmail: account.email, items: res.items }
        })
      )

      // Collect all calendars per account, then deduplicate.
      // Display under primary account, but use the owning account's token for API calls.
      const calsByAccount = new Map<string, CalendarInfo[]>()
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const cals = result.value.items
            .filter((c) => c.selected !== false)
            .map((c) => ({ ...c, accountEmail: result.value.accountEmail, apiAccountEmail: result.value.accountEmail }))
          calsByAccount.set(result.value.accountEmail, cals)
        }
      }

      // For each calendar ID, determine the best API account:
      // prefer the account whose email matches the calendar ID (i.e. the owner),
      // otherwise prefer owner > writer > reader access role
      const ACCESS_RANK: Record<string, number> = { owner: 3, writer: 2, reader: 1, freeBusyReader: 0 }
      const bestApiAccount = new Map<string, string>() // calId -> accountEmail for API
      for (const [accountEmail, cals] of calsByAccount) {
        for (const cal of cals) {
          const existing = bestApiAccount.get(cal.id)
          if (!existing) {
            bestApiAccount.set(cal.id, accountEmail)
          } else if (cal.id === accountEmail) {
            // Calendar ID matches this account's email — this is the owner
            bestApiAccount.set(cal.id, accountEmail)
          } else if (existing && (ACCESS_RANK[cal.accessRole] || 0) > (ACCESS_RANK[calsByAccount.get(existing)?.find(c => c.id === cal.id)?.accessRole || ''] || 0)) {
            bestApiAccount.set(cal.id, accountEmail)
          }
        }
      }

      // Deduplicate: primary account displays first, but set apiAccountEmail to the best owner
      const seenCalIds = new Set<string>()
      for (const account of accounts) {
        const cals = calsByAccount.get(account.email) || []
        for (const cal of cals) {
          if (seenCalIds.has(cal.id)) continue
          seenCalIds.add(cal.id)
          cal.apiAccountEmail = bestApiAccount.get(cal.id) || cal.accountEmail
          allCalendars.push(cal)
        }
      }

      // Persist to IDB
      const dbItems: DbCalendarInfo[] = allCalendars.map((c) => ({
        id: c.id,
        accountEmail: c.accountEmail,
        summary: c.summary,
        backgroundColor: c.backgroundColor,
        foregroundColor: c.foregroundColor,
        selected: c.selected,
        accessRole: c.accessRole,
        primary: c.primary,
        timeZone: c.timeZone,
      }))
      // Replace calendar list — clear first so unsubscribed calendars are removed
      await db.calendarList.clear()
      await db.calendarList.bulkPut(dbItems)

      // Initialize visibility
      const { visibleCalendarIds } = get()
      const savedIds = localStorage.getItem('calendar-visible-ids')
      let newVisible: Set<string>
      if (savedIds) {
        newVisible = new Set(JSON.parse(savedIds) as string[])
      } else if (visibleCalendarIds.size === 0) {
        newVisible = new Set(allCalendars.map((c) => c.id))
      } else {
        newVisible = visibleCalendarIds
      }

      set({ calendars: allCalendars, connected: true, visibleCalendarIds: newVisible })
    } catch (err) {
      console.error('Failed to fetch calendars:', err)
      const dbItems = await db.calendarList.toArray()
      if (dbItems.length > 0) {
        set({ calendars: dbItems as CalendarInfo[], connected: false })
      }
    }
  },

  fetchEvents: async (start?: Date, end?: Date) => {
    const { calendars, currentDate } = get()
    if (calendars.length === 0) return

    set({ loading: true })

    const rangeStart = start || addDays(weekStart(currentDate), -7)
    const rangeEnd = end || addDays(weekEnd(currentDate), 14)
    const timeMin = rangeStart.toISOString()
    const timeMax = rangeEnd.toISOString()

    // Fetch ALL calendars, not just visible — visibility is a display filter only.
    // This ensures toggling a calendar visible instantly shows its events from IDB.
    const visibleCals = calendars

    try {
      const results = await Promise.allSettled(
        visibleCals.map(async (cal) => {
          const res = await api.getEvents(cal.apiAccountEmail, cal.id, timeMin, timeMax)
          return { calId: cal.id, accountEmail: cal.apiAccountEmail, items: res.items || [] }
        })
      )

      const dbEvents: DbCalendarEvent[] = []
      for (const result of results) {
        if (result.status === 'fulfilled') {
          for (const event of result.value.items) {
            if (event.status === 'cancelled') continue
            dbEvents.push(toDbEvent(event, result.value.calId, result.value.accountEmail))
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
    await get().loadAccounts()
    await get().fetchCalendars()
    await get().fetchEvents()
  },

  // --- Navigation ---

  navigateWeek: (delta) => {
    const { currentDate, view } = get()
    const days = view === 'week' ? 7 * delta : delta
    const newDate = addDays(currentDate, days)
    set({ currentDate: newDate, selectedEventId: null })
    get().fetchEvents(addDays(weekStart(newDate), -7), addDays(weekEnd(newDate), 14))
  },

  navigateToday: () => {
    set({ currentDate: new Date(), selectedEventId: null })
    get().fetchEvents()
  },

  navigateToDate: (date) => {
    set({ currentDate: date, selectedEventId: null })
    get().fetchEvents(addDays(weekStart(date), -7), addDays(weekEnd(date), 14))
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

  // --- CRUD (all take accountEmail) ---

  createEvent: async (calendarId, accountEmail, event) => {
    try {
      const created = await api.createEvent(accountEmail, calendarId, event)
      await db.calendarEvents.put(toDbEvent(created, calendarId, accountEmail))
      await get().loadEventsFromDb()
    } catch (err) {
      console.error('Failed to create event:', err)
    }
  },

  updateEvent: async (calendarId, accountEmail, eventId, updates) => {
    const ck = compoundKey(accountEmail, calendarId, eventId)
    const existing = await db.calendarEvents.get(ck)

    try {
      const updated = await api.patchEvent(accountEmail, calendarId, eventId, updates)
      await db.calendarEvents.put(toDbEvent(updated, calendarId, accountEmail))
      await get().loadEventsFromDb()
    } catch (err) {
      console.error('Failed to update event:', err)
      if (existing) {
        await db.calendarEvents.put(existing)
        await get().loadEventsFromDb()
      }
    }
  },

  deleteEvent: async (calendarId, accountEmail, eventId) => {
    const ck = compoundKey(accountEmail, calendarId, eventId)
    const existing = await db.calendarEvents.get(ck)

    await db.calendarEvents.delete(ck)
    await get().loadEventsFromDb()

    try {
      await api.deleteEvent(accountEmail, calendarId, eventId)
    } catch (err) {
      console.error('Failed to delete event:', err)
      if (existing) {
        await db.calendarEvents.put(existing)
        await get().loadEventsFromDb()
      }
    }
  },

  rsvp: async (calendarId, accountEmail, eventId, status) => {
    const ck = compoundKey(accountEmail, calendarId, eventId)
    const existing = await db.calendarEvents.get(ck)
    if (!existing) return

    const event = fromDbEvent(existing)
    const attendees = event.attendees?.map((a) =>
      a.self ? { ...a, responseStatus: status } : a
    )

    try {
      const updated = await api.patchEvent(accountEmail, calendarId, eventId, { attendees })
      await db.calendarEvents.put(toDbEvent(updated, calendarId, accountEmail))
      await get().loadEventsFromDb()
    } catch (err) {
      console.error('Failed to RSVP:', err)
    }
  },

  updateLocation: async (calendarId, accountEmail, eventId, locationType, customLabel) => {
    const props: CalendarEvent['workingLocationProperties'] =
      locationType === 'homeOffice' ? { type: 'homeOffice' }
      : locationType === 'officeLocation' ? { type: 'officeLocation', officeLocation: { label: customLabel } }
      : { type: 'customLocation', customLocation: { label: customLabel || '' } }

    try {
      const current = await api.getEvent(accountEmail, calendarId, eventId)

      await api.deleteEvent(accountEmail, calendarId, eventId)
      const ck = compoundKey(accountEmail, calendarId, eventId)
      await db.calendarEvents.delete(ck)

      const summary =
        locationType === 'homeOffice' ? 'Home'
        : locationType === 'officeLocation' ? (customLabel || 'Office')
        : (customLabel || '')

      const created = await api.createEvent(accountEmail, calendarId, {
        summary,
        start: current.start,
        end: current.end,
        eventType: 'workingLocation',
        transparency: 'transparent',
        visibility: 'public',
        workingLocationProperties: props,
      } as Partial<CalendarEvent>)

      await db.calendarEvents.put(toDbEvent(created, calendarId, accountEmail))
      await get().loadEventsFromDb()
    } catch (err) {
      console.error('Failed to update location:', err)
    }
  },

  // --- Event form ---

  openCreateForm: (start, end) => {
    const now = new Date()
    const defaultStart = start || new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0)
    const defaultEnd = end || new Date(defaultStart.getTime() + 60 * 60 * 1000)
    set({ showEventForm: true, editingEvent: null, newEventStart: defaultStart, newEventEnd: defaultEnd })
  },

  openEditForm: (event) => set({ showEventForm: true, editingEvent: event }),
  closeEventForm: () => set({ showEventForm: false, editingEvent: null, newEventStart: null, newEventEnd: null }),
  openLocationPicker: (event) => set({ locationPickerEvent: event }),
  closeLocationPicker: () => set({ locationPickerEvent: null }),

  // --- Load from DB ---

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

    const startDate = rangeStart.toISOString().split('T')[0]!
    const endDate = rangeEnd.toISOString().split('T')[0]!
    const allDayEvents = await db.calendarEvents
      .where('startTime')
      .between(startDate, endDate + 'Z', true, true)
      .toArray()

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
