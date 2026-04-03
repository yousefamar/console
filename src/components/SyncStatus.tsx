import { useState, useRef, useCallback, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useUiStore } from '@/store/ui'
import { getConflicts, getPending, getQueueCount } from '@/db/sync-queue'
import { processQueue } from '@/gmail/sync'
import { processChatQueue } from '@/matrix/sync'
import type { QueuedAction } from '@/gmail/types'
import clsx from 'clsx'

export function SyncStatus() {
  const emailStatus = useUiStore((s) => s.syncStatus)
  const emailDetail = useUiStore((s) => s.syncDetail)
  const matrixStatus = useUiStore((s) => s.matrixSyncStatus)
  const matrixDetail = useUiStore((s) => s.matrixSyncDetail)
  const queueCount = useUiStore((s) => s.queueCount)

  // Live query for queue count — drives the UI store
  const liveQueueCount = useLiveQuery(() => getQueueCount(), [])
  useEffect(() => {
    if (liveQueueCount !== undefined) {
      useUiStore.getState().setQueueCount(liveQueueCount)
    }
  }, [liveQueueCount])

  // Show the worst status across both sync systems
  const statusPriority = { error: 3, offline: 2, syncing: 1, idle: 0 } as const
  const syncStatus = statusPriority[emailStatus] >= statusPriority[matrixStatus] ? emailStatus : matrixStatus
  const syncDetail = statusPriority[emailStatus] >= statusPriority[matrixStatus] ? emailDetail : matrixDetail
  const [open, setOpen] = useState(false)
  const [details, setDetails] = useState<{ pending: QueuedAction[]; conflicts: QueuedAction[] } | null>(null)
  const [copied, setCopied] = useState(false)
  const [flushing, setFlushing] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(null)

  const statusDot = {
    idle: 'bg-success',
    syncing: 'bg-warning',
    error: 'bg-destructive',
    offline: 'bg-text-tertiary',
  }

  const statusLabel = {
    idle: 'Synced',
    syncing: syncDetail || 'Syncing',
    error: 'Error',
    offline: 'Offline',
  }

  const scheduleClose = useCallback(() => {
    closeTimer.current = setTimeout(() => setOpen(false), 150)
  }, [])

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])

  async function handleMouseEnter() {
    cancelClose()
    setOpen(true)
    const [pending, conflicts] = await Promise.all([getPending(), getConflicts()])
    setDetails({ pending, conflicts })
  }

  async function handleFlush() {
    setFlushing(true)
    try {
      await Promise.all([processQueue(), processChatQueue()])
      const [pending, conflicts] = await Promise.all([getPending(), getConflicts()])
      setDetails({ pending, conflicts })
    } finally {
      setFlushing(false)
    }
  }

  function handleCopy(text: string) {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className="relative flex items-center gap-2 text-xs text-text-tertiary cursor-default"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={scheduleClose}
    >
      <div className="flex items-center gap-1.5">
        <div className={clsx('h-1.5 w-1.5 rounded-full', statusDot[syncStatus])} />
        <span>{statusLabel[syncStatus]}</span>
      </div>
      {queueCount > 0 && (
        <span className="text-text-tertiary">
          {queueCount} pending
        </span>
      )}

      {/* Hover tooltip */}
      {open && details && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-80 rounded-sm border border-border bg-surface-1 p-3 shadow-lg animate-fade-in"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-primary">Sync status</span>
              <div className="flex items-center gap-1.5">
                <div className={clsx('h-1.5 w-1.5 rounded-full', statusDot[syncStatus])} />
                <span className="text-xs text-text-secondary">{statusLabel[syncStatus]}</span>
              </div>
            </div>

            {syncStatus === 'error' && syncDetail && (
              <div className="flex items-start gap-2">
                <p className="text-xs text-destructive break-all flex-1 select-text">{syncDetail}</p>
                <button
                  onClick={() => handleCopy(syncDetail)}
                  className="flex-shrink-0 text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}

            {details.pending.length > 0 && (
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-text-secondary">Pending ({details.pending.length})</span>
                  <button
                    onClick={handleFlush}
                    disabled={flushing}
                    className="text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast disabled:opacity-50"
                    title="Flush queue now"
                  >
                    {flushing ? '⟳' : '↻'} Flush
                  </button>
                </div>
                <div className="mt-1 space-y-0.5">
                  {details.pending.slice(0, 5).map((a) => (
                    <div key={a.id} className="flex items-center justify-between text-xs">
                      <span className="text-text-secondary">{a.type}</span>
                      <span className="text-text-tertiary truncate ml-2 max-w-[140px]">
                        {a.threadId?.slice(0, 8)}...
                      </span>
                    </div>
                  ))}
                  {details.pending.length > 5 && (
                    <span className="text-xs text-text-tertiary">+{details.pending.length - 5} more</span>
                  )}
                </div>
              </div>
            )}

            {details.conflicts.length > 0 && (
              <div>
                <span className="text-xs font-medium text-destructive">Conflicts ({details.conflicts.length})</span>
                <div className="mt-1 space-y-0.5">
                  {details.conflicts.map((a) => (
                    <div key={a.id} className="text-xs text-destructive">
                      {a.type}: {a.error}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {details.pending.length === 0 && details.conflicts.length === 0 && (
              <span className="text-xs text-text-tertiary">No pending actions</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
