import { useEffect, useCallback, useRef } from 'react'
import { onSyncStatus, startSyncLoop, stopSyncLoop, fullSync } from '@/gmail/sync'
import { isSignedIn as isGmailSignedIn } from '@/gmail/auth'
import {
  onMatrixSyncStatus,
  fullMatrixSync,
  incrementalMatrixSync,
  processChatQueue,
  checkChatSnoozes,
} from '@/matrix/sync'
import { onEnqueue } from '@/db/sync-queue'
import { isMatrixConnected, getMatrixUserId, getMatrixDeviceId } from '@/matrix/auth'
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

  // Matrix sync loop (long-polling — server returns immediately on new events)
  useEffect(() => {
    if (!isMatrixConnected()) return

    let stopped = false

    // Continuous long-poll loop: ONLY the sync — no queue processing or snooze
    // checks in the critical path. The long-poll must restart ASAP after each
    // response so incoming messages arrive with minimal latency.
    const syncLoop = async () => {
      while (!stopped) {
        try {
          await incrementalMatrixSync()
        } catch {
          // Back off on error to avoid tight retry loops
          if (!stopped) await new Promise((r) => setTimeout(r, 5_000))
        }
      }
    }

    // Initialize crypto (lazy-loaded) then start sync
    const startMatrix = async () => {
      const userId = getMatrixUserId()
      const deviceId = getMatrixDeviceId()
      if (userId && deviceId) {
        try {
          const { initCrypto } = await import('@/matrix/crypto')
          await initCrypto(userId, deviceId)
        } catch (err) {
          console.warn('[crypto] Failed to init crypto, continuing without E2EE:', err)
        }
      }
      // One-time migrations (run before sync, only need auth)
      await backfillMediaUrls().catch(() => {})
      await backfillRoomInfo().catch(() => {})

      // If we have a sync token from a previous session, skip the expensive full sync
      // (hundreds of rooms) and go straight to incremental long-polling.
      const { getMeta } = await import('@/db')
      const existingToken = await getMeta('matrixSyncToken')
      if (!existingToken) {
        await fullMatrixSync()
        // Preload messages for all unread rooms into IndexedDB
        useChatStore.getState().preloadAllRooms().catch(() => {})
      }
      if (!stopped) syncLoop()
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

    // Periodic queue processing + snooze checks — outside the sync loop
    // so they never block the long-poll from restarting
    const queueInterval = setInterval(() => processChatQueue().catch(() => {}), 5_000)
    const snoozeInterval = setInterval(() => checkChatSnoozes().catch(() => {}), 60_000)

    return () => {
      stopped = true
      if (chatFlushTimer) clearTimeout(chatFlushTimer)
      clearInterval(queueInterval)
      clearInterval(snoozeInterval)
      unsubFlush()
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

  // Calendar refresh: every 5 minutes
  useEffect(() => {
    const CAL_INTERVAL = 5 * 60 * 1000
    const calInterval = setInterval(() => {
      import('@/store/calendar').then(({ useCalendarStore }) => {
        if (useCalendarStore.getState().connected) {
          useCalendarStore.getState().fetchEvents()
        }
      })
    }, CAL_INTERVAL)

    return () => clearInterval(calInterval)
  }, [])

  // Calendar reminders: check every 60s for events starting within 5 minutes
  useEffect(() => {
    const remindedEvents = new Set<string>(
      JSON.parse(localStorage.getItem('cal_reminded') || '[]'),
    )

    const checkReminders = () => {
      import('@/store/calendar').then(({ useCalendarStore }) => {
        const { events } = useCalendarStore.getState()
        const now = Date.now()
        const fiveMin = 5 * 60 * 1000

        for (const event of events) {
          if (!event.start?.dateTime) continue
          const startTime = new Date(event.start.dateTime).getTime()
          const diff = startTime - now
          if (diff > 0 && diff <= fiveMin && !remindedEvents.has(event.id)) {
            remindedEvents.add(event.id)
            localStorage.setItem('cal_reminded', JSON.stringify([...remindedEvents].slice(-200)))
            import('@/notifications').then(({ notify }) => {
              const time = new Date(event.start!.dateTime!).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
              notify({
                title: event.summary || 'Upcoming event',
                body: `${time}${event.location ? ` · ${event.location}` : ''}`,
                tag: `cal-${event.id}`,
                data: { pane: 'calendar' },
              })
            })
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
    if (isMatrixConnected()) await fullMatrixSync()
  }, [])

  return { triggerFullSync }
}
