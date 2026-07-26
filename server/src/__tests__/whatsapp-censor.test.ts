import { describe, it, expect } from 'vitest'
import { findBlockedTerm } from '../al/whatsapp.js'

describe('findBlockedTerm', () => {
  it('matches the address terms', () => {
    expect(findBlockedTerm('meet me at [REDACTED] later?')).toBe('[REDACTED]')
    expect(findBlockedTerm('I live on [REDACTED]')).toBe('[REDACTED]')
    expect(findBlockedTerm('postcode is [REDACTED]')).toBe('[REDACTED]')
    expect(findBlockedTerm('postcode is [REDACTED]')).not.toBeNull()
  })

  it('is case-insensitive', () => {
    expect(findBlockedTerm('[REDACTED]')).toBe('[REDACTED]')
    expect(findBlockedTerm('[REDACTED]')).not.toBeNull()
  })

  it('ignores punctuation and extra/irregular whitespace', () => {
    expect(findBlockedTerm('[REDACTED]')).not.toBeNull()
    expect(findBlockedTerm('[REDACTED]')).not.toBeNull()
    expect(findBlockedTerm('[REDACTED]')).not.toBeNull()
    expect(findBlockedTerm('[REDACTED]')).not.toBeNull()
  })

  it('does NOT match normal chat, including the bare words reading/road', () => {
    expect(findBlockedTerm('hey how are you doing today')).toBeNull()
    expect(findBlockedTerm('are you reading this')).toBeNull()
    expect(findBlockedTerm('take the next road on the left')).toBeNull()
  })

  it('handles empty text', () => {
    expect(findBlockedTerm('')).toBeNull()
  })
})
