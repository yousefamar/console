import { describe, it, expect } from 'vitest'
import { findHeadingLine } from '@/notes/open-subscribe'

const DOC = `---
title: Foo
---

# Foo

Intro text.

## Open questions

- a

### Deep heading

done
`

describe('findHeadingLine', () => {
  it('finds a top-level heading', () => {
    expect(findHeadingLine(DOC, 'Foo')).toBe(4)
  })

  it('finds a nested heading at any level', () => {
    expect(findHeadingLine(DOC, 'Open questions')).toBe(8)
    expect(findHeadingLine(DOC, 'Deep heading')).toBe(12)
  })

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(findHeadingLine(DOC, '  open QUESTIONS ')).toBe(8)
  })

  it('returns null for an absent heading rather than guessing', () => {
    expect(findHeadingLine(DOC, 'Nope')).toBeNull()
  })

  it('returns null for an empty anchor', () => {
    expect(findHeadingLine(DOC, '   ')).toBeNull()
  })

  it('does not match a partial heading', () => {
    expect(findHeadingLine(DOC, 'Open')).toBeNull()
  })
})
