import { describe, it, expect } from 'vitest'
import { findBlockedTerm } from '../al/whatsapp.js'

describe('findBlockedTerm', () => {
  it('matches the address terms', () => {
    expect(findBlockedTerm('meet me at Blakes later?')).toBe('blakes')
    expect(findBlockedTerm('I live on Forbury Road')).toBe('forbury road')
    expect(findBlockedTerm('postcode is RG1 3JA')).toBe('rg1 3ja')
    expect(findBlockedTerm('postcode is rg13ja')).not.toBeNull()
  })

  it('is case-insensitive', () => {
    expect(findBlockedTerm('BLAKES')).toBe('blakes')
    expect(findBlockedTerm('FoRbUrY rOaD')).not.toBeNull()
  })

  it('ignores punctuation and extra/irregular whitespace', () => {
    expect(findBlockedTerm('rg1-3ja')).not.toBeNull()
    expect(findBlockedTerm('RG1,   3JA')).not.toBeNull()
    expect(findBlockedTerm('forbury\nroad')).not.toBeNull()
    expect(findBlockedTerm('forbury   road')).not.toBeNull()
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
