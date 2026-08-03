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

  // The editor mounts on the next frame(s) after the pane switch, so the view
  // isn't in the store yet. Poll briefly rather than guessing a delay.
  const view = await waitForEditorView()
  if (!view) return
  view.focus()

  if (anchor) {
    const line = findHeadingLine(view.state.doc.toString(), anchor)
    if (line !== null) {
      const pos = view.state.doc.line(line + 1).from
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    }
  }
}

function waitForEditorView(timeoutMs = 2000): Promise<any | null> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      const view = useNotesStore.getState().editorView
      if (view) return resolve(view)
      if (Date.now() - started > timeoutMs) return resolve(null)
      requestAnimationFrame(tick)
    }
    tick()
  })
}

export function wireNotesOpenSubscription(): () => void {
  return hubBus.on('notes', 'open_file', (data) => { void handleOpen(data) })
}
