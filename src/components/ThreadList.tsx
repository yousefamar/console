import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import { useInboxStore } from '@/store/inbox'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { usePullToRefresh } from '@/hooks/usePullToRefresh'
import { incrementalSync } from '@/gmail/sync'
import { ThreadListItem } from './ThreadListItem'
import { SwipeableRow } from './SwipeableRow'
import { Check, Clock } from 'lucide-react'
import type { DbThread } from '@/gmail/types'

interface ThreadListProps {
  showSnoozed: boolean
}

export function ThreadList({ showSnoozed }: ThreadListProps) {
  const threads = useInboxStore((s) => s.threads)
  const selectedThreadId = useInboxStore((s) => s.selectedThreadId)
  const selectThread = useInboxStore((s) => s.selectThread)
  const listRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()

  usePullToRefresh(listRef, incrementalSync, isMobile)

  // Live query for inbox threads — drives the inbox store
  const liveThreads = useLiveQuery(
    () =>
      db.threads
        .filter((t) => t.labelIds.includes('INBOX') && !t.snoozedUntil)
        .reverse()
        .sortBy('date'),
    [],
  )

  useEffect(() => {
    if (liveThreads) {
      useInboxStore.getState().setThreads(liveThreads)
    }
  }, [liveThreads])

  const snoozedThreads = useLiveQuery(
    () => showSnoozed
      ? db.threads.filter((t) => !!t.snoozedUntil).sortBy('snoozedUntil')
      : Promise.resolve([] as DbThread[]),
    [showSnoozed],
  )

  const labelMapRaw = useLiveQuery(() => db.meta.get('labelMap'), [])
  const labelMap = useMemo(
    () => (labelMapRaw?.value ? JSON.parse(labelMapRaw.value) as Record<string, string> : undefined),
    [labelMapRaw],
  )

  // Auto-select first thread if none selected (desktop only)
  useEffect(() => {
    if (!isMobile && !selectedThreadId && threads.length > 0) {
      selectThread(threads[0]!.id)
    }
  }, [threads, selectedThreadId, selectThread, isMobile])

  // Scroll selected thread into view (on selection change or thread reorder)
  useEffect(() => {
    if (!selectedThreadId || !listRef.current) return
    const el = listRef.current.querySelector(`[data-thread-id="${selectedThreadId}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedThreadId, threads])

  if (threads.length === 0 && !showSnoozed) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-xs text-text-tertiary">No threads</p>
      </div>
    )
  }

  return (
    <div ref={listRef} className="h-full overflow-y-auto">
      {showSnoozed && snoozedThreads && snoozedThreads.length > 0 && (
        <>
          {snoozedThreads.map((thread: DbThread) => (
            <div key={thread.id} data-thread-id={thread.id}>
              <ThreadListItem
                thread={thread}
                isSelected={thread.id === selectedThreadId}
                onSelect={selectThread}
                snoozed
                labelMap={labelMap}
              />
            </div>
          ))}
          {threads.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-1">
              <div className="flex-1 border-t border-border-strong" />
              <span className="text-[10px] text-text-tertiary uppercase tracking-wider">Inbox</span>
              <div className="flex-1 border-t border-border-strong" />
            </div>
          )}
        </>
      )}
      {threads.map((thread) => (
        <div key={thread.id} data-thread-id={thread.id}>
          {isMobile ? (
            <SwipeableThreadItem thread={thread} isSelected={thread.id === selectedThreadId} onSelect={selectThread} labelMap={labelMap} />
          ) : (
            <ThreadListItem thread={thread} isSelected={thread.id === selectedThreadId} onSelect={selectThread} labelMap={labelMap} />
          )}
        </div>
      ))}
    </div>
  )
}

function SwipeableThreadItem({ thread, isSelected, onSelect, labelMap }: {
  thread: DbThread
  isSelected: boolean
  onSelect: (id: string) => void
  labelMap?: Record<string, string>
}) {
  const archiveThread = useInboxStore((s) => s.archiveThread)
  const snoozeThread = useInboxStore((s) => s.snoozeThread)

  const handleArchive = useCallback(() => {
    archiveThread(thread.id)
  }, [thread.id, archiveThread])

  const handleSnooze = useCallback(() => {
    snoozeThread('tomorrow', undefined, thread.id)
  }, [thread.id, snoozeThread])

  return (
    <SwipeableRow
      right={{ icon: <Check size={20} className="text-green-500" />, color: '34, 197, 94', onTrigger: handleArchive }}
      left={{ icon: <Clock size={20} className="text-amber-500" />, color: '245, 158, 11', onTrigger: handleSnooze }}
    >
      <ThreadListItem thread={thread} isSelected={isSelected} onSelect={onSelect} labelMap={labelMap} />
    </SwipeableRow>
  )
}
