// Live table preview for the notes editor (Notes tab + Spaces Docs — same
// NotesEditorCore). Renders GFM tables as real <table> widgets while the
// cursor is elsewhere; moving the cursor into the table (or clicking a cell)
// reveals the raw markdown for editing — the same reveal model as the rest
// of live-preview.ts, but block-scoped: a table is multi-line, so the whole
// block toggles rather than one line.
//
// Block widgets MUST come from a StateField, not a ViewPlugin (CM6
// restriction — same reason frontmatterField exists). The field rebuilds on
// docChanged/selection, scanning lines directly instead of the syntax tree:
// tree parsing is async, and a line scan with fence tracking is cheap and
// deterministic.

import { EditorView, Decoration, type DecorationSet, WidgetType } from '@codemirror/view'
import { StateField, RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state'

export type CellAlign = 'left' | 'center' | 'right' | null

export interface TableCell {
  text: string
  /** Offset of the cell's first content char within its line (for click-to-edit). */
  start: number
}

export interface TableRow {
  cells: TableCell[]
  /** Absolute offset of the row's line start within the document. */
  lineFrom: number
}

export interface ParsedTable {
  from: number
  to: number
  aligns: CellAlign[]
  header: TableRow
  rows: TableRow[]
}

/** Split one table line into cells on unescaped `|` (GFM: `\|` is a literal
 *  pipe). Leading/trailing pipes are structural, not cells. */
export function splitRow(line: string): TableCell[] {
  const cells: TableCell[] = []
  let i = 0
  // Skip leading whitespace + structural opening pipe.
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
  if (line[i] === '|') i++
  let raw = ''
  let cellStart = i
  let firstContent = -1
  const push = () => {
    cells.push({ text: raw.trim(), start: firstContent === -1 ? cellStart : firstContent })
    raw = ''
    firstContent = -1
  }
  for (; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '\\' && line[i + 1] === '|') {
      if (firstContent === -1) firstContent = i
      raw += '|'
      i++
      continue
    }
    if (ch === '|') {
      push()
      cellStart = i + 1
      continue
    }
    if (firstContent === -1 && ch !== ' ' && ch !== '\t') firstContent = i
    raw += ch
  }
  // Trailing content after the last pipe is a cell only if non-empty
  // (a structural closing pipe leaves pure whitespace).
  if (raw.trim()) push()
  return cells
}

function isDelimiterRow(line: string): CellAlign[] | null {
  if (!line.includes('-') || !line.includes('|')) return null
  const cells = splitRow(line)
  if (!cells.length) return null
  const aligns: CellAlign[] = []
  for (const c of cells) {
    const m = c.text.match(/^(:?)-+(:?)$/)
    if (!m) return null
    aligns.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : m[1] ? 'left' : null)
  }
  return aligns
}

/** Find all GFM tables in the text: a `|` line followed by a valid delimiter
 *  row, continuing through consecutive `|` lines. Fenced code is skipped. */
export function scanTables(text: string): ParsedTable[] {
  const tables: ParsedTable[] = []
  const lines = text.split('\n')
  const lineFrom: number[] = new Array(lines.length)
  let off = 0
  for (let i = 0; i < lines.length; i++) {
    lineFrom[i] = off
    off += lines[i]!.length + 1
  }
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || !line.includes('|')) continue
    const aligns = i + 1 < lines.length ? isDelimiterRow(lines[i + 1]!) : null
    if (!aligns) continue
    const header: TableRow = { cells: splitRow(line), lineFrom: lineFrom[i]! }
    if (!header.cells.length) continue
    const rows: TableRow[] = []
    let last = i + 1
    for (let j = i + 2; j < lines.length; j++) {
      const rl = lines[j]!
      if (!rl.includes('|') || !rl.trim() || /^\s*(```|~~~)/.test(rl)) break
      rows.push({ cells: splitRow(rl), lineFrom: lineFrom[j]! })
      last = j
    }
    tables.push({
      from: lineFrom[i]!,
      to: lineFrom[last]! + lines[last]!.length,
      aligns,
      header,
      rows,
    })
    i = last // resume after the table
  }
  return tables
}

// ---------------------------------------------------------------------------
// Minimal inline markdown → DOM for cell content (safe: builds nodes, never
// innerHTML). Covers code / bold / italic / strikethrough / links / wikilinks.
// ---------------------------------------------------------------------------

const INLINE_PATTERNS: Array<{ re: RegExp; render: (m: RegExpMatchArray) => HTMLElement }> = [
  { re: /`([^`]+)`/, render: (m) => el('code', 'cm-inline-code', m[1]!) },
  { re: /\[\[([^\]]+)\]\]/, render: (m) => wikiLinkEl(m[1]!) },
  { re: /\[([^\]]+)\]\(([^)]+)\)/, render: (m) => linkEl(m[1]!, m[2]!) },
  { re: /\*\*([^*]+)\*\*/, render: (m) => inlineWrap('strong', m[1]!) },
  { re: /\*([^*]+)\*/, render: (m) => inlineWrap('em', m[1]!) },
  { re: /~~([^~]+)~~/, render: (m) => inlineWrap('del', m[1]!) },
]

function el(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag)
  e.className = cls
  e.textContent = text
  return e
}

function inlineWrap(tag: string, inner: string): HTMLElement {
  const e = document.createElement(tag)
  renderInlineTo(e, inner)
  return e
}

