// App-wide "mirror to glasses" — takes whichever pane the user is looking at
// and renders it onto the G1 lenses in 5 rows × 40 cols.
//
// Row 1 = status bar (pane name + focus/meta). Rows 2–5 = pane body, built
// by a per-pane renderer in `./panes/*.ts`. The renderer returns a
// `MirrorFrame`; this module stitches the status row, pads/clips to 40
// cols, hands the string to the native `ConsoleNative.glassesSendText`
// bridge.
//
// Everything short-circuits the hub: keystroke → BLE ≤ 100ms.
//
// The scheduler is a single coalescing timer. A burst of subscription
// callbacks (pane change + composer edit + new message) collapses into
// one BLE write per 30ms tick.
//
// Subscriptions:
//   - `useUiStore` for active pane
//   - per-pane stores gated on `isEnabled() && supported`
//   - CM6 → `pushFromEditor(state)` for Notes cursor-follow (since Zustand
//     can't see CM6 selection changes)

import { sendText, clear as bridgeClear, glassesSupported, setMirrorDim } from './bridge'
import type { EditorState } from '@codemirror/state'
import { useUiStore, type ActivePane } from '@/store/ui'
import { useChatStore } from '@/store/chat'
import { useAgentStore } from '@/store/agent'
import { useInboxStore } from '@/store/inbox'
import { useCalendarStore } from '@/store/calendar'
import { useFeedStore } from '@/store/feeds'
import { useBookmarkStore } from '@/store/bookmarks'
import { useMoneyStore } from '@/store/money'
import { useNotesStore } from '@/store/notes'
import { useDashboardStore } from '@/store/dashboard'
import { renderNotes } from './panes/notes'
import { renderChat } from './panes/chat'
import { renderAgents } from './panes/agents'
import { renderMail } from './panes/mail'
import { renderCalendar } from './panes/calendar'
import { renderFeeds } from './panes/feeds'
import { renderBookmarks } from './panes/bookmarks'
import { renderMoney } from './panes/money'
import { renderMap } from './panes/map'
import { renderHome } from './panes/home'
import { useMapStore } from '@/store/map'

/**
 * Pessimistic-but-safe text width per row. G1 uses a proportional font,
 * no reference impl measures pixels — they all ship a naive fixed-char
 * wrap. 40 matches EvenDemoApp's even-web. The G1 clips (doesn't wrap)
 * anything past the line's pixel budget, so 40 occasionally under-fills
 * and very rarely clips.
 */
export const DISPLAY_COLS = 40
export const BODY_ROWS = 4

const STORAGE_KEY = 'console:glasses:mirrorEnabled'
const LEGACY_STORAGE_KEY = 'console:glasses:notesMirrorEnabled'
const DEBOUNCE_MS = 30

export interface MirrorFrame {
  /** Status line (row 1). Clipped to {@link DISPLAY_COLS}. */
  status: string
  /** Body rows (rows 2–5). 0..4 rows, each clipped to {@link DISPLAY_COLS}.
   *  Top-padded with blanks to 4 rows. */
  body: string[]
}

type PaneRenderer = () => MirrorFrame | null

const renderers: Record<ActivePane, PaneRenderer> = {
  home: renderHome,
  notes: renderNotes,
  chat: renderChat,
  agents: renderAgents,
  email: renderMail,
  calendar: renderCalendar,
  feeds: renderFeeds,
  bookmarks: renderBookmarks,
  money: renderMoney,
  map: renderMap,
}

// --- Enable / persistence --------------------------------------------------

let enabled = false
let timer: number | null = null
let pendingFrame: string | null = null
let lastSent: string | null = null

export function loadEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    enabled = window.localStorage.getItem(STORAGE_KEY) === '1'
    // Back-compat: old toggle key from the "Notes only" era.
    if (!enabled && window.localStorage.getItem(LEGACY_STORAGE_KEY) === '1') {
      enabled = true
      window.localStorage.setItem(STORAGE_KEY, '1')
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    }
  } catch {
    enabled = false
  }
  return enabled
}

export function isEnabled(): boolean {
  return enabled
}

export function setEnabled(v: boolean) {
  enabled = v
  try {
    if (v) window.localStorage.setItem(STORAGE_KEY, '1')
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore — persistence is best-effort
  }
  // APK "stealth screen" so HW keyboard keeps reaching WebView with
  // panel visually dark. No-op in browser.
  if (glassesSupported()) setMirrorDim(v)
  if (!v) {
    if (timer != null) {
      window.clearTimeout(timer)
      timer = null
    }
    pendingFrame = null
    lastSent = null
    if (glassesSupported()) bridgeClear()
  } else {
    pushNow()
  }
}

// --- Formatters (shared across pane renderers) -----------------------------

/** Clip a single row to {@link DISPLAY_COLS}. Never wraps — callers that
 *  want wrapping use {@link wrapLine}. */
export function clipRow(s: string, cols: number = DISPLAY_COLS): string {
  if (s.length <= cols) return s
  return s.slice(0, cols)
}

/**
 * Hard-wrap `text` into rows of at most `cols` chars, preferring a word
 * boundary within the right half of the window so words aren't split
 * mid-character. First row optionally gets `firstPrefix`; continuation
 * rows get `contPrefix` (usually spaces of equal width for gutter
 * alignment).
 */
