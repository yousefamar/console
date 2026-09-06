// Pure pipe-table edits for list notes. A list is `| Item | Added | …enrichment
// columns |`; the ring appends the raw row in µs, the ListWatcher fills the
// rest later. Column widths follow the header so hand-padded tables stay
// aligned; a table missing columns is migrated in place (header, separator,
// and every row get the new cells).

export interface ParsedTable {
  /** Line index of the header row in the note. */
  start: number
  /** Line index AFTER the last row. */
  end: number
  columns: string[]
  rows: Array<{ line: number; cells: string[] }>
}

const cell = (s: string) => s.replace(/\|/g, '/').trim()

function splitRow(line: string): string[] | null {
  const t = line.trim()
  if (!t.startsWith('|') || !t.endsWith('|')) return null
  return t.slice(1, -1).split('|').map((c) => c.trim())
}

function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c))
}

/** First pipe table in the note (the ring only ever writes one per list). */
export function parseTable(lines: string[]): ParsedTable | null {
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = splitRow(lines[i]!)
    const sep = splitRow(lines[i + 1]!)
    if (!header || !sep || !isSeparator(sep)) continue
    const rows: ParsedTable['rows'] = []
    let j = i + 2
    for (; j < lines.length; j++) {
      const cells = splitRow(lines[j]!)
      if (!cells) break
      // A row of only blank cells is editor residue, not data.
      if (cells.every((c) => !c)) continue
      rows.push({ line: j, cells })
    }
    return { start: i, end: j, columns: header, rows }
  }
  return null
}

function renderRow(cells: string[], widths: number[]): string {
  return `|${cells.map((c, i) => ` ${cell(c).padEnd(Math.max(widths[i] ?? 0, cell(c).length))} `).join('|')}|`
}

function widthsOf(columns: string[]): number[] {
  return columns.map((c) => c.length)
}

/** Header/separator/rows with `columns` guaranteed present (appended when
 *  missing; existing rows padded). Returns the new lines + the table. */
export function ensureColumns(lines: string[], columns: string[]): { lines: string[]; table: ParsedTable } {
  const out = [...lines]
  let table = parseTable(out)
  if (!table) {
    // No table: start one at the end, after any existing content.
    while (out.length && !out.at(-1)!.trim()) out.pop()
    const w = widthsOf(columns)
    if (out.length) out.push('')
    out.push(renderRow(columns, w), `|${columns.map((_, i) => ` ${'-'.repeat(Math.max(3, w[i]!))} `).join('|')}|`)
    table = parseTable(out)!
    return { lines: out, table }
  }
  const missing = columns.filter((c) => !table!.columns.some((h) => h.toLowerCase() === c.toLowerCase()))
  if (!missing.length) return { lines: out, table }
  const newColumns = [...table.columns, ...missing]
  const w = widthsOf(newColumns)
  out[table.start] = renderRow(newColumns, w)
  out[table.start + 1] = `|${newColumns.map((_, i) => ` ${'-'.repeat(Math.max(3, w[i]!))} `).join('|')}|`
  for (const r of table.rows) out[r.line] = renderRow([...r.cells, ...missing.map(() => '')], w)
  return { lines: out, table: parseTable(out)! }
}

/** Append a row; `values` keyed by column name (case-insensitive), the rest blank. */
export function appendRow(existing: string | null, columns: string[], values: Record<string, string>): string {
  const { lines, table } = ensureColumns((existing ?? '').replace(/\s+$/, '').split('\n').filter((l, i, a) => !(i === 0 && l === '' && a.length === 1)), columns)
  const w = table.columns.map((c, i) => Math.max(c.length, ...table.rows.map((r) => (r.cells[i] ?? '').length)))
  const cells = table.columns.map((c) => values[Object.keys(values).find((k) => k.toLowerCase() === c.toLowerCase()) ?? ''] ?? '')
  lines.splice(table.end, 0, renderRow(cells, w))
  return `${lines.join('\n')}\n`
}

/** Replace cells of the row at `line` (only the given columns change). */
export function setCells(existing: string, line: number, values: Record<string, string>): string {
  const lines = existing.split('\n')
  const table = parseTable(lines)
  if (!table) return existing
  const row = table.rows.find((r) => r.line === line)
  if (!row) return existing
  const w = table.columns.map((c, i) => Math.max(c.length, ...table.rows.map((r) => (r.cells[i] ?? '').length)))
  const cells = table.columns.map((c, i) => {
    const k = Object.keys(values).find((x) => x.toLowerCase() === c.toLowerCase())
    return k ? values[k]! : (row.cells[i] ?? '')
  })
  lines[line] = renderRow(cells, w)
  return lines.join('\n')
}

/** Row → { column: value } view. */
export function rowRecord(table: ParsedTable, row: { cells: string[] }): Record<string, string> {
  const out: Record<string, string> = {}
  table.columns.forEach((c, i) => { out[c.toLowerCase()] = row.cells[i] ?? '' })
  return out
}

export function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`
}

/** Drop the row at `line` (queue semantics — the item left the list). */
export function removeRow(existing: string, line: number): string {
  const lines = existing.split('\n')
  const table = parseTable(lines)
  if (!table || !table.rows.some((r) => r.line === line)) return existing
  lines.splice(line, 1)
  return lines.join('\n')
}
