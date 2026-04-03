// ============================================================================
// Google Calendar REST API wrapper
// Same pattern as src/gmail/api.ts — Bearer token, auto-refresh on 401
// ============================================================================

import { getAccessToken, notifyAuthExpired, refreshAccessToken } from '@/gmail/auth'
import type {
  CalendarListResponse,
  CalendarEvent,
  EventsListResponse,
} from './types'

const BASE = 'https://www.googleapis.com/calendar/v3'

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string> } = {},
): Promise<T> {
  const token = await getAccessToken()
  if (!token) {
    notifyAuthExpired()
    throw new Error('Session expired. Please sign in again.')
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
      const refreshed = await refreshAccessToken()
      if (refreshed) {
        const newToken = await getAccessToken()
        if (newToken) {
          const retryRes = await fetch(url.toString(), {
            method: opts.method ?? 'GET',
            headers: { ...headers, Authorization: `Bearer ${newToken}` },
            body,
          })
          if (retryRes.ok) {
            return retryRes.json() as Promise<T>
          }
        }
      }
      notifyAuthExpired()
      throw new Error('Session expired. Please sign in again.')
    }
    const text = await res.text()
    throw new Error(`Calendar API ${res.status}: ${text}`)
  }

  // DELETE returns 204 No Content
  if (res.status === 204) return undefined as T

  return res.json() as Promise<T>
}

// --------------------------------------------------------------------------
// Calendar List
// --------------------------------------------------------------------------

export async function getCalendarList(): Promise<CalendarListResponse> {
  return request<CalendarListResponse>('/users/me/calendarList')
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------

export async function getEvents(
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
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { params },
  )
}

export async function getEvent(
  calendarId: string,
  eventId: string,
): Promise<CalendarEvent> {
  return request<CalendarEvent>(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  )
}

export async function createEvent(
  calendarId: string,
  event: Partial<CalendarEvent>,
): Promise<CalendarEvent> {
  return request<CalendarEvent>(
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: 'POST', body: event },
  )
}

export async function updateEvent(
  calendarId: string,
  eventId: string,
  updates: Partial<CalendarEvent>,
): Promise<CalendarEvent> {
  return request<CalendarEvent>(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PUT', body: updates },
  )
}

export async function patchEvent(
  calendarId: string,
  eventId: string,
  updates: Partial<CalendarEvent>,
): Promise<CalendarEvent> {
  return request<CalendarEvent>(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', body: updates },
  )
}

export async function deleteEvent(
  calendarId: string,
  eventId: string,
): Promise<void> {
  await request<void>(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' },
  )
}
