// cli/src/detail-lines.ts — how `con board … --detail` becomes detail lines.
import { describe, it, expect } from 'vitest'
import { detailLines } from '../../cli/src/detail-lines'

describe('con board --detail', () => {
  it('pipe-separated bullets, as documented', () => {
    expect(detailLines('first | second|third ')).toEqual(['first', 'second', 'third'])
    expect(detailLines('one')).toEqual(['one'])
    expect(detailLines('')).toBeUndefined()
    expect(detailLines(undefined)).toBeUndefined()
    expect(detailLines('a||b|')).toEqual(['a', 'b'])
  })

  it('a value with newlines is split on those, and its pipes are text', () => {
    // ^odd-newt, 10 Oct 2026: this came out as "remote ('forge'", "'local'", "null); …".
    const detail = "Wire: CardView ships remote ('forge' | 'local' | null)\nLevels low | medium | high"
    expect(detailLines(detail)).toEqual(["Wire: CardView ships remote ('forge' | 'local' | null)", 'Levels low | medium | high'])
    expect(detailLines('only line\n')).toEqual(['only line'])
  })

  it('an escaped pipe is one literal pipe in the pipe-separated form', () => {
    expect(detailLines("type is 'forge' \\| 'local'|second bullet")).toEqual(["type is 'forge' | 'local'", 'second bullet'])
    expect(detailLines('grep x \\| wc -l')).toEqual(['grep x | wc -l'])
  })
})
