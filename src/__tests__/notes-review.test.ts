import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { reviewCompartment, reviewExtension, remainingChunks, mayResolveChunks, acceptedChunk, currentOriginal } from '@/notes/review'

const mkState = (doc: string, original?: string) =>
  EditorState.create({
    doc,
    extensions: [reviewCompartment.of(original === undefined ? [] : reviewExtension(original))],
  })

describe('review mode chunks', () => {
  it('null when review is not configured', () => {
    expect(remainingChunks(mkState('hello\n'))).toBeNull()
  })

  it('0 chunks when agent text equals the base', () => {
    expect(remainingChunks(mkState('same\ntext\n', 'same\ntext\n'))).toBe(0)
  })

  it('counts changed regions against the base', () => {
    const original = 'alpha\nbravo\ncharlie\ndelta\n'
    const edited = 'alpha\nbravo NEW\ncharlie\ndelta\nappended\n'
    const n = remainingChunks(mkState(edited, original))
    expect(n).toBeGreaterThanOrEqual(1)
  })

  it('a word-level rewrite is one chunk, not per-word', () => {
    const original = 'the quick brown fox\n'
    const edited = 'the slow brown wolf\n'
    expect(remainingChunks(mkState(edited, original))).toBe(1)
  })
})

describe('mayResolveChunks', () => {
  const tx = (events: string[]) => ({ isUserEvent: (e: string) => events.includes(e) })

  it('true on buffer edits (reject/typing)', () => {
    expect(mayResolveChunks({ docChanged: true, transactions: [tx([])] })).toBe(true)
  })

  it('true on accept transactions even though the buffer is unchanged', () => {
    // acceptChunk rewrites only the merge view's ORIGINAL doc — docChanged
    // stays false. This is the "0 pending changes but banner stuck" bug.
    expect(mayResolveChunks({ docChanged: false, transactions: [tx(['accept'])] })).toBe(true)
  })

  it('false on unrelated non-doc transactions (selection, focus)', () => {
    expect(mayResolveChunks({ docChanged: false, transactions: [tx([])] })).toBe(false)
    expect(mayResolveChunks({ docChanged: false, transactions: [] })).toBe(false)
  })
})

describe('currentOriginal', () => {
  it('null when review is not configured', () => {
    expect(currentOriginal(mkState('hello\n'))).toBeNull()
  })

  it('returns the merge view original the review was configured with', () => {
    expect(currentOriginal(mkState('edited\n', 'base\n'))).toBe('base\n')
  })
})

describe('acceptedChunk', () => {
  const tx = (events: string[]) => ({ isUserEvent: (e: string) => events.includes(e) })

  it('true only for accept transactions', () => {
    expect(acceptedChunk({ docChanged: false, transactions: [tx(['accept'])] })).toBe(true)
    expect(acceptedChunk({ docChanged: true, transactions: [tx([])] })).toBe(false)
    expect(acceptedChunk({ docChanged: false, transactions: [] })).toBe(false)
  })
})
