// Calendar proxy routes — proxies Google Calendar API calls with hub-managed tokens

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CalendarClient } from '../calendar-client.js'
import type { AuthStore } from '../auth-store.js'
import type { DedupStore } from '../dedup-store.js'

export function handleCalendarRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  calendar: CalendarClient,
  authStore: AuthStore,
  readBody: (req: IncomingMessage) => Promise<string>,
  createDedup?: DedupStore,
): boolean {
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  const error = (status: number, message: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: message }))
  }

  const handleAsync = (fn: () => Promise<void>) => {
    fn().catch((err: Error) => {
      const status = (err as any).status || 500
      error(status, err.message)
    })
    return true
  }

  // Default account
  const account = url.searchParams.get('account') || authStore.getPrimaryGoogleAccount()?.email || ''

  // GET /cal/calendars
  if (path === '/cal/calendars' && req.method === 'GET') {
    return handleAsync(async () => {
      const requestedAccount = url.searchParams.get('account')
      const accounts = requestedAccount
        ? authStore.getGoogleAccounts().filter((a) => a.email === requestedAccount)
        : authStore.getGoogleAccounts()
      const allCalendars: unknown[] = []

      for (const acc of accounts) {
        try {
          const result = await calendar.getCalendarList(acc.email)
          for (const cal of result.items || []) {
            allCalendars.push({ ...cal, accountEmail: acc.email })
          }
        } catch (err) {
          console.error(`[cal] Failed to fetch calendars for ${acc.email}:`, (err as Error).message)
        }
      }

      json(allCalendars)
    })
  }

  // GET /cal/events
  if (path === '/cal/events' && req.method === 'GET') {
    return handleAsync(async () => {
      const calendarId = url.searchParams.get('calendarId')
      const timeMin = url.searchParams.get('timeMin') || new Date().toISOString()
      const timeMax = url.searchParams.get('timeMax')
      const singleEvents = url.searchParams.get('singleEvents') ?? 'true'

      if (calendarId) {
        // Fetch events for specific calendar
        const data = await calendar.getEvents(account, calendarId, { timeMin, timeMax: timeMax || undefined, singleEvents })
        json(data)
      } else {
        // Fetch events for all calendars across all accounts
        const accounts = authStore.getGoogleAccounts()
        const allEvents: unknown[] = []

        for (const acc of accounts) {
          try {
            const calendars = await calendar.getCalendarList(acc.email)
            for (const cal of calendars.items || []) {
              try {
                const events = await calendar.getEvents(acc.email, cal.id, {
                  timeMin,
                  timeMax: timeMax || undefined,
                  singleEvents,
                }) as any
                for (const event of events.items || []) {
                  allEvents.push({ ...event, calendarId: cal.id, accountEmail: acc.email })
                }
              } catch { /* skip individual calendar errors */ }
            }
          } catch { /* skip account errors */ }
        }

        json({ items: allEvents })
      }
    })
  }

  // GET /cal/events/:id
  const eventGetMatch = path.match(/^\/cal\/events\/([^/]+)$/)
  if (eventGetMatch && req.method === 'GET') {
    return handleAsync(async () => {
      const calendarId = url.searchParams.get('calendarId')
      if (!calendarId) { error(400, 'Missing calendarId'); return }
      const data = await calendar.getEvent(account, calendarId, decodeURIComponent(eventGetMatch[1]!))
      json(data)
    })
  }

  // POST /cal/events
  // Optional `clientToken`: offline-outbox idempotency — replaying a queued
  // create with the same token returns the recorded event, not a duplicate.
  if (path === '/cal/events' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req))
      const calendarId = body.calendarId
      const acc = body.account || account
      const clientToken = typeof body.clientToken === 'string' ? body.clientToken : undefined
      delete body.calendarId
      delete body.account
      delete body.clientToken
      const data = createDedup
        ? await createDedup.once(clientToken, () => calendar.createEvent(acc, calendarId, body))
        : await calendar.createEvent(acc, calendarId, body)
      json(data)
    })
  }

  // PATCH /cal/events/:id
  const eventPatchMatch = path.match(/^\/cal\/events\/([^/]+)$/)
  if (eventPatchMatch && req.method === 'PATCH') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req))
      const calendarId = body.calendarId
      const acc = body.account || account
      delete body.calendarId
      delete body.account
      const data = await calendar.patchEvent(acc, calendarId, decodeURIComponent(eventPatchMatch[1]!), body)
      json(data)
    })
  }

  // DELETE /cal/events/:id
  const eventDeleteMatch = path.match(/^\/cal\/events\/([^/]+)$/)
  if (eventDeleteMatch && req.method === 'DELETE') {
    return handleAsync(async () => {
      const calendarId = url.searchParams.get('calendarId')
      if (!calendarId) { error(400, 'Missing calendarId'); return }
      await calendar.deleteEvent(account, calendarId, decodeURIComponent(eventDeleteMatch[1]!))
      json({ ok: true })
    })
  }

  // POST /cal/events/:id/rsvp
  const rsvpMatch = path.match(/^\/cal\/events\/([^/]+)\/rsvp$/)
  if (rsvpMatch && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req))
      const calendarId = body.calendarId
      const acc = body.account || account
      const status = body.status // accept, maybe, decline

      // Map to Google's attendee status
      const responseStatus = status === 'accept' ? 'accepted'
        : status === 'maybe' ? 'tentative'
        : status === 'decline' ? 'declined'
        : status

      // Get current event to find attendee list
      const event = await calendar.getEvent(acc, calendarId, decodeURIComponent(rsvpMatch[1]!)) as any
      const attendees = (event.attendees || []).map((a: any) => {
        if (a.self || a.email === acc) {
          return { ...a, responseStatus }
        }
        return a
      })

      const data = await calendar.patchEvent(acc, calendarId, decodeURIComponent(rsvpMatch[1]!), { attendees })
      json(data)
    })
  }

  // POST /cal/location
  if (path === '/cal/location' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req))
      const acc = body.account || account
      const { date, type, label } = body

      // Working location uses the primary calendar
      const calendarId = acc

      // Build working location properties
      const workingLocationProperties: Record<string, unknown> = { type }
      if (type === 'officeLocation' && label) {
        workingLocationProperties.officeLocation = { label }
      } else if (type === 'customLocation' && label) {
        workingLocationProperties.customLocation = { label }
      }

      // Working location events: delete existing + create new (Google rejects PATCH on recurring instances)
      // First try to find existing working location for this date
      const events = await calendar.getEvents(acc, calendarId, {
        timeMin: `${date}T00:00:00Z`,
        timeMax: `${date}T23:59:59Z`,
        singleEvents: 'true',
      }) as any

      for (const event of events.items || []) {
        if (event.eventType === 'workingLocation') {
          try {
            await calendar.deleteEvent(acc, calendarId, event.id)
          } catch { /* ignore delete failures */ }
        }
      }

      // Create new
      const newEvent = {
        summary: type === 'homeOffice' ? 'Home' : type === 'officeLocation' ? (label || 'Office') : (label || 'Custom'),
        start: { date },
        end: { date },
        eventType: 'workingLocation',
        visibility: 'public',
        transparency: 'transparent',
        workingLocationProperties,
      }

      const data = await calendar.createEvent(acc, calendarId, newEvent)
      json(data)
    })
  }

  // GET /cal/accounts
  if (path === '/cal/accounts' && req.method === 'GET') {
    const accounts = authStore.getGoogleAccounts().map((a) => ({
      email: a.email,
      isPrimary: a.isPrimary ?? false,
    }))
    json(accounts)
    return true
  }

  // POST /cal/accounts/add — redirect to OAuth flow
  if (path === '/cal/accounts/add' && req.method === 'POST') {
    // The auth/google/start endpoint handles this
    json({ redirect: '/auth/google/start' })
    return true
  }

  // DELETE /cal/accounts/:email
  const removeAccMatch = path.match(/^\/cal\/accounts\/([^/]+)$/)
  if (removeAccMatch && req.method === 'DELETE') {
    authStore.removeGoogleAccount(decodeURIComponent(removeAccMatch[1]!))
    json({ ok: true })
    return true
  }

  return false
}
