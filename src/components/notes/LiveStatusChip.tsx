// Persistent live-state indicator for published posts, shown in the editor
// status bar. Green = the deployed page was built after your last save;
// yellow = local edits not yet live; pulsing = build queued and being
// polled. Click to force a re-check.

import { useEffect, useRef } from 'react'
import { useBlogStore } from '@/store/blog'
import { useNotesStore } from '@/store/notes'

interface Props {
  path: string
}

export function LiveStatusChip({ path }: Props) {
  const status = useBlogStore((s) => s.liveStatusByPath[path] ?? 'unknown')
  const savedContent = useNotesStore((s) => s.openFiles[path]?.savedContent)
  const prevSavedRef = useRef<string | undefined>(undefined)

  // Initial probe on mount / path change. But if a build is already in flight
  // (we just published this post and handlePublish set 'building' before
  // opening it), leave it alone — the background poller owns the resolution.
  // Probing now would compare the not-yet-rebuilt live page against the fresh
  // local mtime and wrongly flip it to 'stale'.
  useEffect(() => {
    prevSavedRef.current = undefined
    if (useBlogStore.getState().liveStatusByPath[path] === 'building') return
    void useBlogStore.getState().checkLiveStatus(path)
  }, [path])

  // A successful save makes the live page stale BY DEFINITION (local file
  // now newer than the deployed build) — flip immediately, no probe needed.
  // Only reacts to CHANGES (ref-guarded, not the mount-time value) and never
  // clobbers an in-flight 'building'.
  useEffect(() => {
    const prev = prevSavedRef.current
    prevSavedRef.current = savedContent
    if (prev === undefined || savedContent === undefined || prev === savedContent) return
    const cur = useBlogStore.getState().liveStatusByPath[path]
    if (cur !== 'building') {
      useBlogStore.getState().setLiveStatus(path, 'stale')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedContent])

  const dot =
    status === 'live' ? 'bg-green-400' :
    status === 'stale' ? 'bg-yellow-400' :
    status === 'building' ? 'bg-blue-400 animate-pulse' :
    'bg-text-tertiary opacity-50'

  const label =
    status === 'live' ? 'live' :
    status === 'stale' ? 'stale' :
    status === 'building' ? 'building…' :
    '?'

  const title =
    status === 'live' ? 'The live page includes your latest save' :
    status === 'stale' ? 'Local edits are NOT live yet — re-publish to deploy' :
    status === 'building' ? 'Build queued — waiting for the site to update' :
    'Live status unknown — click to re-check'

  return (
    <button
      onClick={() => void useBlogStore.getState().checkLiveStatus(path)}
      className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-text-primary hover:bg-surface-2 rounded-sm transition-colors"
      title={title}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
      {label}
    </button>
  )
}
