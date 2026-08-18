// Calendar offline sync queue processor
// Drains pending calendar actions from the shared sync queue.

import { db } from '@/db'
import { markProcessing, markDone, markFailed } from '@/db/sync-queue'
import * as api from './api'
import { truncateRecurrence } from './recurrence'
import type { CalendarEvent } from './types'

// Shared state — also used by store/calendar.ts
export const optimisticallyDeleted = new Set<string>() // compound keys
export const pendingTempIds = new Map<string, string>() // tempCompoundKey → calendarId:accountEmail

let lock = false

export async function processCalendarQueue(): Promise<void> {
  if (lock) return
  lock = true

  try {
    const pending = await db.queue
      .where('status')
      .anyOf('pending', 'processing')
      .filter((a) => a.type.startsWith('cal'))
      .sortBy('createdAt')

    for (const action of pending) {
      if (!action.id) continue
      await markProcessing(action.id)

      try {
        const p = action.payload
        switch (action.type) {
          case 'calCreate': {
            const created = await api.createEvent(
              p.accountEmail as string,
              p.calendarId as string,
              p.event as Partial<CalendarEvent>,
              p.tempCompoundKey as string | undefined,
            )
            // Replace temp compound key with real one
            const tempCk = p.tempCompoundKey as string
            if (tempCk) {
              await db.calendarEvents.delete(tempCk)
              pendingTempIds.delete(tempCk)
            }
            const realCk = `${p.accountEmail}:${p.calendarId}:${created.id}`
            await db.calendarEvents.put({
              id: created.id,
              calendarId: p.calendarId as string,
              accountEmail: p.accountEmail as string,
              compoundKey: realCk,
              summary: created.summary || '(No title)',
              description: created.description,
              location: created.location,
              startTime: created.start.dateTime || created.start.date || '',
              endTime: created.end.dateTime || created.end.date || '',
              allDay: !created.start.dateTime && !!created.start.date,
              status: created.status,
              attendeesJson: created.attendees ? JSON.stringify(created.attendees) : undefined,
              organizerEmail: created.organizer?.email,
              organizerName: created.organizer?.displayName,
              colorId: created.colorId,
              recurringEventId: created.recurringEventId,
              htmlLink: created.htmlLink || '',
              hangoutLink: created.hangoutLink,
              conferenceDataJson: created.conferenceData ? JSON.stringify(created.conferenceData) : undefined,
              eventType: created.eventType,
              workingLocationJson: created.workingLocationProperties ? JSON.stringify(created.workingLocationProperties) : undefined,
              remindersJson: created.reminders ? JSON.stringify(created.reminders) : undefined,
              created: created.created || new Date().toISOString(),
              updated: created.updated || new Date().toISOString(),
            })
            reloadEvents()
            break
          }

          case 'calUpdate': {
            const updated = await api.patchEvent(
              p.accountEmail as string,
              p.calendarId as string,
              p.eventId as string,
              p.updates as Partial<CalendarEvent>,
            )
            // Write authoritative response to IDB
            const ck = `${p.accountEmail}:${p.calendarId}:${p.eventId}`
            const existing = await db.calendarEvents.get(ck)
            if (existing) {
              await db.calendarEvents.put({
                ...existing,
                summary: updated.summary || existing.summary,
                description: updated.description,
                location: updated.location,
                startTime: updated.start?.dateTime || updated.start?.date || existing.startTime,
                endTime: updated.end?.dateTime || updated.end?.date || existing.endTime,
                allDay: updated.start ? (!updated.start.dateTime && !!updated.start.date) : existing.allDay,
                status: updated.status || existing.status,
                attendeesJson: updated.attendees ? JSON.stringify(updated.attendees) : existing.attendeesJson,
                remindersJson: updated.reminders ? JSON.stringify(updated.reminders) : existing.remindersJson,
                updated: updated.updated || new Date().toISOString(),
              })
            }
            reloadEvents()
            break
          }

          case 'calDelete': {
            await api.deleteEvent(
              p.accountEmail as string,
              p.calendarId as string,
              p.eventId as string,
            )
            const ck = action.eventCompoundKey
            if (ck) optimisticallyDeleted.delete(ck)
            break
          }

          case 'calDeleteFollowing': {
            const acc = p.accountEmail as string
            const calId = p.calendarId as string
            const masterId = p.masterEventId as string
            const fromStart = p.fromStart as string | null
            if (fromStart === null) {
              // "All events" — deleting the master removes the whole series.
              await api.deleteEvent(acc, calId, masterId)
            } else {
              const master = await api.getEvent(acc, calId, masterId)
              const masterStart = master.start.dateTime || master.start.date || ''
              if (!master.recurrence?.length || masterStart >= fromStart) {
                // Cutting at (or before) the first instance = the whole series.
                await api.deleteEvent(acc, calId, masterId)
              } else {
                await api.patchEvent(acc, calId, masterId, {
                  recurrence: truncateRecurrence(master.recurrence, fromStart),
                })
              }
            }
            break
          }

          case 'calRsvp': {
            const result = await api.patchEvent(
              p.accountEmail as string,
              p.calendarId as string,
              p.eventId as string,
              { attendees: p.attendees as CalendarEvent['attendees'] },
            )
            const ck = `${p.accountEmail}:${p.calendarId}:${p.eventId}`
            const existing = await db.calendarEvents.get(ck)
            if (existing) {
              await db.calendarEvents.put({
                ...existing,
                attendeesJson: result.attendees ? JSON.stringify(result.attendees) : existing.attendeesJson,
              })
            }
            break
          }

          case 'calReminder': {
            const minutes = p.minutes as number | null
            const reminders = minutes === null
              ? { useDefault: true }
              : { useDefault: false, overrides: [{ method: 'popup' as const, minutes }] }
            const result = await api.patchEvent(
              p.accountEmail as string,
              p.calendarId as string,
              p.eventId as string,
              { reminders },
            )
            const ck = `${p.accountEmail}:${p.calendarId}:${p.eventId}`
            const existing = await db.calendarEvents.get(ck)
            if (existing) {
              await db.calendarEvents.put({
                ...existing,
                remindersJson: result.reminders ? JSON.stringify(result.reminders) : undefined,
              })
            }
            break
          }

          case 'calLocation': {
            // Delete old event
            if (p.oldEventId) {
              try {
                await api.deleteEvent(
                  p.accountEmail as string,
                  p.calendarId as string,
                  p.oldEventId as string,
                )
              } catch {
                // Old event may already be gone
              }
              const oldCk = `${p.accountEmail}:${p.calendarId}:${p.oldEventId}`
              optimisticallyDeleted.delete(oldCk)
            }
            // Create new event
            const created = await api.createEvent(
              p.accountEmail as string,
              p.calendarId as string,
              p.newEventData as Partial<CalendarEvent>,
              p.tempCompoundKey as string | undefined,
            )
            // Replace temp with real
            const tempCk = p.tempCompoundKey as string
            if (tempCk) {
              await db.calendarEvents.delete(tempCk)
              pendingTempIds.delete(tempCk)
            }
            const realCk = `${p.accountEmail}:${p.calendarId}:${created.id}`
            await db.calendarEvents.put({
              id: created.id,
              calendarId: p.calendarId as string,
              accountEmail: p.accountEmail as string,
              compoundKey: realCk,
              summary: created.summary || '',
              startTime: created.start.dateTime || created.start.date || '',
              endTime: created.end.dateTime || created.end.date || '',
              allDay: !created.start.dateTime && !!created.start.date,
              status: created.status || 'confirmed',
              htmlLink: created.htmlLink || '',
              eventType: created.eventType,
              workingLocationJson: created.workingLocationProperties ? JSON.stringify(created.workingLocationProperties) : undefined,
              created: created.created || new Date().toISOString(),
              updated: created.updated || new Date().toISOString(),
            })
            reloadEvents()
            break
          }
        }

        await markDone(action.id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        await markFailed(action.id, msg)

        // On permanent failure (retryCount >= 3), restore rollback data
        const failed = await db.queue.get(action.id)
        if (failed?.status === 'failed') {
          const p = action.payload
          if (action.type === 'calUpdate' && p.rollback) {
            await db.calendarEvents.put(p.rollback as any)
            reloadEvents()
          }
          if (action.type === 'calDelete' && p.rollback) {
            const ck = action.eventCompoundKey
            if (ck) optimisticallyDeleted.delete(ck)
            await db.calendarEvents.put(p.rollback as any)
            reloadEvents()
          }
          if (action.type === 'calDeleteFollowing' && Array.isArray(p.rollback)) {
            await db.calendarEvents.bulkPut(p.rollback as any[])
            reloadEvents()
          }
          // A create/move has no rollback — the local row IS the only copy of
          // what the user typed. It stays in IDB (fetchEvents refuses to reap
          // temp ids), but say so loudly: silence here read as "saved".
          if (action.type === 'calCreate' || action.type === 'calLocation') {
            const title = (p.event as any)?.summary || (p.newEventData as any)?.summary || '(No title)'
            notifyFailure(`Couldn't save "${title}" to Google Calendar`, msg)
          }
        }
      }
    }
  } finally {
    lock = false
  }
}

function reloadEvents() {
  import('@/store/calendar').then(({ useCalendarStore }) => {
    useCalendarStore.getState().loadEventsFromDb()
  }).catch(() => {})
}

function notifyFailure(message: string, detail: string) {
  console.error('[calendar]', message, detail)
  import('@/store/ui').then(({ useUiStore }) => {
    useUiStore.getState().pushToast({
      kind: 'error',
      message,
      detail: `${detail} — it's still on this device only. Reopen it to retry.`,
      ttlMs: 30_000,
    })
  }).catch(() => {})
}
