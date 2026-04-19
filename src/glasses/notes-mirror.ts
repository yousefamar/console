// Notes → Glasses cursor-follow mirror.
//
// Short-circuits the hub entirely: the CM6 editor calls us on each doc /
// selection change, we compute a 5-line window around the cursor and write
// directly to the phone's BLE worker via the `ConsoleNative.glassesSendText`
// bridge. Target: keystroke → photons ≤ 100 ms.
//
// Window rules (per user):
//   - If the cursor line is the last line of the document, it occupies the
//     glasses' last (5th) line.
//   - Otherwise, the line *below* the cursor occupies the last line and the
//     cursor sits on the 4th line (so the user sees "what comes next").
//
// Shorter windows (near the top of the doc) are top-padded with blanks so
// the bottom-alignment on the glasses is stable regardless of what the
// APK's own padding does.
//
// A single coalescing timer drops stale updates — if the user types faster
// than our write queue drains, only the most recent snapshot is sent.

import {
  sendText,
  clear as bridgeClear,
  glassesSupported,
  setNotesMirrorDim,
} from './bridge'
import type { EditorState } from '@codemirror/state'

const STORAGE_KEY = 'console:glasses:notesMirrorEnabled'
const DEBOUNCE_MS = 30

let enabled = false
let timer: number | null = null
let pendingText: string | null = null
let lastSent: string | null = null

export function loadEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    enabled = window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    enabled = false
  }
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
  // Toggle the APK's "stealth screen" mode so HW-keyboard events keep
  // flowing with the panel visually dark. No-op in the browser.
  if (glassesSupported()) setNotesMirrorDim(v)
  if (!v) {
    if (timer != null) {
      window.clearTimeout(timer)
      timer = null
    }
    pendingText = null
    lastSent = null
    if (glassesSupported()) bridgeClear()
  }
}

export function isEnabled(): boolean {
  return enabled
}

/** Cursor glyph shown on the current line at the cursor column. */
const CURSOR_GLYPH = '|'

/**
 * Glasses' text-mode display width in characters. The G1 uses a
 * proportional font, but neither the protocol nor any reference
 * implementation (EvenDemoApp, even-web, g1-term) measures pixel widths —
 * they all ship a naive fixed-char wrap. The Even reference apps
 * (`even-web-demo/src/lib/g1.ts`) use **40**; g1-term's SSH client uses
 * 36 (terminal emulator, different font mode). 40 matches the closest
 * published reference for text mode.
 *
 * The G1 silently clips (does not wrap) anything past the line's pixel
 * budget, so 40 is pessimistic-enough-to-rarely-clip, not exact.
 */
const DISPLAY_COLS = 40

/**
 * Hard-wrap `text` into physical rows of at most `textWidth` chars,
 * preferring to break at the last space within the row so words aren't
 * split mid-character. First row gets `lnPrefix` (e.g. "42 "),
 * continuation rows get `contPrefix` (spaces of equal width) so line
 * numbers align on the left gutter.
 */
function wrapLine(
  text: string,
  lnPrefix: string,
  contPrefix: string,
  textWidth: number,
): string[] {
  if (text.length === 0) return [lnPrefix]
  const rows: string[] = []
  let remaining = text
  let first = true
  while (remaining.length > 0) {
    const prefix = first ? lnPrefix : contPrefix
    if (remaining.length <= textWidth) {
      rows.push(prefix + remaining)
      break
    }
    // Prefer a word boundary within the window; require it to be close
    // to the right edge so we don't leave lots of whitespace on short
    // early words.
    const spaceIdx = remaining.lastIndexOf(' ', textWidth)
    const breakIdx = spaceIdx > textWidth / 2 ? spaceIdx : textWidth
    rows.push(prefix + remaining.slice(0, breakIdx))
    remaining = remaining.slice(spaceIdx > textWidth / 2 ? breakIdx + 1 : breakIdx)
    first = false
  }
  return rows
}

/**
 * Build the 5-row mirror window for a given editor state.
 *
 * Each logical line is prefixed with its 1-based line number (right-
 * aligned to the widest visible number) and hard-wrapped to
 * {@link DISPLAY_COLS}. The cursor line gets a `|` glyph inserted at the
 * cursor's column before wrapping.
 *
 * The window is expressed in **physical** rows, not logical lines — so a
 * single long wrapped line can fill the whole display. Placement:
 *   - cursor row = 4th, next row = 5th, when there's any content after it
 *   - cursor row = 5th, when at EOF / end of line with nothing below
 *
 * Returns exactly 5 rows joined by `\n` (top-padded with blanks when the
 * document is shorter than the window).
 */
