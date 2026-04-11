// ============================================================================
// Google Calendar API — proxied through hub server
// All calls go through the hub which handles tokens server-side.
// ============================================================================

import { hubFetch } from '@/hub'
import type {
  CalendarListResponse,
  CalendarEvent,
  EventsListResponse,
} from './types'

// --------------------------------------------------------------------------
// Calendar List
// --------------------------------------------------------------------------

export async function getCalendarList(accountEmail: string): Promise<CalendarListResponse> {
  const calendars = await hubFetch<any[]>(`/cal/calendars?account=${encodeURIComponent(accountEmail)}`)
  return { kind: 'calendar#calendarList', items: calendars }
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------

export async function getEvents(
  accountEmail: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
  syncToken?: string,
): Promise<EventsListResponse> {
  const params = new URLSearchParams({
    account: accountEmail,
    calendarId,
    singleEvents: 'true',
  })
  if (syncToken) {
    params.set('syncToken', syncToken)
  } else {
    params.set('timeMin', timeMin)
    params.set('timeMax', timeMax)
  }
  return hubFetch<EventsListResponse>(`/cal/events?${params}`)
}

export async function getEvent(
  accountEmail: string,
  calendarId: string,
  eventId: string,
): Promise<CalendarEvent> {
  const params = new URLSearchParams({
    account: accountEmail,
    calendarId,
  })
  return hubFetch<CalendarEvent>(`/cal/events/${encodeURIComponent(eventId)}?${params}`)
}

export async function createEvent(
  accountEmail: string,
  calendarId: string,
  event: Partial<CalendarEvent>,
): Promise<CalendarEvent> {
  return hubFetch<CalendarEvent>('/cal/events', {
    method: 'POST',
    body: JSON.stringify({ ...event, calendarId, account: accountEmail }),
  })
}

export async function updateEvent(
  accountEmail: string,
  calendarId: string,
  eventId: string,
  updates: Partial<CalendarEvent>,
): Promise<CalendarEvent> {
  return hubFetch<CalendarEvent>(`/cal/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...updates, calendarId, account: accountEmail }),
  })
}

export async function patchEvent(
  accountEmail: string,
  calendarId: string,
  eventId: string,
  updates: Partial<CalendarEvent>,
): Promise<CalendarEvent> {
  return hubFetch<CalendarEvent>(`/cal/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...updates, calendarId, account: accountEmail }),
  })
}

export async function deleteEvent(
  accountEmail: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  await hubFetch<void>(`/cal/events/${encodeURIComponent(eventId)}?calendarId=${encodeURIComponent(calendarId)}&account=${encodeURIComponent(accountEmail)}`, {
    method: 'DELETE',
  })
}