export function wrapLine(
  text: string,
  firstPrefix: string = '',
  contPrefix: string = '',
  cols: number = DISPLAY_COLS,
): string[] {
  const widthFirst = Math.max(1, cols - firstPrefix.length)
  const widthCont = Math.max(1, cols - contPrefix.length)
  if (text.length === 0) return [firstPrefix]
  const rows: string[] = []
  let remaining = text
  let first = true
  while (remaining.length > 0) {
    const prefix = first ? firstPrefix : contPrefix
    const width = first ? widthFirst : widthCont
    if (remaining.length <= width) {
      rows.push(prefix + remaining)
      break
    }
    const spaceIdx = remaining.lastIndexOf(' ', width)
    const breakIdx = spaceIdx > width / 2 ? spaceIdx : width
    rows.push(prefix + remaining.slice(0, breakIdx))
    remaining = remaining.slice(spaceIdx > width / 2 ? breakIdx + 1 : breakIdx)
    first = false
  }
  return rows
}

/**
 * Status-line builder — `Pane · focus · meta`. Clips to display width.
 * `·` is ASCII-safe for the G1 font (verified on-device).
 */
export function buildStatus(parts: (string | null | undefined)[]): string {
  return clipRow(parts.filter((p): p is string => !!p && p.length > 0).join(' · '))
}

/**
 * Pad a body to exactly {@link BODY_ROWS} rows. Body alignment is
 * **bottom-biased** (new content lands at row 5, older content drifts
 * upward) — matches chat/agent conventions. Callers can pre-arrange
 * order however they like; this just tops up with blanks.
 */
export function padBottom(rows: string[]): string[] {
  const out = rows.slice(-BODY_ROWS).map((r) => clipRow(r))
  while (out.length < BODY_ROWS) out.unshift('')
  return out
}

/** Compose input line: `> …text` with left-truncation so the latest
 *  char is visible. `cursor` appends a glyph at the end. */
export function composerRow(text: string, prompt: string = '> '): string {
  const width = DISPLAY_COLS - prompt.length - 1  // -1 for trailing cursor
  let visible = text
  if (visible.length > width) visible = '…' + visible.slice(-(width - 1))
  return prompt + visible + '|'
}

// --- Scheduler -------------------------------------------------------------

function buildFrame(): string | null {
  const pane = useUiStore.getState().activePane
  const renderer = renderers[pane]
  if (!renderer) return null
  const frame = renderer()
  if (!frame) return null
  const status = clipRow(frame.status)
  const body = padBottom(frame.body)
  return [status, ...body].join('\n')
}

function flush() {
  timer = null
  if (!enabled || !glassesSupported()) return
  const text = pendingFrame
  pendingFrame = null
  if (text == null) return
  if (text === lastSent) return
  lastSent = text
  sendText(text)
}

/** Coalescing push — call from any subscription handler. */
export function scheduleFrame() {
  if (!enabled || !glassesSupported()) return
  pendingFrame = buildFrame()
  if (pendingFrame == null) return
  if (timer != null) return
  timer = window.setTimeout(flush, DEBOUNCE_MS)
}

/** Immediate push (no debounce). Used when toggling on. */
export function pushNow() {
  if (!enabled || !glassesSupported()) return
  if (timer != null) {
    window.clearTimeout(timer)
    timer = null
  }
  pendingFrame = buildFrame()
  flush()
}

/**
 * CM6 → mirror bridge. Editor state changes aren't visible to Zustand
 * subscribers, so NotesEditorCore calls this on each doc/selection change.
 * The notes pane renderer re-reads the live `editorView.state` when we
 * build the frame, so we don't need to pass the state through here —
 * just trigger a re-render.
 */
export function pushFromEditor(_state: EditorState) {
  scheduleFrame()
}

// --- Wiring ----------------------------------------------------------------

let wired = false

/**
 * Subscribe once to the stores that drive mirror content. Gated on
 * `enabled`: when off, handlers short-circuit inside `scheduleFrame()`.
 * We still subscribe unconditionally because the user can flip the
 * toggle at runtime; re-wiring on each toggle is fiddly and the handler
 * cost when off is one boolean check.
 */
export function wireMirror() {
  if (wired) return
  wired = true
  if (typeof window === 'undefined') return

  // Active pane change → rebuild frame with the new pane's renderer.
  useUiStore.subscribe((s, prev) => {
    if (s.activePane !== prev.activePane) scheduleFrame()
  })

  // Per-pane stores. Subscribing to the whole store is fine — Zustand
  // fires once per `set()`, and `buildFrame()` dispatches on the active
  // pane so updates to the inactive pane's store still trigger a
  // rebuild but produce the same frame (caught by the `lastSent` dedupe).
  useChatStore.subscribe(() => scheduleFrame())
  useAgentStore.subscribe(() => scheduleFrame())
  useInboxStore.subscribe(() => scheduleFrame())
  useCalendarStore.subscribe(() => scheduleFrame())
  useFeedStore.subscribe(() => scheduleFrame())
  useBookmarkStore.subscribe(() => scheduleFrame())
  useMoneyStore.subscribe(() => scheduleFrame())
  useMapStore.subscribe(() => scheduleFrame())
  useNotesStore.subscribe(() => scheduleFrame())
  useDashboardStore.subscribe(() => scheduleFrame())

  // Glasses store carries composerText + bumpMirror — imported lazily to
  // avoid the circular: ./store → ./mirror → ./store.
  import('./store').then(({ useGlassesStore }) => {
    useGlassesStore.subscribe(() => scheduleFrame())
  }).catch(() => {})
}
