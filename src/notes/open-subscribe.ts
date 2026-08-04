// ============================================================================
// `con notes open <path>` receiver.
//
// Any non-SPA process (an agent, a script) can POST /notes/open on the hub;
// the hub relays it over SyncBus as `notes.open_file` and this module acts on
// it: switch to the Notes pane, open the file in a tab, focus the editor, and
// optionally scroll to a heading.
//
// Subscribed at boot (GatedBoot), NOT in NotesTab — the request must work even
// if the user has never visited the Notes pane this session, which is exactly
// when the vault adapter isn't initialised yet. Hence the reconnectVault()
// bootstrap below.
// ============================================================================

import { hubBus } from '@/sync-bus'
import { useNotesStore } from '@/store/notes'
import { useUiStore } from '@/store/ui'

/** Find the line of a `# Heading` matching `anchor` (case-insensitive, any
 *  level). Returns null when absent — we then just leave the cursor at the
 *  top rather than guessing. */
export function findHeadingLine(content: string, anchor: string): number | null {
  const want = anchor.trim().toLowerCase()
  if (!want) return null
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^#{1,6}\s+(.*)$/.exec(lines[i]!)
    if (m && m[1]!.trim().toLowerCase() === want) return i
  }
  return null
}

async function handleOpen(data: unknown): Promise<void> {
  const { path, anchor } = (data ?? {}) as { path?: string; anchor?: string }
  if (!path) return

  const notes = useNotesStore.getState()
  // Cold Notes pane: no adapter yet, so openFile would silently no-op.
  if (!notes.adapter) await useNotesStore.getState().reconnectVault()
  if (!useNotesStore.getState().adapter) {
    console.error('[notes open] no vault adapter — cannot open', path)
    return
  }

  useUiStore.getState().setActivePane('notes')
  await useNotesStore.getState().openFile(path)
  if (useNotesStore.getState().activeFilePath !== path) return

  // The editor mounts a frame or two after the pane switch / tab change, so the
  // view isn't in the store yet. Poll for the view belonging to THIS path.
  const view = await waitForEditorView(path)
  if (!view) return

  await refreshFromDisk(path, view)
  view.focus()

  if (anchor) {
    const line = findHeadingLine(view.state.doc.toString(), anchor)
    if (line !== null) {
      const pos = view.state.doc.line(line + 1).from
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    }
  }
}

/**
 * An already-open tab holds the content read when it was opened. Whoever asked
 * for the remote-open usually JUST wrote the file, so without this the user is
 * shown a stale buffer (and an anchor added by that write jumps nowhere).
 *
 * Skipped when the tab is dirty — never clobber unsaved edits.
 */
async function refreshFromDisk(path: string, view: any): Promise<void> {
  const notes = useNotesStore.getState()
  if (notes.isFileDirty(path)) return
  let fresh: string
  try {
    fresh = await notes.adapter!.readFile(path)
  } catch {
    return
  }
  if (fresh === view.state.doc.toString()) return
  // The editor is keyed on the path, so it does NOT remount for a content
  // change — the new text has to be dispatched into the live view too.
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: fresh } })
  // Set BOTH content and savedContent — the disk version is by definition the
  // saved one, so the tab must not come back marked dirty.
  useNotesStore.setState((s) => {
    const file = s.openFiles[path]
    if (!file) return s
    return { openFiles: { ...s.openFiles, [path]: { ...file, content: fresh, savedContent: fresh } } }
  })
}

/**
 * Wait for the CM6 view of `path` specifically. The store's `editorView` slot is
 * global and, while switching between two already-open tabs, still holds the
 * PREVIOUS file's view for a frame — dispatching an anchor position into that
 * would scroll (or land out of range in) the wrong document.
 *
 * setTimeout, not requestAnimationFrame: a backgrounded browser tab pauses rAF
 * entirely, and remote-open exists precisely to drive a Console tab the user
 * isn't looking at.
 */
function waitForEditorView(path: string, timeoutMs = 3000): Promise<any | null> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      const { editorView, editorViewPath } = useNotesStore.getState()
      if (editorView && editorViewPath === path) return resolve(editorView)
      if (Date.now() - started > timeoutMs) return resolve(null)
      setTimeout(tick, 30)
    }
    tick()
  })
}

export function wireNotesOpenSubscription(): () => void {
  return hubBus.on('notes', 'open_file', (data) => { void handleOpen(data) })
}
