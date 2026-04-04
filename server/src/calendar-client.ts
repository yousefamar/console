// Google Calendar REST API client — server-side port of src/calendar/api.ts

import type { AuthStore } from './auth-store.js'

const CAL_BASE = 'https://www.googleapis.com/calendar/v3'

export class CalendarClient {
  constructor(private authStore: AuthStore) {}

  private async request<T>(
    accountEmail: string,
    path: string,
    opts: { method?: string; body?: unknown; params?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const token = await this.authStore.getGoogleToken(accountEmail)
    if (!token) {
      throw new CalendarApiError(401, `No token for account ${accountEmail}`)
    }

    const url = new URL(`${CAL_BASE}${path}`)
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        if (v !== undefined) url.searchParams.set(k, v)
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
    const body = opts.body ? JSON.stringify(opts.body) : undefined

    let res = await fetch(url.toString(), { method: opts.method ?? 'GET', headers, body })

    // Auto-refresh on 401
    if (res.status === 401) {
      const refreshed = await this.authStore.refreshGoogleToken(accountEmail)
      if (refreshed) {
        const newToken = await this.authStore.getGoogleToken(accountEmail)
        if (newToken) {
          res = await fetch(url.toString(), {
            method: opts.method ?? 'GET',
            headers: { ...headers, Authorization: `Bearer ${newToken}` },
            body,
          })
        }
      }
    }

    if (!res.ok) {
      if (res.status === 204) return undefined as T
      const text = await res.text()
      throw new CalendarApiError(res.status, `Calendar API ${res.status}: ${text}`)
    }

    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (!text) return {} as T
    return JSON.parse(text) as T
  }

  // -------------------------------------------------------------------------
  // Calendar List
  // -------------------------------------------------------------------------

  async getCalendarList(accountEmail: string) {
    return this.request<{
      items: Array<{
        id: string
        summary: string
        backgroundColor: string
        foregroundColor: string
        primary?: boolean
        accessRole: string
        selected?: boolean
      }>
    }>(accountEmail, '/users/me/calendarList')
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  async getEvents(accountEmail: string, calendarId: string, opts: {
    timeMin?: string
    timeMax?: string
    singleEvents?: string
    maxResults?: string
  } = {}) {
    return this.request(accountEmail, `/calendars/${encodeURIComponent(calendarId)}/events`, {
      params: {
        singleEvents: opts.singleEvents ?? 'true',
        orderBy: 'startTime',
        maxResults: opts.maxResults ?? '250',
        timeMin: opts.timeMin,
        timeMax: opts.timeMax,
      },
    })
  }

  async getEvent(accountEmail: string, calendarId: string, eventId: string) {
    return this.request(accountEmail, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`)
  }

  async createEvent(accountEmail: string, calendarId: string, event: unknown) {
    return this.request(accountEmail, `/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      body: event,
    })
  }

  async patchEvent(accountEmail: string, calendarId: string, eventId: string, updates: unknown) {
    return this.request(accountEmail, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      body: updates,
    })
  }

  async deleteEvent(accountEmail: string, calendarId: string, eventId: string) {
    return this.request<void>(accountEmail, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
    })
  }
}

class CalendarApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'CalendarApiError'
  }
}