export function buildMirrorText(state: EditorState): string {
  const doc = state.doc
  const cursorPos = state.selection.main.head
  const cursorLineObj = doc.lineAt(cursorPos)
  const cursorLineNum = cursorLineObj.number // 1-based
  const cursorCol = cursorPos - cursorLineObj.from
  const totalLines = doc.lines
  const hasBelow = cursorLineNum < totalLines

  // Line number column width — use the widest number we'll reasonably
  // render (cursor line or the one below it).
  const endLine = hasBelow ? cursorLineNum + 1 : cursorLineNum
  const lnWidth = String(endLine).length
  const prefixWidth = lnWidth + 1 // "42 " etc.
  // Keep at least 10 chars of text width even for absurdly large ln widths.
  const textWidth = Math.max(10, DISPLAY_COLS - prefixWidth)
  const contPrefix = ' '.repeat(prefixWidth)

  // Sentinel used to track the cursor through word-aware wrapping. We
  // insert it pre-wrap at `cursorCol`, wrap normally, then find the row
  // containing it and swap it for the real cursor glyph. A control char
  // is safe — markdown notes never contain U+0001.
  const CURSOR_SENTINEL = '\u0001'

  const renderLine = (n: number): string[] => {
    let text = doc.line(n).text
    if (n === cursorLineNum) {
      text = text.slice(0, cursorCol) + CURSOR_SENTINEL + text.slice(cursorCol)
    }
    const lnPrefix = String(n).padStart(lnWidth, ' ') + ' '
    return wrapLine(text, lnPrefix, contPrefix, textWidth)
  }

  const cursorLineRows = renderLine(cursorLineNum)
  // Find which wrapped row holds the sentinel → that's the cursor row.
  let cursorPhysOffset = 0
  for (let i = 0; i < cursorLineRows.length; i++) {
    if (cursorLineRows[i]!.includes(CURSOR_SENTINEL)) {
      cursorLineRows[i] = cursorLineRows[i]!.replace(CURSOR_SENTINEL, CURSOR_GLYPH)
      cursorPhysOffset = i
      break
    }
  }
  const cursorRow = cursorLineRows[cursorPhysOffset] ?? ''

  // Collect rows *above* the cursor's row — start with cursor line's own
  // preceding wrap segments, then walk logical lines backward until we
  // have enough to fill the window.
  let rowsAbove: string[] = cursorLineRows.slice(0, cursorPhysOffset)
  let n = cursorLineNum - 1
  while (rowsAbove.length < 4 && n >= 1) {
    rowsAbove = [...renderLine(n), ...rowsAbove]
    n -= 1
  }

  const belowRow = hasBelow ? renderLine(cursorLineNum + 1)[0] : null

  let window: string[]
  if (belowRow != null) {
    // Cursor on row 4, below-row on row 5 → need 3 rows above.
    let above = rowsAbove.slice(-3)
    while (above.length < 3) above.unshift('')
    window = [...above, cursorRow, belowRow]
  } else {
    // Cursor on row 5 → need 4 rows above.
    let above = rowsAbove.slice(-4)
    while (above.length < 4) above.unshift('')
    window = [...above, cursorRow]
  }

  return window.join('\n')
}

function flush() {
  timer = null
  if (!enabled || !glassesSupported()) return
  const text = pendingText
  pendingText = null
  if (text == null) return
  if (text === lastSent) return
  lastSent = text
  sendText(text)
}

/**
 * Schedule a mirror push from the current editor state. Coalesces rapid
 * calls into a single BLE write.
 */
export function pushMirror(state: EditorState) {
  if (!enabled || !glassesSupported()) return
  pendingText = buildMirrorText(state)
  if (timer != null) return
  timer = window.setTimeout(flush, DEBOUNCE_MS)
}

/**
 * Immediate push (no debounce). Used when toggling the mirror on, so the
 * user sees current context without waiting for a keystroke.
 */
export function pushMirrorNow(state: EditorState) {
  if (!enabled || !glassesSupported()) return
  if (timer != null) {
    window.clearTimeout(timer)
    timer = null
  }
  pendingText = buildMirrorText(state)
  flush()
}
