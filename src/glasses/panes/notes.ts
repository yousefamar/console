// Notes pane — cursor-follow mirror.
//
// Reads the live CM6 `editorView.state` from `useNotesStore` and renders
// a 4-row window around the cursor. Each logical line is prefixed with a
// right-aligned line number, hard-wrapped to fit, and the cursor line
// gets a `|` glyph at the cursor column.
//
// Placement (matches the pre-generalization behaviour, shrunk from 5→4):
//   - Cursor on row 3 (of body 4), line below on row 4 — when the doc
//     has content below the cursor. "See what comes next."
//   - Cursor on row 4 — when at EOF / last line.

import type { EditorState } from '@codemirror/state'
import { useNotesStore } from '@/store/notes'
import { DISPLAY_COLS, BODY_ROWS, wrapLine, buildStatus, type MirrorFrame } from '../mirror'

const CURSOR_GLYPH = '|'
const CURSOR_SENTINEL = '\u0001'

function basename(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash >= 0 ? path.slice(slash + 1) : path
}

function renderLine(
  state: EditorState,
  n: number,
  cursorLineNum: number,
  cursorCol: number,
  lnWidth: number,
  contPrefix: string,
  textWidth: number,
): string[] {
  const doc = state.doc
  let text = doc.line(n).text
  if (n === cursorLineNum) {
    text = text.slice(0, cursorCol) + CURSOR_SENTINEL + text.slice(cursorCol)
  }
  const lnPrefix = String(n).padStart(lnWidth, ' ') + ' '
  return wrapLine(text, lnPrefix, contPrefix, contPrefix.length + textWidth)
}

function buildBody(state: EditorState): string[] {
  const doc = state.doc
  const cursorPos = state.selection.main.head
  const cursorLineObj = doc.lineAt(cursorPos)
  const cursorLineNum = cursorLineObj.number
  const cursorCol = cursorPos - cursorLineObj.from
  const totalLines = doc.lines
  const hasBelow = cursorLineNum < totalLines

  const endLine = hasBelow ? cursorLineNum + 1 : cursorLineNum
  const lnWidth = String(endLine).length
  const prefixWidth = lnWidth + 1
  const textWidth = Math.max(10, DISPLAY_COLS - prefixWidth)
  const contPrefix = ' '.repeat(prefixWidth)

  const cursorLineRows = renderLine(state, cursorLineNum, cursorLineNum, cursorCol, lnWidth, contPrefix, textWidth)
  let cursorPhysOffset = 0
  for (let i = 0; i < cursorLineRows.length; i++) {
    if (cursorLineRows[i]!.includes(CURSOR_SENTINEL)) {
      cursorLineRows[i] = cursorLineRows[i]!.replace(CURSOR_SENTINEL, CURSOR_GLYPH)
      cursorPhysOffset = i
      break
    }
  }
  const cursorRow = cursorLineRows[cursorPhysOffset] ?? ''

  // Rows above the cursor row: prior wrapped segments of cursor line +
  // logical lines walking backwards.
  let rowsAbove: string[] = cursorLineRows.slice(0, cursorPhysOffset)
  let n = cursorLineNum - 1
  while (rowsAbove.length < BODY_ROWS - 1 && n >= 1) {
    rowsAbove = [...renderLine(state, n, cursorLineNum, cursorCol, lnWidth, contPrefix, textWidth), ...rowsAbove]
    n -= 1
  }

  const belowRow = hasBelow
    ? renderLine(state, cursorLineNum + 1, cursorLineNum, cursorCol, lnWidth, contPrefix, textWidth)[0] ?? ''
    : null

  if (belowRow != null) {
    // cursor on row 3, below on row 4 → need 2 rows above.
    let above = rowsAbove.slice(-(BODY_ROWS - 2))
    while (above.length < BODY_ROWS - 2) above.unshift('')
    return [...above, cursorRow, belowRow]
  }
  // cursor on row 4 → need 3 rows above.
  let above = rowsAbove.slice(-(BODY_ROWS - 1))
  while (above.length < BODY_ROWS - 1) above.unshift('')
  return [...above, cursorRow]
}

export function renderNotes(): MirrorFrame | null {
  const { editorView, activeFilePath } = useNotesStore.getState()
  const file = activeFilePath ? basename(activeFilePath) : null
  if (!editorView) {
    return {
      status: buildStatus(['Notes', file ?? 'no file open']),
      body: [],
    }
  }
  return {
    status: buildStatus(['Notes', file]),
    body: buildBody(editorView.state),
  }
}
