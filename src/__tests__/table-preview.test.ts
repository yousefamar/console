import { describe, it, expect } from 'vitest'
import { scanTables, splitRow } from '../notes/table-preview'

describe('splitRow', () => {
  it('splits pipe-delimited cells, trimming whitespace', () => {
    expect(splitRow('| a | b | c |').map((c) => c.text)).toEqual(['a', 'b', 'c'])
  })
  it('handles missing leading/trailing pipes', () => {
    expect(splitRow('a | b').map((c) => c.text)).toEqual(['a', 'b'])
  })
  it('escaped \\| is a literal pipe, not a cell boundary', () => {
    expect(splitRow('| a \\| b | c |').map((c) => c.text)).toEqual(['a | b', 'c'])
  })
  it('records cell content offsets for click-to-edit', () => {
    const cells = splitRow('| foo | bar |')
    expect('| foo | bar |'.slice(cells[0]!.start)).toMatch(/^foo/)
    expect('| foo | bar |'.slice(cells[1]!.start)).toMatch(/^bar/)
  })
  it('keeps empty cells', () => {
    expect(splitRow('| a |  | c |').map((c) => c.text)).toEqual(['a', '', 'c'])
  })
})

describe('scanTables', () => {
  it('finds a GFM table with alignment', () => {
    const text = 'before\n\n| Name | Qty |\n|:-----|----:|\n| foo  | 1   |\n| bar  | 2   |\n\nafter'
    const tables = scanTables(text)
    expect(tables).toHaveLength(1)
    const t = tables[0]!
    expect(t.aligns).toEqual(['left', 'right'])
    expect(t.header.cells.map((c) => c.text)).toEqual(['Name', 'Qty'])
    expect(t.rows).toHaveLength(2)
    expect(text.slice(t.from, t.to)).toBe('| Name | Qty |\n|:-----|----:|\n| foo  | 1   |\n| bar  | 2   |')
  })

  it('a pipe line without a delimiter row is NOT a table', () => {
    expect(scanTables('| just | prose |\nmore prose')).toHaveLength(0)
  })

  it('ignores tables inside fenced code blocks', () => {
    const text = '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n'
    expect(scanTables(text)).toHaveLength(0)
  })

  it('table ends at a blank line', () => {
    const text = '| a |\n|---|\n| 1 |\n\n| not part |'
    const t = scanTables(text)
    expect(t).toHaveLength(1)
    expect(t[0]!.rows).toHaveLength(1)
  })

  it('finds multiple tables', () => {
    const text = '| a |\n|---|\n| 1 |\n\ntext\n\n| b |\n|---|\n| 2 |'
    expect(scanTables(text)).toHaveLength(2)
  })

  it('header-only table (no body rows) still renders', () => {
    const t = scanTables('| a | b |\n|---|---|')
    expect(t).toHaveLength(1)
    expect(t[0]!.rows).toHaveLength(0)
  })

  it('center alignment', () => {
    expect(scanTables('| a |\n|:-:|\n| 1 |')[0]!.aligns).toEqual(['center'])
  })
})

