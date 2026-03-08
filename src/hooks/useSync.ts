import { useEffect, useCallback, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import { getQueueCount } from '@/db/sync-queue'
import { onSyncStatus, startSyncLoop, stopSyncLoop, fullSync } from '@/gmail/sync'
import { preloadAllInbox } from '@/utils/email-cache'
import { preloadAttachments } from '@/utils/attachment-cache'
import { useInboxStore } from '@/store/inbox'
import { useUiStore } from '@/store/ui'

export function useSync() {
  const setThreads = useInboxStore((s) => s.setThreads)
  const setSyncStatus = useUiStore((s) => s.setSyncStatus)
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

  // Start sync loop
  useEffect(() => {
    startSyncLoop()
    return () => stopSyncLoop()
  }, [])

  const triggerFullSync = useCallback(async () => {
    await fullSync()
  }, [])

  return { triggerFullSync }
}
