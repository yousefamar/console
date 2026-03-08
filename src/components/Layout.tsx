import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ThreadList } from './ThreadList'
import { ThreadView } from './ThreadView'
import { SyncStatus } from './SyncStatus'
import { useInboxStore } from '@/store/inbox'
import { useUiStore } from '@/store/ui'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { useSwipeActions } from '@/hooks/useSwipeActions'
import { incrementalSync, fullSync } from '@/gmail/sync'
import { signOut } from '@/gmail/auth'
import { db } from '@/db'
import { evictAll } from '@/utils/email-cache'
import { RefreshCw } from 'lucide-react'

export function Layout() {
  const threads = useInboxStore((s) => s.threads)
  const selectedThreadId = useInboxStore((s) => s.selectedThreadId)
  const selectThread = useInboxStore((s) => s.selectThread)
  const archiveThread = useInboxStore((s) => s.archiveThread)
  const snoozeThread = useInboxStore((s) => s.snoozeThread)
  const setShowSnoozePicker = useUiStore((s) => s.setShowSnoozePicker)
  const userEmail = useUiStore((s) => s.userEmail)
  const isMobile = useIsMobile()

  const [showSnoozed, setShowSnoozed] = useState(false)
  const showDetail = isMobile ? !!selectedThreadId : true
  const showList = isMobile ? !selectedThreadId : true

  // Snoozed thread count
  const snoozedCount = useLiveQuery(
    () => db.threads.filter((t) => !!t.snoozedUntil).count(),
    [],
  )

  // Swipe refs for mobile
  const swipeContainerRef = useRef<HTMLDivElement>(null)
  const swipeContentRef = useRef<HTMLDivElement>(null)
  const swipe = useSwipeActions(swipeContainerRef, swipeContentRef, {
    onSwipeRight: () => archiveThread(),
    onSwipeLeft: () => snoozeThread('tomorrow'),
  })

  return (
    <div className="flex h-full flex-col bg-surface-0">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-border px-3 md:px-4 py-1.5">
        <div className="flex items-center gap-3">
          <h1
            className="text-sm font-semibold text-text-primary tracking-tight"
            onClick={isMobile && selectedThreadId ? () => selectThread(null) : undefined}
          >
            Console
          </h1>
          {!isMobile && userEmail && (
            <button
              onClick={() => { signOut(); window.location.reload() }}
              className="text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
              title="Sign out"
            >
              {userEmail}
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 md:gap-4">
          <SyncStatus />
          {!isMobile && (
            <span className="text-xs text-text-tertiary">
              <kbd className="font-mono">?</kbd> help
            </span>
          )}
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Thread list */}
        {showList && (
          <div className={`${isMobile ? 'w-full' : 'w-72'} flex-shrink-0 border-r border-border overflow-hidden flex flex-col`}>
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium text-text-secondary">
                  Inbox
                  {threads.length > 0 && (
                    <span className="ml-1.5 text-text-tertiary">({threads.length})</span>
                  )}
                </span>
                {!!snoozedCount && (
                  <button
                    onClick={() => setShowSnoozed(!showSnoozed)}
                    className={`text-xs transition-colors duration-fast ${showSnoozed ? 'text-text-secondary' : 'text-text-tertiary hover:text-text-secondary'}`}
                    title="Toggle snoozed threads"
                  >
                    {showSnoozed ? 'hide snoozed' : `${snoozedCount} snoozed`}
                  </button>
                )}
              </div>
              <button
                onClick={async (e) => {
                  e.preventDefault()
                  if (e.ctrlKey || e.metaKey) {
                    // Preserve snoozed threads across full resync
                    const snoozed = await db.threads.filter((t) => !!t.snoozedUntil).toArray()
                    await db.threads.clear()
                    await db.messages.clear()
                    await db.attachmentData.clear()
                    await db.meta.delete('historyId')
                    if (snoozed.length > 0) {
                      await db.threads.bulkPut(snoozed)
                    }
                    evictAll()
                    await fullSync()
                  } else {
                    await incrementalSync()
                  }
                }}
                className="text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
                title="Refresh (Ctrl+click for full resync)"
              >
                <RefreshCw size={12} />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <ThreadList showSnoozed={showSnoozed} />
            </div>
          </div>
        )}

        {/* Thread view */}
        {showDetail && (
          <div
            ref={swipeContainerRef}
            className="flex-1 min-w-0 flex flex-col relative overflow-hidden"
          >
            {isMobile ? (
              <div
                ref={swipeContentRef}
                className="flex-1 min-h-0 flex flex-col relative"
                onTouchStart={swipe.onTouchStart}
                onTouchMove={swipe.onTouchMove}
                onTouchEnd={swipe.onTouchEnd}
              >
                <ThreadView />
              </div>
            ) : (
              <ThreadView />
            )}
          </div>
        )}
      </div>

      {/* Bottom action bar */}
      <footer className="flex items-center justify-between border-t border-border px-3 md:px-4 py-1 md:py-1">
        <div className="flex items-center gap-3 md:gap-4">
          <ActionHint keyLabel="e" action="Done" onClick={() => archiveThread()} mobile={isMobile} />
          <ActionHint keyLabel="b" action="Snooze" onClick={() => setShowSnoozePicker(true)} mobile={isMobile} />
          {!isMobile && (
            <>
              <ActionHint keyLabel="r" action="Reply" mobile={false} />
              <ActionHint keyLabel="c" action="Compose" mobile={false} />
            </>
          )}
        </div>
        {!isMobile && (
          <div className="flex items-center gap-3 text-xs text-text-tertiary">
            <span><kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> navigate</span>
            <span><kbd className="font-mono">/</kbd> search</span>
          </div>
        )}
      </footer>
    </div>
  )
}

function ActionHint({ keyLabel, action, onClick, mobile }: { keyLabel: string; action: string; onClick?: () => void; mobile: boolean }) {
  if (mobile) {
    return (
      <button
        onClick={onClick}
        className="flex items-center justify-center px-3 py-2 text-xs font-medium text-text-secondary active:text-text-primary active:bg-surface-2 rounded-sm transition-colors duration-fast"
      >
        {action}
      </button>
    )
  }

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
    >
      <kbd className="rounded-sm border border-border bg-surface-2 px-1 py-0.5 font-mono text-[10px]">
        {keyLabel}
      </kbd>
      <span>{action}</span>
    </button>
  )
}
