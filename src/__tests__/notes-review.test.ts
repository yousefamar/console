import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { reviewCompartment, reviewExtension, remainingChunks } from '@/notes/review'

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
