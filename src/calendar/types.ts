// ============================================================================
// Google Calendar API Types
// ============================================================================

export interface CalendarInfo {
  id: string                    // e.g., "primary", "user@gmail.com", shared cal ID
  summary: string               // display name
  backgroundColor: string       // hex color from Google
  foregroundColor: string
  selected: boolean             // user's visibility preference
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader'
  primary?: boolean
  timeZone?: string
  accountEmail: string          // which Google account owns this calendar
}

export interface CalendarEventTime {
  dateTime?: string     // ISO 8601 for timed events
  date?: string         // YYYY-MM-DD for all-day events
  timeZone?: string
}

export interface CalendarAttendee {
  email: string
  displayName?: string
  self?: boolean
  responseStatus: 'needsAction' | 'declined' | 'tentative' | 'accepted'
  organizer?: boolean
}

export interface CalendarEvent {
  id: string
  calendarId: string
  accountEmail: string
  summary: string
  description?: string
  location?: string
  start: CalendarEventTime
  end: CalendarEventTime
  status: 'confirmed' | 'tentative' | 'cancelled'
  attendees?: CalendarAttendee[]
  organizer?: { email: string; displayName?: string; self?: boolean }
  creator?: { email: string; displayName?: string }
  colorId?: string
  recurringEventId?: string
  htmlLink: string
  hangoutLink?: string
  conferenceData?: {
    entryPoints?: Array<{ entryPointType: string; uri: string; label?: string }>
  }
  reminders?: {
    useDefault: boolean
    overrides?: Array<{ method: string; minutes: number }>
  }
  transparency?: string
  visibility?: string
  eventType?: 'default' | 'outOfOffice' | 'focusTime' | 'workingLocation'
  workingLocationProperties?: {
    type: 'homeOffice' | 'officeLocation' | 'customLocation'
    officeLocation?: { buildingId?: string; floorId?: string; label?: string }
    customLocation?: { label: string }
  }
  created: string
  updated: string
}

// Google Calendar API response shapes
export interface CalendarListResponse {
  kind: string
  items: CalendarInfo[]
  nextSyncToken?: string
}

export interface EventsListResponse {
  kind: string
  items: CalendarEvent[]
  nextPageToken?: string
  nextSyncToken?: string
}

// IndexedDB types
export interface DbCalendarInfo {
  id: string
  accountEmail: string
  summary: string
  backgroundColor: string
  foregroundColor: string
  selected: boolean
  accessRole: string
  primary?: boolean
  timeZone?: string
}

export interface DbCalendarEvent {
  id: string
  calendarId: string
  accountEmail: string
  compoundKey: string    // `${accountEmail}:${calendarId}:${id}` for unique indexing
  summary: string
  description?: string
  location?: string
  startTime: string      // ISO string for indexing (dateTime or date)
  endTime: string
  allDay: boolean
  status: string
  attendeesJson?: string // JSON-serialized attendees
  organizerEmail?: string
  organizerName?: string
  colorId?: string
  recurringEventId?: string
  htmlLink: string
  hangoutLink?: string
  conferenceDataJson?: string
  eventType?: string
  workingLocationJson?: string
  created: string
  updated: string
}
