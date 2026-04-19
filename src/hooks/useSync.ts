import { useEffect, useCallback, useRef } from 'react'
import { onSyncStatus, startSyncLoop, stopSyncLoop, fullSync } from '@/gmail/sync'
import { isSignedIn as isGmailSignedIn } from '@/gmail/auth'
import {
  onMatrixSyncStatus,
  ingestHubDelta,
  processChatQueue,
  checkChatSnoozes,
} from '@/matrix/sync'
import { onEnqueue } from '@/db/sync-queue'
import { isMatrixConnected } from '@/matrix/auth'
import { preloadAllInbox } from '@/utils/email-cache'
import { preloadAttachments } from '@/utils/attachment-cache'
import { preloadContacts } from '@/components/ContactAutocomplete'
import { useChatStore } from '@/store/chat'
import { useUiStore } from '@/store/ui'
import { backfillMediaUrls } from '@/matrix/backfill-media'
import { backfillRoomInfo } from '@/matrix/backfill-rooms'

export function useSync() {
  const setSyncStatus = useUiStore((s) => s.setSyncStatus)
  const setMatrixSyncStatus = useUiStore((s) => s.setMatrixSyncStatus)

  // Subscribe to sync status changes + preload emails when sync completes
  const prevStatus = useRef<string>('idle')
  useEffect(() => {
    const unsub = onSyncStatus((status, detail) => {
      setSyncStatus(status, detail)
      // Preload email iframes after sync finishes
      if (prevStatus.current === 'syncing' && status === 'idle') {
        preloadAllInbox().then(() => preloadAttachments())
        preloadContacts()
      }
      prevStatus.current = status
    })
    return unsub
  }, [setSyncStatus])

  // Subscribe to Matrix sync status
  useEffect(() => {
    const unsub = onMatrixSyncStatus((status, detail) => {
      setMatrixSyncStatus(status, detail)
    })
    return unsub
  }, [setMatrixSyncStatus])

  // Start email sync loop (only when Gmail is connected)
  useEffect(() => {
    if (!isGmailSignedIn()) return
    startSyncLoop()
    return () => stopSyncLoop()
  }, [])

  // Matrix sync — the hub owns the Matrix /sync loop and broadcasts decrypted
  // deltas over SyncBus. Browser is a pure consumer: no direct homeserver calls,
  // no local crypto. On first load (no cached rooms) we prime with a one-shot
  // full sync via the hub's syncNow RPC, then live deltas take over.
  useEffect(() => {
    if (!isMatrixConnected()) return

    let stopped = false
    let hubUnsubDelta: (() => void) | null = null
    let hubUnsubInitial: (() => void) | null = null
    let hubUnsubConnect: (() => void) | null = null

    const startMatrix = async () => {
      // One-time migrations (local cache cleanup — no network needed)
      await backfillMediaUrls().catch(() => {})
      await backfillRoomInfo().catch(() => {})

      // Subscribe BEFORE asking hub to sync, so we don't miss the response.
      const { hubBus } = await import('@/sync-bus')
      hubUnsubInitial = hubBus.on('matrix', 'initial', (data: unknown) => {
        ingestHubDelta(data as Parameters<typeof ingestHubDelta>[0], true)
          .then(() => useChatStore.getState().preloadAllRooms().catch(() => {}))
          .catch(() => {})
      })
      hubUnsubDelta = hubBus.on('matrix', 'delta', (data: unknown) => {
        ingestHubDelta(data as Parameters<typeof ingestHubDelta>[0]).catch(() => {})
      })

      if (stopped) return

      // Ask for a snapshot on every WS (re)connect. The hub doesn't buffer
      // missed deltas, so any client that was offline (laptop asleep, APK
      // backgrounded, brief network drop) has a hole in its timeline until
      // we reconcile. Snapshot broadcasts a full decrypted `initial` payload
      // which ingestHubDelta idempotently applies via bulkPut.
      //
      // First-connect semantics are unchanged — we always snapshot on boot,
      // whether IDB is empty or already populated (cheap enough; hub's /sync
      // with no since returns one window per room).
      hubUnsubConnect = hubBus.onConnect(() => {
        hubBus.rpc('matrix', 'snapshot', {}).catch(() => {})
      })
      // If the bus already opened before we subscribed, kick off one manually.
      if (hubBus.connected) {
        hubBus.rpc('matrix', 'snapshot', {}).catch(() => {})
      }
    }
    startMatrix().catch(() => {})

    // Flush chat queue immediately on enqueue (debounced 500ms)
    let chatFlushTimer: ReturnType<typeof setTimeout> | null = null
    const unsubFlush = onEnqueue(() => {
      if (chatFlushTimer) clearTimeout(chatFlushTimer)
      chatFlushTimer = setTimeout(() => {
        chatFlushTimer = null
        processChatQueue().catch(() => {})
      }, 500)
    })

    // Periodic queue processing + snooze checks
    const queueInterval = setInterval(() => processChatQueue().catch(() => {}), 5_000)
    const snoozeInterval = setInterval(() => checkChatSnoozes().catch(() => {}), 60_000)

    return () => {
      stopped = true
      if (chatFlushTimer) clearTimeout(chatFlushTimer)
      clearInterval(queueInterval)
      clearInterval(snoozeInterval)
      unsubFlush()
      hubUnsubDelta?.()
      hubUnsubInitial?.()
      hubUnsubConnect?.()
    }
  }, [])

  // Feed refresh: every 15 minutes
  useEffect(() => {
    const FEED_INTERVAL = 15 * 60 * 1000
    const feedInterval = setInterval(() => {
      import('@/store/feeds').then(({ useFeedStore }) => {
        if (useFeedStore.getState().connected) {
          useFeedStore.getState().refreshItems()
        }
      })
    }, FEED_INTERVAL)

    return () => clearInterval(feedInterval)
  }, [])

  // Calendar refresh: driven by hub sync-bus events. The hub owns the periodic
  // Google Calendar poll and broadcasts `cal.delta` when anything changes. The
  // browser fetches fresh events only when something actually changed, plus a
  // slow 15-min fallback in case the hub /sync channel is down.
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null
    const refetch = () => {
      import('@/store/calendar').then(({ useCalendarStore }) => {
        if (useCalendarStore.getState().connected) {
          useCalendarStore.getState().fetchEvents()
        }
      })
    }
    let unsub: (() => void) | null = null
    import('@/sync-bus').then(({ hubBus }) => {
      unsub = hubBus.on('cal', 'delta', () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => { debounce = null; refetch() }, 500)
      })
    })
    const FALLBACK_MS = 15 * 60 * 1000
    const calInterval = setInterval(refetch, FALLBACK_MS)

    return () => {
      clearInterval(calInterval)
      if (debounce) clearTimeout(debounce)
      unsub?.()
    }
  }, [])

  // Calendar queue processing: flush on enqueue (500ms debounce) + periodic 5s
  useEffect(() => {
    let calFlushTimer: ReturnType<typeof setTimeout> | null = null
    const unsubCalFlush = onEnqueue(() => {
      if (calFlushTimer) clearTimeout(calFlushTimer)
      calFlushTimer = setTimeout(() => {
        calFlushTimer = null
        import('@/calendar/sync').then(({ processCalendarQueue }) => {
          processCalendarQueue().catch(() => {})
        })
      }, 500)
    })
    const calQueueInterval = setInterval(() => {
      import('@/calendar/sync').then(({ processCalendarQueue }) => {
        processCalendarQueue().catch(() => {})
      })
    }, 5_000)

    return () => {
      if (calFlushTimer) clearTimeout(calFlushTimer)
      clearInterval(calQueueInterval)
      unsubCalFlush()
    }
  }, [])

  // Calendar reminders: check every 60s for events starting within 5 minutes
  useEffect(() => {
    const remindedEvents = new Set<string>(
      JSON.parse(localStorage.getItem('cal_reminded') || '[]'),
    )

    const checkReminders = () => {
      import('@/store/calendar').then(({ useCalendarStore }) => {
        const { events, calendars } = useCalendarStore.getState()
        const now = Date.now()

        // Build map of calendar default reminders
        const calDefaults = new Map<string, number[]>()
        for (const c of calendars) {
          calDefaults.set(c.id, (c.defaultReminders || []).map((r) => r.minutes))
        }

        for (const event of events) {
          if (!event.start?.dateTime) continue

          // Resolve reminder minutes for this event
          let reminderMinutes: number[]
          if (!event.reminders || event.reminders.useDefault) {
            reminderMinutes = calDefaults.get(event.calendarId) || []
          } else {
            reminderMinutes = (event.reminders.overrides || []).map((r) => r.minutes)
          }
          if (reminderMinutes.length === 0) continue

          const startTime = new Date(event.start.dateTime).getTime()

          for (const mins of reminderMinutes) {
            const reminderTime = startTime - mins * 60_000
            const diff = reminderTime - now
            const key = `${event.id}:${mins}`
            // Fire if reminder time is within the last 60s (one check interval)
            if (diff <= 0 && diff > -60_000 && !remindedEvents.has(key)) {
              remindedEvents.add(key)
              localStorage.setItem('cal_reminded', JSON.stringify([...remindedEvents].slice(-200)))
              import('@/notifications').then(({ notify }) => {
                const time = new Date(event.start!.dateTime!).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
                const label = mins === 0 ? 'Now' : mins < 60 ? `In ${mins} min` : `In ${Math.round(mins / 60)} hr`
                notify({
                  title: event.summary || 'Upcoming event',
                  body: `${label} · ${time}${event.location ? ` · ${event.location}` : ''}`,
                  icon: '/icon-192.png',
                  tag: `cal-${event.id}-${mins}`,
                  data: { pane: 'calendar' },
                })
              })
            }
          }
        }
      })
    }

    const reminderInterval = setInterval(checkReminders, 60_000)
    checkReminders() // Check immediately on mount

    return () => clearInterval(reminderInterval)
  }, [])

  const triggerFullSync = useCallback(async () => {
    if (isGmailSignedIn()) await fullSync()
    if (isMatrixConnected()) {
      const { hubBus } = await import('@/sync-bus')
      await hubBus.rpc('matrix', 'syncNow', {}).catch(() => {})
    }
  }, [])

  return { triggerFullSync }
}
