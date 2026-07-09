import { create } from 'zustand'
import { db } from '@/db'
import { enqueue } from '@/db/sync-queue'
import { removeByEvent } from '@/db/sync-queue'
import * as api from '@/calendar/api'
import { getAccounts, addCalendarAccount, removeCalendarAccount, type CalendarAccount } from '@/calendar/accounts'
import { optimisticallyDeleted, pendingTempIds } from '@/calendar/sync'
import { useUiStore } from '@/store/ui'
import { getPref, setPref, isPrefsLoaded } from '@/prefs'
import type { CalendarInfo, CalendarEvent, DbCalendarInfo, DbCalendarEvent } from '@/calendar/types'

const VISIBLE_CAL_IDS_PREF = 'calendar.visibleIds'
const DEFAULT_CAL_PREF = 'calendar.defaultId'
// Overlay source ids we've already shown once. Lets a first-time registration
// default to visible (even when the user has a curated visibleIds pref that
// predates the overlay) while still respecting a later explicit toggle-off.
const OVERLAY_SEEN_PREF = 'calendar.overlaySeen'

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
    organizerSelf: e.organizer?.self,
    colorId: e.colorId,
    recurringEventId: e.recurringEventId,
    htmlLink: e.htmlLink,
    hangoutLink: e.hangoutLink,
    conferenceDataJson: e.conferenceData ? JSON.stringify(e.conferenceData) : undefined,
    eventType: e.eventType,
    workingLocationJson: e.workingLocationProperties ? JSON.stringify(e.workingLocationProperties) : undefined,
    remindersJson: e.reminders ? JSON.stringify(e.reminders) : undefined,
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
    organizer: d.organizerEmail ? { email: d.organizerEmail, displayName: d.organizerName, self: d.organizerSelf } : undefined,
    colorId: d.colorId,
    recurringEventId: d.recurringEventId,
    htmlLink: d.htmlLink,
    hangoutLink: d.hangoutLink,
    conferenceData: d.conferenceDataJson ? JSON.parse(d.conferenceDataJson) : undefined,
    eventType: d.eventType as CalendarEvent['eventType'],
    workingLocationProperties: d.workingLocationJson ? JSON.parse(d.workingLocationJson) : undefined,
    reminders: d.remindersJson ? JSON.parse(d.remindersJson) : undefined,
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

function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1)
  const daysInTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(d.getDate(), daysInTarget))
  return target
}

