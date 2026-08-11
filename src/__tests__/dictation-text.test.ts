import { describe, it, expect } from 'vitest'
import { dictationSeparator } from '@/utils/dictation-text'

const apply = (before: string, chunk: string, verbatim = false) =>
  before + dictationSeparator(before, chunk, verbatim) + chunk

describe('dictationSeparator — streaming token deltas (verbatim)', () => {
  it('never pads, so a mid-word delta stays joined', () => {
    // "structur" + "ally" is one word split across two tokens — the bug was
    // padding this into "structur ally".
    expect(apply('Okay structur', 'ally', true)).toBe('Okay structurally')
  })

  it('respects the space the delta carries itself', () => {
    expect(apply('Okay', ' structurally', true)).toBe('Okay structurally')
  })

  it('builds a whole sentence from token deltas', () => {
    const deltas = [' Okay', ' structur', 'ally', ' this', ' is', ' sound']
    expect(deltas.reduce((acc, d) => apply(acc, d, true), '')).toBe(' Okay structurally this is sound')
  })
})

describe('dictationSeparator — whole utterances (browser SR)', () => {
  it('inserts a space between two glued words', () => {
    expect(apply('hello world', 'how are you')).toContain('world how')
  })

  it('does not double an existing space', () => {
    expect(apply('hello world ', 'how are you')).toBe('hello world how are you')
  })

  it('does not pad after punctuation or at the start', () => {
    expect(apply('hello world.', 'How are you')).toBe('hello world.How are you')
    expect(apply('', 'hello')).toBe('hello')
  })
})
