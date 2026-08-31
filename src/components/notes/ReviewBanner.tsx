import { memo, useEffect, useState } from 'react'
import { Check, X, GitPullRequest } from 'lucide-react'
import { useNotesStore } from '@/store/notes'
import { acceptAll, rejectAll, remainingChunks } from '@/notes/review'

/** Strip above the editor while an AI edit awaits review: pending-chunk
 *  count + Accept all / Reject all. Per-chunk ✓/✗ render inline in the
 *  buffer (unifiedMergeView's own controls); this is the whole-file verdict
 *  plus the "you are reviewing" signal. */
export const ReviewBanner = memo(function ReviewBanner({ path }: { path: string }) {
  const reviewing = useNotesStore((s) => s.reviewBase[path] !== undefined)
  const editorView = useNotesStore((s) => s.editorView)
  const editorViewPath = useNotesStore((s) => s.editorViewPath)
  const view = editorViewPath === path ? editorView : null
  const [pending, setPending] = useState<number | null>(null)

  // Chunk count lives in CM state, not the store — poll it cheaply while the
  // banner is up (accept/reject/typing all change it; a listener would need
  // its own extension slot for no real gain at 2 Hz).
  useEffect(() => {
    if (!reviewing || !view) { setPending(null); return }
    const tick = () => setPending(remainingChunks(view.state))
    tick()
    const t = setInterval(tick, 500)
    return () => clearInterval(t)
  }, [reviewing, view])

  if (!reviewing) return null

  return (
    <div className="flex items-center gap-2 border-b border-violet-500/40 bg-violet-500/10 px-3 py-1 flex-shrink-0">
      <GitPullRequest size={12} className="text-violet-400 flex-shrink-0" />
      <span className="text-xs text-text-primary">
        AI edit — {pending ?? '…'} pending change{pending === 1 ? '' : 's'}
      </span>
      <span className="flex-1" />
      <button
        onClick={() => view && acceptAll(view)}
        className="flex items-center gap-1 rounded border border-green-500/40 px-2 py-0.5 text-[11px] text-green-400 hover:bg-green-500/10"
      >
        <Check size={11} /> Accept all
      </button>
      <button
        onClick={() => view && rejectAll(view)}
        className="flex items-center gap-1 rounded border border-red-500/40 px-2 py-0.5 text-[11px] text-red-400 hover:bg-red-500/10"
      >
        <X size={11} /> Reject all
      </button>
    </div>
  )
})
