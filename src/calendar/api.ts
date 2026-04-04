// ============================================================================
// Google Calendar REST API wrapper
// Multi-account: each call takes accountEmail to route to the right token
// ============================================================================

import { getTokenForAccount } from './accounts'
import type {
  CalendarListResponse,
  CalendarEvent,
  EventsListResponse,
} from './types'

const BASE = 'https://www.googleapis.com/calendar/v3'

async function request<T>(
  accountEmail: string,
  path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string> } = {},
): Promise<T> {
  const token = await getTokenForAccount(accountEmail)
  if (!token) {
    throw new Error(`No token for account ${accountEmail}. Please re-authenticate.`)
  }

  const url = new URL(`${BASE}${path}`)
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      url.searchParams.set(k, v)
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  const body = opts.body ? JSON.stringify(opts.body) : undefined

  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers,
    body,
  })

  if (!res.ok) {
    if (res.status === 401) {
      // Try refreshing this account's token and retry once
      const { refreshCalendarToken } = await import('./accounts')
      const refreshed = await refreshCalendarToken(accountEmail)
      if (refreshed) {
        const newToken = await getTokenForAccount(accountEmail)
        if (newToken) {
          const retryRes = await fetch(url.toString(), {
            method: opts.method ?? 'GET',
            headers: { ...headers, Authorization: `Bearer ${newToken}` },
            body,
          })
          if (retryRes.ok) {
            if (retryRes.status === 204) return undefined as T
            return retryRes.json() as Promise<T>
          }
        }
      }
      throw new Error(`Auth failed for ${accountEmail}. Please re-authenticate.`)
    }
    const text = await res.text()
    throw new Error(`Calendar API ${res.status}: ${text}`)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// --------------------------------------------------------------------------
// Calendar List
// --------------------------------------------------------------------------

export async function getCalendarList(accountEmail: string): Promise<CalendarListResponse> {
  return request<CalendarListResponse>(accountEmail, '/users/me/calendarList')
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
  const params: Record<string, string> = {
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  }

  if (syncToken) {
    params.syncToken = syncToken
  } else {
    params.timeMin = timeMin
    params.timeMax = timeMax
  }

  return request<EventsListResponse>(
    accountEmail,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { params },
  )
}

export async function getEvent(
  accountEmail: string,
  calendarId: string,
  eventId: string,
): Promise<CalendarEvent> {
  return request<CalendarEvent>(
    accountEmail,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  )
}

export async function createEvent(
  accountEmail: string,
  calendarId: string,
  event: Partial<CalendarEvent>,
): Promise<CalendarEvent> {
  return request<CalendarEvent>(
    accountEmail,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: 'POST', body: event },
  )
}

export async function updateEvent(
  accountEmail: string,
  calendarId: string,
  eventId: string,
  updates: Partial<CalendarEvent>,
): Promise<CalendarEvent> {
  return request<CalendarEvent>(
    accountEmail,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PUT', body: updates },
  )
}

export async function patchEvent(
  accountEmail: string,
  calendarId: string,
  eventId: string,
  updates: Partial<CalendarEvent>,
): Promise<CalendarEvent> {
  return request<CalendarEvent>(
    accountEmail,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', body: updates },
  )
}

export async function deleteEvent(
  accountEmail: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  await request<void>(
    accountEmail,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' },
  )
}
