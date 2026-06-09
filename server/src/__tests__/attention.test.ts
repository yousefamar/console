import { describe, it, expect } from 'vitest'
import { mentionsAmar, extractAttentionSnippet } from '../attention.js'

describe('mentionsAmar', () => {
  it('matches a standalone @amar', () => {
    expect(mentionsAmar('I need eyes on this @amar please')).toBe(true)
    expect(mentionsAmar('@amar')).toBe(true)
    expect(mentionsAmar('done.\n@amar review?')).toBe(true)
    expect(mentionsAmar('(@amar)')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(mentionsAmar('@Amar')).toBe(true)
    expect(mentionsAmar('@AMAR')).toBe(true)
  })

  it('does NOT match an email like name@amar.io', () => {
    expect(mentionsAmar('reach me at yousef@amar.io')).toBe(false)
    expect(mentionsAmar('foo@amar.dev bar')).toBe(false)
  })

  it('does NOT match @amar embedded in a longer word', () => {
    expect(mentionsAmar('@amaranth is a plant')).toBe(false)
    expect(mentionsAmar('the @amarillo branch')).toBe(false)
  })

  it('handles empty / null', () => {
    expect(mentionsAmar('')).toBe(false)
    expect(mentionsAmar(undefined)).toBe(false)
    expect(mentionsAmar(null)).toBe(false)
  })
})

describe('extractAttentionSnippet', () => {
  it('centres the excerpt on the mention and collapses whitespace', () => {
    const snip = extractAttentionSnippet('Build is green.   @amar   can you review the auth change?')
    expect(snip).toContain('@amar')
    expect(snip).not.toMatch(/\s{2,}/) // whitespace collapsed
  })

  it('ellipsizes when the surrounding text is long', () => {
    const long = 'x'.repeat(200) + ' @amar ' + 'y'.repeat(200)
    const snip = extractAttentionSnippet(long)
    expect(snip.startsWith('…')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
    expect(snip).toContain('@amar')
    expect(snip.length).toBeLessThan(160)
  })

  it('does not ellipsize a short message', () => {
    const snip = extractAttentionSnippet('@amar quick q')
    expect(snip).toBe('@amar quick q')
  })
})
