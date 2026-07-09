// Shared editor actions that operate on a CodeMirror EditorView, reused by
// the desktop keydown handlers (NotesEditorCore) and the mobile writing
// toolbar (WriteActionBar).

import type { EditorView } from '@codemirror/view'

/**
 * Insert a markdown footnote (markdown-it-footnote syntax, which the blog's
 * Eleventy pipeline renders). Drops a `[^N]` reference at the cursor and
 * appends a `[^N]: ` definition at the end of the document, then moves the
 * cursor there so you can type the note immediately. N auto-increments past
 * the highest existing numeric footnote so repeated inserts don't collide.
 */
export function insertFootnote(view: EditorView | null): void {
  if (!view) return
  const doc = view.state.doc
  const text = doc.toString()

  let max = 0
  for (const m of text.matchAll(/\[\^(\d+)\]/g)) {
    const n = parseInt(m[1]!, 10)
    if (n > max) max = n
  }
  const n = max + 1
  const ref = `[^${n}]`
  const at = view.state.selection.main.head

  // Separate the definition from body content by a blank line.
  const sep = text.length === 0 ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  const def = `${sep}[^${n}]: `

  view.dispatch({
    changes: [
      { from: at, insert: ref },
      { from: doc.length, insert: def },
    ],
    // Cursor lands right after "[^N]: " in the definition. The ref inserted
    // earlier in the doc shifts the definition's final offset by ref.length.
    selection: { anchor: doc.length + ref.length + def.length },
    scrollIntoView: true,
  })
}
