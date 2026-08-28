import { describe, it, expect } from 'vitest'
import { redactionTargetId } from '../matrix/redaction'

describe('redactionTargetId', () => {
  it('reads spec-v11 content.redacts', () => {
    expect(redactionTargetId({ content: { redacts: '$a' } })).toBe('$a')
  })

  it('reads pre-v11 top-level redacts (Beeper hungryserv shape)', () => {
    expect(redactionTargetId({ content: { reason: 'x' }, redacts: '$b' })).toBe('$b')
  })

  it('prefers content over top-level', () => {
    expect(redactionTargetId({ content: { redacts: '$a' }, redacts: '$b' })).toBe('$a')
  })

  it('returns undefined when neither present or non-string', () => {
    expect(redactionTargetId({ content: {} })).toBeUndefined()
    expect(redactionTargetId({})).toBeUndefined()
    expect(redactionTargetId({ content: { redacts: 42 as unknown as string } })).toBeUndefined()
    expect(redactionTargetId({ content: { redacts: '' }, redacts: '' })).toBeUndefined()
  })
})