/** Fetch window covering the visible UI plus a one-week pad on each side. */
function viewRange(date: Date, view: 'week' | 'day' | 'month'): { start: Date; end: Date } {
  if (view === 'month') {
    const firstOfMonth = new Date(date.getFullYear(), date.getMonth(), 1)
    const gridStart = weekStart(firstOfMonth)
    return { start: addDays(gridStart, -7), end: addDays(gridStart, 49) }
  }
  return { start: addDays(weekStart(date), -7), end: addDays(weekEnd(date), 14) }
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
  view: 'week' | 'day' | 'month'
  selectedEventId: string | null
  showEventForm: boolean
  editingEvent: CalendarEvent | null
  newEventStart: Date | null
  newEventEnd: Date | null
  locationPickerEvent: CalendarEvent | null

  visibleCalendarIds: Set<string>
  defaultCalendarId: string | null

  // Read-only overlay event sources (e.g. Meetup) keyed by source id. In-memory
  // only — never persisted to Dexie, never network-fetched. Merged into `events`
  // by loadEventsFromDb; their CalendarInfo is merged into `calendars`.
  overlaySources: Record<string, { info: CalendarInfo; events: CalendarEvent[] }>

  // Actions
  loadAccounts: () => Promise<void>
  addAccount: (popup?: Window | null) => Promise<void>
  removeAccount: (email: string) => Promise<void>
  fetchCalendars: () => Promise<void>
  fetchEvents: (start?: Date, end?: Date) => Promise<void>
  refreshAll: () => Promise<void>
  navigateWeek: (delta: number) => void
  navigateMonth: (delta: number) => void
  navigateToday: () => void
  navigateToDate: (date: Date) => void
  setView: (v: 'week' | 'day' | 'month') => void
  selectEvent: (id: string | null) => void
  toggleCalendarVisibility: (calId: string) => void
  setDefaultCalendar: (calId: string | null) => void
  registerOverlaySource: (id: string, info: CalendarInfo, events: CalendarEvent[]) => void
  unregisterOverlaySource: (id: string) => void

  // CRUD
  createEvent: (calendarId: string, accountEmail: string, event: Partial<CalendarEvent>) => Promise<void>
  updateEvent: (calendarId: string, accountEmail: string, eventId: string, updates: Partial<CalendarEvent>) => Promise<void>
  deleteEvent: (calendarId: string, accountEmail: string, eventId: string) => Promise<void>
  rsvp: (calendarId: string, accountEmail: string, eventId: string, status: 'accepted' | 'declined' | 'tentative') => Promise<void>
  setReminder: (calendarId: string, accountEmail: string, eventId: string, minutes: number | null) => Promise<void>
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
  // Default to day view on phone-sized viewports — 7-col week/month grids
  // are too cramped to be useful as a landing view. The user can switch.
  view: typeof window !== 'undefined' && window.innerWidth < 768 ? 'day' : 'week',
  selectedEventId: null,
  showEventForm: false,
  editingEvent: null,
  newEventStart: null,
  newEventEnd: null,
  locationPickerEvent: null,

  // Hydrated from hub prefs on boot (initPrefs() runs before App renders).
  visibleCalendarIds: new Set<string>(getPref<string[]>(VISIBLE_CAL_IDS_PREF, [])),
  defaultCalendarId: getPref<string | null>(DEFAULT_CAL_PREF, null),
  overlaySources: {},

  // --- Accounts ---

  loadAccounts: async () => {
    const accounts = await getAccounts()
    set({ accounts })
  },

  addAccount: async (popup?: Window | null) => {
    try {
      await addCalendarAccount(popup)
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
    if (accounts.length === 0) {
      // Hub unreachable / no accounts loaded yet — hydrate from IDB so we
      // don't get stuck on "Loading calendars..." when offline or the hub
      // briefly failed at boot. A later hubBus.onConnect retries the chain.
      const dbItems = await db.calendarList.toArray()
      if (dbItems.length > 0) set({ calendars: dbItems as CalendarInfo[] })
      return
    }

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

      // Persist to IDB — only the real (network) calendars. Synthetic overlay
      // infos are re-appended below but never written to Dexie.
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

      // Re-append any registered overlay infos so fetchCalendars' rebuild of
      // `calendars` doesn't drop them (they live only in overlaySources).
      const overlayInfos = Object.values(get().overlaySources).map((s) => s.info)
      const withOverlays = [...allCalendars, ...overlayInfos]

      // Initialize visibility — use the hub-synced set if present, otherwise
      // keep whatever is in-memory, otherwise default to all calendars visible.
      // Only "default to all + persist" when prefs are confirmed loaded; if
      // prefs are still loading, leave the in-memory set alone so we don't
      // clobber the saved selection on a hub-race.
      const { visibleCalendarIds } = get()
      const savedIds = getPref<string[] | null>(VISIBLE_CAL_IDS_PREF, null)
      let newVisible: Set<string>
      if (savedIds && Array.isArray(savedIds)) {
        newVisible = new Set(savedIds)
      } else if (visibleCalendarIds.size === 0 && isPrefsLoaded()) {
        newVisible = new Set(withOverlays.map((c) => c.id))
        setPref(VISIBLE_CAL_IDS_PREF, Array.from(newVisible))
      } else {
        newVisible = visibleCalendarIds
      }
      // The saved visibleIds pref predates overlay sources (Meetup, OutdoorLads),
      // so loading it above would drop their visibility even though the user
      // never toggled them off. Re-assert visibility for any overlay the user
      // hasn't explicitly hidden: a first-seen overlay defaults visible (its id
      // is absent from OVERLAY_SEEN_PREF), which the register step already added
      // to the in-memory set — union that back in so fetchCalendars can't clobber it.
      const seenOverlays = getPref<string[]>(OVERLAY_SEEN_PREF, [])
      for (const id of Object.keys(get().overlaySources)) {
        // Visible if: not yet seen (defaults on) OR currently in the live set.
        if (!seenOverlays.includes(id) || visibleCalendarIds.has(id)) newVisible.add(id)
      }

      set({ calendars: withOverlays, connected: true, visibleCalendarIds: newVisible })
    } catch (err) {
      console.error('Failed to fetch calendars:', err)
      const dbItems = await db.calendarList.toArray()
      if (dbItems.length > 0) {
        const overlayInfos = Object.values(get().overlaySources).map((s) => s.info)
        set({ calendars: [...(dbItems as CalendarInfo[]), ...overlayInfos], connected: false })
      }
    }
  },

  fetchEvents: async (start?: Date, end?: Date) => {
    const { calendars, currentDate, view } = get()
    if (calendars.length === 0) return

    set({ loading: true })

    const fallback = viewRange(currentDate, view)
    const rangeStart = start || fallback.start
    const rangeEnd = end || fallback.end
    const timeMin = rangeStart.toISOString()
    const timeMax = rangeEnd.toISOString()

    // Fetch ALL calendars, not just visible — visibility is a display filter only.
    // This ensures toggling a calendar visible instantly shows its events from IDB.
    // Skip synthetic overlay sources: they have no Google account, so a fetch
    // would hit the hub with a bogus account and error.
    const visibleCals = calendars.filter((c) => !c.synthetic)

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

      // Remove stale events: anything in IDB within the fetched range that
      // wasn't returned by the API (deleted/cancelled on GCal).
      // Protect events with pending queue actions (optimistic creates/updates).
      const pendingActions = await db.queue
        .where('status').anyOf('pending', 'processing')
        .filter((a) => a.type.startsWith('cal'))
        .toArray()
      const pendingKeys = new Set(pendingActions.map((a) => a.eventCompoundKey).filter(Boolean))
      for (const k of pendingTempIds.keys()) pendingKeys.add(k)

      const freshKeys = new Set(dbEvents.map((e) => e.compoundKey))
      const staleInRange = await db.calendarEvents
        .where('startTime')
        .between(timeMin, timeMax, true, true)
        .toArray()
      const staleKeys = staleInRange
        .filter((e) => !freshKeys.has(e.compoundKey) && !pendingKeys.has(e.compoundKey))
        .map((e) => e.compoundKey)
      if (staleKeys.length > 0) {
        await db.calendarEvents.bulkDelete(staleKeys)
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
    if (view === 'month') {
      get().navigateMonth(delta)
      return
    }
    const days = view === 'week' ? 7 * delta : delta
    const newDate = addDays(currentDate, days)
    set({ currentDate: newDate, selectedEventId: null })
    // Load from IDB immediately (prefetched data), then background refresh
    get().loadEventsFromDb()
    const r = viewRange(newDate, view)
    get().fetchEvents(r.start, r.end)
  },

  navigateMonth: (delta) => {
    const { currentDate } = get()
    const newDate = addMonths(currentDate, delta)
    set({ currentDate: newDate, selectedEventId: null })
    get().loadEventsFromDb()
    const r = viewRange(newDate, 'month')
    get().fetchEvents(r.start, r.end)
  },

  navigateToday: () => {
    const today = new Date()
    set({ currentDate: today, selectedEventId: null })
    get().loadEventsFromDb()
    const r = viewRange(today, get().view)
    get().fetchEvents(r.start, r.end)
  },

  navigateToDate: (date) => {
    set({ currentDate: date, selectedEventId: null })
    get().loadEventsFromDb()
    const r = viewRange(date, get().view)
    get().fetchEvents(r.start, r.end)
  },

  setView: (v) => {
    const prev = get().view
    set({ view: v })
    // Fetch range may differ between views (month covers 6 weeks vs week's 3).
    // Re-hydrate IDB-cached events for the new range immediately, then refresh.
    if (prev !== v) {
      get().loadEventsFromDb()
      const r = viewRange(get().currentDate, v)
      get().fetchEvents(r.start, r.end)
    }
  },
  selectEvent: (id) => set({ selectedEventId: id }),

  toggleCalendarVisibility: (calId) => {
    set((s) => {
      const next = new Set(s.visibleCalendarIds)
      if (next.has(calId)) next.delete(calId)
      else next.add(calId)
      setPref(VISIBLE_CAL_IDS_PREF, Array.from(next))
      return { visibleCalendarIds: next }
    })
    get().loadEventsFromDb()
  },

  setDefaultCalendar: (calId) => {
    set({ defaultCalendarId: calId })
    setPref(DEFAULT_CAL_PREF, calId)
  },

  // --- Overlay sources (read-only, in-memory, e.g. Meetup) ---

  registerOverlaySource: (id, info, events) => {
    set((s) => {
      const overlaySources = { ...s.overlaySources, [id]: { info: { ...info, synthetic: true }, events } }
      // Merge the synthetic info into `calendars` (dedupe by id) so colour
      // lookup + the sidebar toggle work. fetchCalendars re-derives this too.
      const calendars = [...s.calendars.filter((c) => c.id !== id), { ...info, synthetic: true }]
      // First time we've ever seen this source → default it visible (the user's
      // curated visibleIds pref predates the overlay, so its absence isn't an
      // opt-out). On every subsequent register we respect the live set, so a
      // later toggle-off sticks across reloads.
      const seen = getPref<string[]>(OVERLAY_SEEN_PREF, [])
      const next = new Set(s.visibleCalendarIds)
      if (!seen.includes(id)) {
        next.add(id)
        // Mark seen and persist visibility ATOMICALLY — both or neither. The old
        // code marked seen unconditionally but only persisted visibleIds when
        // prefs were loaded; at boot the register runs before initPrefs resolves,
        // so the overlay got recorded as "seen" while its visibility was never
        // saved. Next boot it was seen-but-absent-from-visibleIds → treated as an
        // intentional opt-out and its toggle silently vanished. Gating both on
        // isPrefsLoaded keeps them consistent; if prefs aren't ready we defer
        // marking seen (a later register once prefs load will do it).
        if (isPrefsLoaded()) {
          setPref(OVERLAY_SEEN_PREF, [...seen, id])
          setPref(VISIBLE_CAL_IDS_PREF, Array.from(next))
        }
      }
      return { overlaySources, calendars, visibleCalendarIds: next }
    })
    get().loadEventsFromDb()
  },

  unregisterOverlaySource: (id) => {
    set((s) => {
      const overlaySources = { ...s.overlaySources }
      delete overlaySources[id]
      return { overlaySources, calendars: s.calendars.filter((c) => c.id !== id) }
    })
    get().loadEventsFromDb()
  },

  // --- CRUD (optimistic: IDB first → enqueue → background sync) ---

  createEvent: async (calendarId, accountEmail, event) => {
    // Generate temp ID
    const tempId = `~${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    const ck = compoundKey(accountEmail, calendarId, tempId)
    const now = new Date().toISOString()

    const dbEvent: DbCalendarEvent = {
      id: tempId,
      calendarId,
      accountEmail,
      compoundKey: ck,
      summary: (event.summary as string) || '(No title)',
      description: event.description,
      location: event.location,
      startTime: event.start?.dateTime || event.start?.date || now,
      endTime: event.end?.dateTime || event.end?.date || now,
      allDay: !event.start?.dateTime && !!event.start?.date,
      status: 'confirmed',
      attendeesJson: event.attendees ? JSON.stringify(event.attendees) : undefined,
      htmlLink: '',
      eventType: event.eventType,
      workingLocationJson: event.workingLocationProperties ? JSON.stringify(event.workingLocationProperties) : undefined,
      remindersJson: event.reminders ? JSON.stringify(event.reminders) : undefined,
      created: now,
      updated: now,
    }

    pendingTempIds.set(ck, `${calendarId}:${accountEmail}`)
    await db.calendarEvents.put(dbEvent)
    await get().loadEventsFromDb()

    await enqueue('calCreate', {
      calendarId, accountEmail, event, tempCompoundKey: ck,
    }, { eventCompoundKey: ck })
  },

  updateEvent: async (calendarId, accountEmail, eventId, updates) => {
    const ck = compoundKey(accountEmail, calendarId, eventId)
    const existing = await db.calendarEvents.get(ck)
    if (!existing) return

    // Optimistic: merge updates into IDB
    const merged: DbCalendarEvent = { ...existing }
    if (updates.summary !== undefined) merged.summary = updates.summary || existing.summary
    if (updates.description !== undefined) merged.description = updates.description
    if (updates.location !== undefined) merged.location = updates.location
    if (updates.start) {
      merged.startTime = updates.start.dateTime || updates.start.date || existing.startTime
      merged.allDay = !updates.start.dateTime && !!updates.start.date
    }
    if (updates.end) {
      merged.endTime = updates.end.dateTime || updates.end.date || existing.endTime
    }
    if (updates.status) merged.status = updates.status
    if (updates.attendees) merged.attendeesJson = JSON.stringify(updates.attendees)
    if (updates.reminders) merged.remindersJson = JSON.stringify(updates.reminders)
    merged.updated = new Date().toISOString()

    await db.calendarEvents.put(merged)
    await get().loadEventsFromDb()

    await enqueue('calUpdate', {
      calendarId, accountEmail, eventId, updates, rollback: existing,
    }, { eventCompoundKey: ck })
  },

  deleteEvent: async (calendarId, accountEmail, eventId) => {
    const ck = compoundKey(accountEmail, calendarId, eventId)
    const existing = await db.calendarEvents.get(ck)

    // Optimistic delete
    optimisticallyDeleted.add(ck)
    set((s) => ({ events: s.events.filter((e) => compoundKey(e.accountEmail, e.calendarId, e.id) !== ck) }))

    // Undo toast
    useUiStore.getState().setUndoAction({
      label: 'Deleted',
      expiresAt: Date.now() + 5000,
      undo: async () => {
        optimisticallyDeleted.delete(ck)
        if (existing) await db.calendarEvents.put(existing)
        await removeByEvent(ck, 'calDelete')
        await get().loadEventsFromDb()
      },
    })

    // Background: persist + enqueue
    const bg = async () => {
      await db.calendarEvents.delete(ck)
      optimisticallyDeleted.delete(ck)
      await enqueue('calDelete', {
        calendarId, accountEmail, eventId, rollback: existing,
      }, { eventCompoundKey: ck })
    }
    bg().catch(() => {})
  },

  rsvp: async (calendarId, accountEmail, eventId, status) => {
    const ck = compoundKey(accountEmail, calendarId, eventId)
    const existing = await db.calendarEvents.get(ck)
    if (!existing) return

    // Optimistic: update attendees locally
    const event = fromDbEvent(existing)
    const attendees = event.attendees?.map((a) =>
      a.self ? { ...a, responseStatus: status } : a
    )
    await db.calendarEvents.put({ ...existing, attendeesJson: attendees ? JSON.stringify(attendees) : existing.attendeesJson })
    await get().loadEventsFromDb()

    await enqueue('calRsvp', {
      calendarId, accountEmail, eventId, attendees,
    }, { eventCompoundKey: ck })
  },

  setReminder: async (calendarId, accountEmail, eventId, minutes) => {
    const ck = compoundKey(accountEmail, calendarId, eventId)
    const existing = await db.calendarEvents.get(ck)

    // Optimistic: update reminders locally
    const reminders = minutes === null
      ? { useDefault: false, overrides: [] as Array<{ method: string; minutes: number }> }
      : { useDefault: false, overrides: [{ method: 'popup', minutes }] }
    if (existing) {
      await db.calendarEvents.put({ ...existing, remindersJson: JSON.stringify(reminders) })
      await get().loadEventsFromDb()
    }

    await enqueue('calReminder', {
      calendarId, accountEmail, eventId, minutes,
    }, { eventCompoundKey: ck })
  },

  updateLocation: async (calendarId, accountEmail, eventId, locationType, customLabel) => {
    const oldCk = compoundKey(accountEmail, calendarId, eventId)
    const existing = await db.calendarEvents.get(oldCk)

    const props: CalendarEvent['workingLocationProperties'] =
      locationType === 'homeOffice' ? { type: 'homeOffice' }
      : locationType === 'officeLocation' ? { type: 'officeLocation', officeLocation: { label: customLabel } }
      : { type: 'customLocation', customLocation: { label: customLabel || '' } }

    const summary =
      locationType === 'homeOffice' ? 'Home'
      : locationType === 'officeLocation' ? (customLabel || 'Office')
      : (customLabel || '')

    // Optimistic: delete old, create new with temp ID
    optimisticallyDeleted.add(oldCk)
    await db.calendarEvents.delete(oldCk)

    const tempId = `~${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    const tempCk = compoundKey(accountEmail, calendarId, tempId)
    const now = new Date().toISOString()

    const newEventData: Partial<CalendarEvent> = {
      summary,
      start: existing ? fromDbEvent(existing).start : { date: now.split('T')[0] },
      end: existing ? fromDbEvent(existing).end : { date: now.split('T')[0] },
      eventType: 'workingLocation',
      transparency: 'transparent',
      visibility: 'public',
      workingLocationProperties: props,
    }

    const dbEvent: DbCalendarEvent = {
      id: tempId,
      calendarId,
      accountEmail,
      compoundKey: tempCk,
      summary,
      startTime: (newEventData.start?.dateTime || newEventData.start?.date || now),
      endTime: (newEventData.end?.dateTime || newEventData.end?.date || now),
      allDay: !newEventData.start?.dateTime && !!newEventData.start?.date,
      status: 'confirmed',
      htmlLink: '',
      eventType: 'workingLocation',
      workingLocationJson: JSON.stringify(props),
      created: now,
      updated: now,
    }

    pendingTempIds.set(tempCk, `${calendarId}:${accountEmail}`)
    await db.calendarEvents.put(dbEvent)
    await get().loadEventsFromDb()

    await enqueue('calLocation', {
      calendarId, accountEmail, oldEventId: eventId, tempCompoundKey: tempCk, newEventData,
    }, { eventCompoundKey: tempCk })
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

    let rangeStart: Date
    let rangeEnd: Date
    if (view === 'month') {
      const firstOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1)
      rangeStart = addDays(weekStart(firstOfMonth), -1)
      rangeEnd = addDays(weekStart(firstOfMonth), 43)
    } else if (view === 'week') {
      rangeStart = addDays(weekStart(currentDate), -1)
      rangeEnd = addDays(weekEnd(currentDate), 1)
    } else {
      rangeStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate())
      rangeEnd = addDays(currentDate, 1)
    }

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
      if (!seen.has(e.compoundKey) && visibleCalendarIds.has(e.calendarId) && !optimisticallyDeleted.has(e.compoundKey)) {
        seen.add(e.compoundKey)
        merged.push(e)
      }
    }

    merged.sort((a, b) => a.startTime.localeCompare(b.startTime))
    const events: CalendarEvent[] = merged.map(fromDbEvent)

    // Merge read-only overlay events (e.g. Meetup) — in-memory, never persisted,
    // never touched by stale-range cleanup or Google sync. Filtered to the same
    // range + visibility as the Dexie-backed events. Always timed (the source
    // adapter guarantees start.dateTime/end.dateTime).
    const { overlaySources } = get()
    for (const { events: overlayEvents } of Object.values(overlaySources)) {
      for (const ev of overlayEvents) {
        if (!visibleCalendarIds.has(ev.calendarId)) continue
        const start = ev.start.dateTime || ev.start.date
        if (!start || start < startStr || start > endStr) continue
        events.push(ev)
      }
    }
    events.sort((a, b) => (a.start.dateTime || a.start.date || '').localeCompare(b.start.dateTime || b.start.date || ''))

    set({ events })
  },
}))
