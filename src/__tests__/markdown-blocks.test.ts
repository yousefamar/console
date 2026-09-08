import { describe, it, expect } from 'vitest'
import { segmentBlocks, unquoteLine, isQuoteLine } from '@/agents/markdown-blocks'

describe('segmentBlocks — blockquotes', () => {
  it('a run of `>` lines becomes ONE quote segment with the marker stripped', () => {
    const segs = segmentBlocks('before\n> first line\n> second line\nafter')
    expect(segs).toEqual([
      { kind: 'text', lines: ['before'] },
      { kind: 'quote', lines: ['first line', 'second line'] },
      { kind: 'text', lines: ['after'] },
    ])
  })

  it('strips exactly one level so nested quotes recurse (`> > x` → `> x`)', () => {
    expect(unquoteLine('> > inner')).toBe('> inner')
    expect(unquoteLine('>no space')).toBe('no space')
    expect(unquoteLine('>')).toBe('')
    expect(unquoteLine('   > indented up to 3')).toBe('indented up to 3')
    const [seg] = segmentBlocks('> outer\n> > inner')
    expect(seg).toEqual({ kind: 'quote', lines: ['outer', '> inner'] })
    expect(segmentBlocks((seg as { lines: string[] }).lines.join('\n'))).toEqual([
      { kind: 'text', lines: ['outer'] },
      { kind: 'quote', lines: ['inner'] },
    ])
  })

  it('a blank `>` line stays inside the quote as a paragraph break', () => {
    expect(segmentBlocks('> a\n>\n> b')).toEqual([{ kind: 'quote', lines: ['a', '', 'b'] }])
  })

  it('a `>` mid-line is not a quote; 4+ leading spaces is not a quote', () => {
    expect(isQuoteLine('x > y')).toBe(false)
    expect(isQuoteLine('    > code-ish')).toBe(false)
    expect(segmentBlocks('a > b')).toEqual([{ kind: 'text', lines: ['a > b'] }])
  })

  it('tables still segment, and a quote can directly follow a table', () => {
    const segs = segmentBlocks('| h |\n|---|\n| c |\n> q')
    expect(segs).toEqual([
      { kind: 'table', header: '| h |', body: ['| c |'] },
      { kind: 'quote', lines: ['q'] },
    ])
  })

  it('a table inside a quote survives one unquote pass', () => {
    const [seg] = segmentBlocks('> | h |\n> |---|\n> | c |')
    expect(segmentBlocks((seg as { lines: string[] }).lines.join('\n'))).toEqual([
      { kind: 'table', header: '| h |', body: ['| c |'] },
    ])
  })
})
