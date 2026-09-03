// ============================================================================
// Disk reconciliation for open buffers — the ONE primitive behind inline
// AI-edit review.
//
// "The file changed on disk under an open buffer" has many causes: an agent's
// Edit/Write tool (announced instantly via `notes.agent_edit`), an agent's
// Bash / `con notes write` (announced by the hub's vault poll as
// `notes.file_changed`), another device via Syncthing (same), a broadcast
// missed during a WS gap (caught by the reconnect sweep), or the user asking
// with `:e`. Whatever the trigger, the response is the same: read disk, and if
// it differs from what we last synced with, flip the buffer into review mode —
// the user's buffer becomes the review BASE (what ✗ restores), the disk text
// becomes the buffer (what ✓ keeps). Blind replacement is `:e!` only.
//
// Wired at boot (GatedBoot): the change can land while the user is on any
// pane; files that aren't open need nothing (opening later reads disk).
// ============================================================================

import { hubBus } from '@/sync-bus'
import { useNotesStore, pendingSave } from '@/store/notes'

export type ReconcileDecision =
  /** Buffer already holds the disk text — just re-arm savedContent/baseMtime. */
  | 'unchanged'
  /** Disk still equals our last sync point; only the user's own unsaved edits
   *  differ. Nothing external happened. */
  | 'local-only'
  /** Disk moved: open (or extend) a review against the user's buffer. */
  | 'review'
  /** Forced reload — take disk verbatim, dropping any review and local edits. */
  | 'replace'

/** Pure: what to do about a disk read for an open file. */
export function decideReconcile(
  file: { content: string; savedContent: string },
  fresh: string,
  force: boolean,
): ReconcileDecision {
  if (fresh === file.content) return 'unchanged'
  if (force) return 'replace'
  if (fresh === file.savedContent) return 'local-only'
  return 'review'
}

function loadIntoBuffer(path: string, fresh: { content: string; mtime?: number }): void {
  // savedContent/baseMtime track disk: the external write IS the saved
  // state, so review-mode accept/reject edits the buffer like typing and a
  // normal save persists the verdict.
  useNotesStore.setState((s) => {
    const f = s.openFiles[path]
    if (!f) return s
    return {
      openFiles: {
        ...s.openFiles,
        [path]: { ...f, content: fresh.content, savedContent: fresh.content, baseMtime: fresh.mtime },
      },
    }
  })
  // The editor is keyed on the path and does NOT remount for a content
  // change — the new text has to be dispatched into the live view too.
  const { editorView, editorViewPath } = useNotesStore.getState()
  if (editorView && editorViewPath === path && editorView.state.doc.toString() !== fresh.content) {
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: fresh.content } })
  }
}

/**
 * Reconcile one open buffer with its on-disk copy. Returns what happened, or
 * 'skipped' when the file isn't open / no adapter / the read failed.
 */
export async function reconcileWithDisk(
  path: string,
  opts: { force?: boolean } = {},
  depth = 0,
): Promise<ReconcileDecision | 'skipped'> {
  const notes = useNotesStore.getState()
  if (!notes.openFiles[path] || !notes.adapter) return 'skipped'

  // A save of OUR buffer in flight would read back as an "external" change —
  // let it land first, then look at disk.
  const saveBefore = pendingSave(path)
  if (saveBefore) await saveBefore.catch(() => {})

  let fresh: { content: string; mtime?: number }
  try {
    fresh = await notes.adapter.readFileWithMeta(path)
  } catch {
    return 'skipped'
  }
  // A save that STARTED during the read means the disk we just saw is stale.
  if (pendingSave(path) !== saveBefore && depth < 3) return reconcileWithDisk(path, opts, depth + 1)

  const file = useNotesStore.getState().openFiles[path]
  if (!file) return 'skipped'
  // Force = "take disk as-is": an open review is dropped even when the buffer
  // already matches disk (the review is UI state on top of equal text).
  if (opts.force) useNotesStore.getState().endReview(path)
  const decision = decideReconcile(file, fresh.content, !!opts.force)
  switch (decision) {
    case 'unchanged':
      if (file.savedContent !== fresh.content || file.baseMtime !== fresh.mtime) {
        useNotesStore.setState((s) => {
          const f = s.openFiles[path]
          if (!f) return s
          return { openFiles: { ...s.openFiles, [path]: { ...f, savedContent: fresh.content, baseMtime: fresh.mtime } } }
        })
      }
      break
    case 'local-only':
      break
    case 'replace':
      loadIntoBuffer(path, fresh)
      break
    case 'review':
      // The user's buffer is the review base — dirty edits included, so a
      // rejected chunk restores exactly what they had, not the last save.
      // Idempotent while a review is open: later changes fold into it.
      useNotesStore.getState().beginReview(path, file.content)
      loadIntoBuffer(path, fresh)
      break
  }
  return decision
}

/** Reconcile every open buffer — the reconnect sweep. Fire-and-forget hub
 *  broadcasts are never replayed, so a change announced during a WS gap is
 *  only ever caught here. */
export async function reconcileAllOpen(): Promise<void> {
  const paths = Object.keys(useNotesStore.getState().openFiles)
  await Promise.all(paths.map((p) => reconcileWithDisk(p)))
}

export function wireDiskReviewSubscription(): () => void {
  const onChange = (data: unknown) => {
    const { path } = (data ?? {}) as { path?: string }
    if (path) void reconcileWithDisk(path)
  }
  const offEdit = hubBus.on('notes', 'agent_edit', onChange)
  const offChanged = hubBus.on('notes', 'file_changed', onChange)
  const offConnect = hubBus.onConnect(() => { void reconcileAllOpen() })
  return () => { offEdit(); offChanged(); offConnect() }
}
