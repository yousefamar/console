import { useEffect, useCallback, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import { getQueueCount } from '@/db/sync-queue'
import { onSyncStatus, startSyncLoop, stopSyncLoop, fullSync } from '@/gmail/sync'
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
import { useInboxStore } from '@/store/inbox'
import { useChatStore } from '@/store/chat'
import { useUiStore } from '@/store/ui'
import { backfillMediaUrls } from '@/matrix/backfill-media'
import { backfillRoomInfo } from '@/matrix/backfill-rooms'

export function useSync() {
  const setThreads = useInboxStore((s) => s.setThreads)
  const setChatRooms = useChatStore((s) => s.setRooms)
  const setSyncStatus = useUiStore((s) => s.setSyncStatus)
  const setMatrixSyncStatus = useUiStore((s) => s.setMatrixSyncStatus)
  const setQueueCount = useUiStore((s) => s.setQueueCount)

  // Live query for inbox threads (no snooze, in INBOX)
  const threads = useLiveQuery(
    () =>
      db.threads
        .filter((t) => t.labelIds.includes('INBOX') && !t.snoozedUntil)
        .reverse()
        .sortBy('date'),
    [],
  )

  // Set threads directly from live query
  useEffect(() => {
    if (threads) {
      setThreads(threads)
    }
  }, [threads, setThreads])

  // Live query for chat rooms: unread (inbox) + favourites (always pinned)
  const chatRooms = useLiveQuery(
    () =>
      db.chatRooms
        .filter((r) => {
          const isFavourite = r.tags?.includes('m.favourite') ?? false
          if (isFavourite) return true
          return r.isUnread && !r.snoozedUntil && !r.isLowPriority
        })
        .reverse()
        .sortBy('lastMessageTime'),
    [],
  )

  useEffect(() => {
    if (chatRooms) {
      setChatRooms(chatRooms)
    }
  }, [chatRooms, setChatRooms])

  // Live query for queue count
  const queueCountResult = useLiveQuery(() => getQueueCount(), [])
  useEffect(() => {
    if (queueCountResult !== undefined) {
      setQueueCount(queueCountResult)
    }
  }, [queueCountResult, setQueueCount])

  // Subscribe to sync status changes + preload emails when sync completes
  const prevStatus = useRef<string>('idle')
  useEffect(() => {
    const unsub = onSyncStatus((status, detail) => {
      setSyncStatus(status, detail)
      // Preload email iframes after sync finishes
      if (prevStatus.current === 'syncing' && status === 'idle') {
        preloadAllInbox().then(() => preloadAttachments())
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

  // Start email sync loop
  useEffect(() => {
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
      // (928 rooms @ ~2s each = 30+ min) and go straight to incremental long-polling.
      // Full sync only needed on first-ever connect.
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

  const triggerFullSync = useCallback(async () => {
    await fullSync()
    if (isMatrixConnected()) {
      await fullMatrixSync()
    }
  }, [])

  return { triggerFullSync }
}