function linkEl(text: string, url: string): HTMLElement {
  const a = document.createElement('a')
  a.className = 'cm-link-widget'
  a.textContent = text
  a.href = url
  a.title = url
  a.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    window.open(url, '_blank', 'noopener')
  })
  return a
}

function wikiLinkEl(target: string): HTMLElement {
  const pipe = target.indexOf('|')
  const span = el('span', 'cm-wikilink-widget', pipe >= 0 ? target.slice(pipe + 1) : target)
  span.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const file = pipe >= 0 ? target.slice(0, pipe) : target
    void import('@/store/notes').then(({ useNotesStore }) => {
      const { files, openFile } = useNotesStore.getState()
      const match = files.find((f) =>
        f.name.replace(/\.md$/, '') === file || f.path === file || f.path === file + '.md')
      if (match) void openFile(match.path)
    })
  })
  return span
}

export function renderInlineTo(parent: HTMLElement, text: string): void {
  let rest = text
  while (rest) {
    let best: { index: number; len: number; node: HTMLElement } | null = null
    for (const p of INLINE_PATTERNS) {
      const m = rest.match(p.re)
      if (m && m.index !== undefined && (!best || m.index < best.index)) {
        best = { index: m.index, len: m[0].length, node: p.render(m) }
      }
    }
    if (!best) {
      parent.appendChild(document.createTextNode(rest))
      return
    }
    if (best.index > 0) parent.appendChild(document.createTextNode(rest.slice(0, best.index)))
    parent.appendChild(best.node)
    rest = rest.slice(best.index + best.len)
  }
}

// ---------------------------------------------------------------------------
// Widget + StateField
// ---------------------------------------------------------------------------

class TableWidget extends WidgetType {
  constructor(private table: ParsedTable, private raw: string) { super() }

  override eq(other: TableWidget): boolean {
    return this.raw === other.raw
  }

  override get estimatedHeight(): number {
    return (this.table.rows.length + 1) * 29
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-widget'
    const tbl = document.createElement('table')
    const { aligns } = this.table

    const addRow = (parent: HTMLElement, row: TableRow, tag: 'th' | 'td') => {
      const tr = document.createElement('tr')
      const n = Math.max(row.cells.length, aligns.length)
      for (let i = 0; i < n; i++) {
        const cell = row.cells[i]
        const td = document.createElement(tag)
        const align = aligns[i]
        if (align) td.style.textAlign = align
        if (cell) renderInlineTo(td, cell.text)
        // Click a cell → cursor lands at that cell's content, raw view opens.
        const pos = row.lineFrom + (cell?.start ?? 0)
        td.addEventListener('mousedown', (e) => {
          e.preventDefault()
          view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) }, scrollIntoView: true })
          view.focus()
        })
        tr.appendChild(td)
      }
      parent.appendChild(tr)
    }

    const thead = document.createElement('thead')
    addRow(thead, this.table.header, 'th')
    tbl.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (const row of this.table.rows) addRow(tbody, row, 'td')
    tbl.appendChild(tbody)
    wrap.appendChild(tbl)
    return wrap
  }
}

const MAX_SCAN_LENGTH = 512_000 // skip table scanning on pathological docs

export function buildTableDecorations(state: EditorState): DecorationSet {
  if (state.doc.length > MAX_SCAN_LENGTH) return Decoration.none
  const text = state.doc.toString()
  if (!text.includes('|')) return Decoration.none
  const builder = new RangeSetBuilder<Decoration>()
  for (const t of scanTables(text)) {
    // Cursor/selection inside the table OR on an adjacent line → reveal raw
    // markdown. Adjacency is load-bearing: a block-replace range acts like a
    // fold, so vertical cursor motion (arrows, vim j/k) SKIPS it — the cursor
    // can never land inside a rendered table. Landing next to it unfolds it,
    // and the next keypress enters the real lines.
    const fromLine = state.doc.lineAt(t.from)
    const toLine = state.doc.lineAt(Math.min(t.to, state.doc.length))
    const revealFrom = fromLine.number > 1 ? state.doc.line(fromLine.number - 1).from : t.from
    const revealTo = toLine.number < state.doc.lines ? state.doc.line(toLine.number + 1).to : t.to
    const revealed = state.selection.ranges.some((r) => r.from <= revealTo && r.to >= revealFrom)
    if (revealed) continue
    builder.add(t.from, t.to, Decoration.replace({
      widget: new TableWidget(t, text.slice(t.from, t.to)),
      block: true,
    }))
  }
  return builder.finish()
}

const tableField = StateField.define<DecorationSet>({
  create: buildTableDecorations,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value
    return buildTableDecorations(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

const tableStyles = EditorView.baseTheme({
  '.cm-table-widget': {
    padding: '4px 0',
    overflowX: 'auto',
  },
  '.cm-table-widget table': {
    borderCollapse: 'collapse',
    fontSize: '0.95em',
  },
  '.cm-table-widget th, .cm-table-widget td': {
    border: '1px solid var(--color-border, #27272a)',
    padding: '3px 10px',
    textAlign: 'left',
    verticalAlign: 'top',
    cursor: 'text',
  },
  '.cm-table-widget th': {
    backgroundColor: 'var(--color-surface-1, #18181b)',
    fontWeight: '600',
    fontFamily: 'var(--font-sans, system-ui, sans-serif)',
  },
  '.cm-table-widget tr:hover td': {
    backgroundColor: 'var(--color-surface-1, #18181b)',
  },
})

export function tablePreview(): Extension {
  return [tableField, tableStyles]
}
