import { describe, it, expect } from 'vitest'
import { findBlockedTerm } from '../al/whatsapp.js'

// Fixture terms only — the REAL terms live in ~/.config/console/
// wa-blocklist.json and must never appear in this repo (they were once
// hardcoded here while the repo was public; see card ^quick-tern).
const TERMS = ['acacia house', 'penny lane', 'ab1 2cd', 'ab12cd']

describe('findBlockedTerm', () => {
  it('matches the blocklist terms', () => {
    expect(findBlockedTerm('meet me at Acacia House later?', TERMS)).toBe('acacia house')
    expect(findBlockedTerm('I live on Penny Lane', TERMS)).toBe('penny lane')
    expect(findBlockedTerm('postcode is AB1 2CD', TERMS)).toBe('ab1 2cd')
    expect(findBlockedTerm('postcode is ab12cd', TERMS)).not.toBeNull()
  })

  it('is case-insensitive', () => {
    expect(findBlockedTerm('ACACIA HOUSE', TERMS)).toBe('acacia house')
    expect(findBlockedTerm('PeNnY lAnE', TERMS)).not.toBeNull()
  })

  it('ignores punctuation and extra/irregular whitespace', () => {
    expect(findBlockedTerm('ab1-2cd', TERMS)).not.toBeNull()
    expect(findBlockedTerm('AB1,   2CD', TERMS)).not.toBeNull()
    expect(findBlockedTerm('penny\nlane', TERMS)).not.toBeNull()
    expect(findBlockedTerm('penny   lane', TERMS)).not.toBeNull()
  })

  it('does NOT match normal chat, including bare component words', () => {
    expect(findBlockedTerm('hey how are you doing today', TERMS)).toBeNull()
    expect(findBlockedTerm('found a penny on the floor', TERMS)).toBeNull()
    expect(findBlockedTerm('take the next lane on the left', TERMS)).toBeNull()
  })

  it('handles empty text and empty blocklist', () => {
    expect(findBlockedTerm('', TERMS)).toBeNull()
    expect(findBlockedTerm('anything at all', [])).toBeNull()
  })
})
