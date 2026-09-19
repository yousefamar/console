import { describe, it, expect } from 'vitest'
import { segmentBlocks, unquoteLine, isQuoteLine, prepareTranscriptText } from '@/agents/markdown-blocks'

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

describe('headings + lists (^gray-bat: vault-note peeks, transcript parity)', () => {
  it('headings are their own segment with level + text; closing #s stripped', () => {
    expect(segmentBlocks('## Backlog ##\nbody').slice(0, 1)).toEqual([{ kind: 'heading', level: 2, text: 'Backlog' }])
    expect(segmentBlocks('#nothash')).toEqual([{ kind: 'text', lines: ['#nothash'] }])
  })
  it('a run of list lines is one list; bullets, ordered numbers, task boxes, depth', () => {
    const [seg] = segmentBlocks('- a\n  - b\n- [ ] todo\n- [x] done\n3. third')
    expect(seg).toEqual({ kind: 'list', items: [
      { depth: 0, ordered: false, checked: undefined, text: 'a' },
      { depth: 1, ordered: false, checked: undefined, text: 'b' },
      { depth: 0, ordered: false, checked: false, text: 'todo' },
      { depth: 0, ordered: false, checked: true, text: 'done' },
      { depth: 0, ordered: true, num: 3, checked: undefined, text: 'third' },
    ] })
  })
  it('an indented continuation line folds into the item; a blank line ends the list', () => {
    const segs = segmentBlocks('- first line\n  continues here\n\nplain')
    expect(segs[0]).toEqual({ kind: 'list', items: [{ depth: 0, ordered: false, checked: undefined, text: 'first line continues here' }] })
    expect(segs[1]).toEqual({ kind: 'text', lines: ['', 'plain'] })
  })
  it('dashes without a following space are not lists (`---`, `-x`)', () => {
    expect(segmentBlocks('---\n-x\n2026 - a year').every((s) => s.kind === 'text')).toBe(true)
  })
})

describe('list nesting (^keen-boar: sub-bullets rendered flat)', () => {
  const depths = (md: string) => (segmentBlocks(md)[0] as { items: { depth: number }[] }).items.map((it) => it.depth)

  it('the reported shape: `- **bold**` parents with two-space `- ` children nest one level', () => {
    expect(depths('- **Email in** foo\n  - Agree: x\n  - Disagree: y\n- **Email out** bar\n  - Agree: z')).toEqual([0, 1, 1, 0, 1])
  })
  it('depth is relative to the enclosing item, not indent/2 (four-space children are depth 1)', () => {
    expect(depths('- a\n    - b\n        - c\n- d')).toEqual([0, 1, 2, 0])
    expect(depths('1. a\n   - b\n   - c\n2. d')).toEqual([0, 1, 1, 0])
    expect(depths('- a\n\t- b\n\t\t- c')).toEqual([0, 1, 2])
  })
  it('a child indented less than its would-be parent closes back to the matching ancestor', () => {
    expect(depths('- a\n  - b\n    - c\n  - d\n- e')).toEqual([0, 1, 2, 1, 0])
    expect(depths('- a\n  - b\n   - c')).toEqual([0, 1, 1])
  })
  it('prepareTranscriptText keeps list indentation and fenced code, strips the handoff sentinel', () => {
    expect(prepareTranscriptText('- a\n  - b\n\n```\n    indented\n```\n@handoff(al-x) done  \n')).toBe('- a\n  - b\n\n```\n    indented\n```\n done')
  })
  it('runs of spaces collapse only inside prose text segments', () => {
    expect(segmentBlocks('col   a    b\n- x  y')).toEqual([
      { kind: 'text', lines: ['col a b'] },
      { kind: 'list', items: [{ depth: 0, ordered: false, checked: undefined, text: 'x  y' }] },
    ])
  })
})
