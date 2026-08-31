// ============================================================================
// `notes.agent_edit` receiver — agent edited a vault file.
//
// If that file is open in the editor, flip it into inline review mode: the
// user's current buffer becomes the review BASE (what ✗ restores), the
// agent's on-disk text becomes the buffer (what ✓ keeps), and the merge
// view renders per-chunk accept/reject. Files that aren't open need nothing:
// opening them later reads the post-edit disk copy normally.
//
// Wired at boot (GatedBoot), same rationale as open-subscribe: the edit can
// land while the user is on any pane.
// ============================================================================

import { hubBus } from '@/sync-bus'
import { useNotesStore } from '@/store/notes'

async function handleAgentEdit(data: unknown): Promise<void> {
  const { path } = (data ?? {}) as { path?: string }
  if (!path) return

  const notes = useNotesStore.getState()
  const file = notes.openFiles[path]
  if (!file || !notes.adapter) return

  let fresh: { content: string; mtime?: number }
  try {
    fresh = await notes.adapter.readFileWithMeta(path)
  } catch {
    return
  }
  // The user's buffer is the review base — dirty edits included, so a
  // rejected chunk restores exactly what they had, not the last save.
  const base = file.content
  if (fresh.content === base) return

  useNotesStore.getState().beginReview(path, base)
  // Load the agent's version into the buffer. savedContent/baseMtime track
  // disk (the agent's write IS the saved state); review-mode accept/reject
  // then edits the buffer like typing, and a normal save persists the verdict.
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
  // If this file is live in the editor, swap the document in place — the
  // editor doesn't remount for content changes (open-subscribe precedent).
  const { editorView, editorViewPath } = useNotesStore.getState()
  if (editorView && editorViewPath === path) {
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: fresh.content },
    })
  }
}

export function wireAgentEditSubscription(): () => void {
  return hubBus.on('notes', 'agent_edit', (data) => { void handleAgentEdit(data) })
}
