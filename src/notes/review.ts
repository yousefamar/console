// ============================================================================
// Inline AI-edit review — VSCode-style accept/reject inside the doc editor.
//
// When an agent edits a vault file that's open in the editor, the buffer
// flips into review mode: the PRE-EDIT text becomes the merge view's
// "original", the on-disk (post-edit) text becomes the buffer, and
// @codemirror/merge's unifiedMergeView renders word-level changed spans with
// per-chunk Accept/Reject controls. Accepting a chunk keeps the agent's
// version; rejecting restores yours. When every chunk is resolved the editor
// drops back to normal mode and the result saves like any other edit.
//
// The review base is the user's LAST-SEEN buffer (savedContent at the moment
// the agent edit lands), not the agent's pre-edit disk copy — review answers
// "what changed relative to what I had", which also folds several rapid
// agent edits into one review pass.
// ============================================================================

import { unifiedMergeView, getChunks, acceptChunk, rejectChunk } from '@codemirror/merge'
import { Compartment, type EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export const reviewCompartment = new Compartment()

/** Extensions for review mode against `original` (the pre-edit text). */
export function reviewExtension(original: string): Extension {
  return [
    unifiedMergeView({
      original,
      // Word-level spans inside changed lines, inline where the chunk is a
      // same-line rewrite (the VSCode look) — falls back to deleted-above/
      // inserted-below blocks for multi-line rewrites.
      highlightChanges: true,
      allowInlineDiffs: true,
      gutter: true,
      mergeControls: true,
      syntaxHighlightDeletions: false,
    }),
    reviewTheme,
  ]
}

/** Swap review mode on/off in a live view. */
export function setReviewMode(view: EditorView, original: string | null): void {
  view.dispatch({
    effects: reviewCompartment.reconfigure(original === null ? [] : reviewExtension(original)),
  })
}

/** Unresolved chunk count, or null when the merge view isn't configured in
 *  this state — callers MUST distinguish: `0` means "review finished", null
 *  means "not reviewing" (treating null as 0 would auto-exit a review whose
 *  compartment hasn't been configured yet). */
export function remainingChunks(state: EditorState): number | null {
  const c = getChunks(state)
  return c ? c.chunks.length : null
}

/** Could this view update have resolved review chunks? Rejecting/typing
 *  edits the buffer (`docChanged`); ACCEPTING rewrites only the merge view's
 *  original doc (`userEvent: "accept"`, docChanged false) — gating the
 *  auto-exit on docChanged alone left a fully-accepted review stuck at
 *  "0 pending changes". */
export function mayResolveChunks(update: {
  docChanged: boolean
  transactions: readonly { isUserEvent(event: string): boolean }[]
}): boolean {
  return update.docChanged || update.transactions.some((t) => t.isUserEvent('accept'))
}

/** Accept every remaining chunk (keep the agent's text). */
export function acceptAll(view: EditorView): void {
  // Chunk positions shift as chunks resolve — always act on the first.
  for (let guard = 0; guard < 10_000; guard++) {
    const chunks = getChunks(view.state)?.chunks
    if (!chunks || chunks.length === 0) return
    if (!acceptChunk(view, chunks[0]!.fromB)) return
  }
}

/** Reject every remaining chunk (restore the pre-edit text). */
export function rejectAll(view: EditorView): void {
  for (let guard = 0; guard < 10_000; guard++) {
    const chunks = getChunks(view.state)?.chunks
    if (!chunks || chunks.length === 0) return
    if (!rejectChunk(view, chunks[0]!.fromB)) return
  }
}

// Dark-first styling on top of @codemirror/merge's base theme, matching the
// editor's neutral grays; accept/reject buttons echo VSCode's ✓/✗ chips.
const reviewTheme = EditorView.theme({
  '&.cm-merge-b .cm-changedLine, & .cm-inlineChangedLine': {
    backgroundColor: 'rgba(74, 222, 128, 0.08)',
  },
  '&.cm-merge-b .cm-changedText': {
    background: 'rgba(74, 222, 128, 0.22)',
    borderRadius: '2px',
  },
  '& .cm-deletedChunk': {
    backgroundColor: 'rgba(248, 113, 113, 0.08)',
  },
  '& .cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText': {
    background: 'rgba(248, 113, 113, 0.25)',
    borderRadius: '2px',
    textDecoration: 'line-through',
  },
  // The merge base theme absolutely positions the buttons at the chunk's
  // top-right INSIDE a widget that is zero-height for inline diffs — they
  // overlay (and hide) the first line's text. Static flow gives the widget
  // real height: the buttons get their own row ABOVE the text block.
  '& .cm-deletedChunk .cm-chunkButtons': {
    fontFamily: 'inherit',
    position: 'static',
    display: 'flex',
    justifyContent: 'flex-end',
    padding: '1px 0',
  },
  '& .cm-chunkButtons button': {
    cursor: 'pointer',
    border: '1px solid var(--color-border, #333)',
    borderRadius: '3px',
    background: 'var(--color-surface-1, #141414)',
    color: 'var(--color-text-secondary, #a3a3a3)',
    fontSize: '10px',
    padding: '1px 6px',
    marginLeft: '4px',
  },
  '& .cm-chunkButtons button[name="accept"]': {
    color: '#4ade80',
  },
  '& .cm-chunkButtons button[name="reject"]': {
    color: '#f87171',
  },
})
