import { describe, it, expect } from 'vitest'
import { parseHandoff, HANDOFF_RE } from '../handoff.js'

describe('parseHandoff', () => {
  it('extracts the agentKey from @handoff(...)', () => {
    expect(parseHandoff('Sure — @handoff(feeds-tab) talk to them directly')).toBe('feeds-tab')
    expect(parseHandoff('@handoff(al)')).toBe('al')
    expect(parseHandoff('done.\n@handoff(money-tab)')).toBe('money-tab')
  })

  it('tolerates inner whitespace and is case-insensitive on the marker', () => {
    expect(parseHandoff('@handoff( cold-outreach )')).toBe('cold-outreach')
    expect(parseHandoff('@HandOff(travel)')).toBe('travel')
  })

  it('lowercases the key', () => {
    expect(parseHandoff('@handoff(Feeds-Tab)')).toBe('feeds-tab')
  })

  it('returns null when absent / malformed', () => {
    expect(parseHandoff('no handoff here')).toBeNull()
    expect(parseHandoff('@handoff()')).toBeNull()
    expect(parseHandoff('@handoff(bad key)')).toBeNull() // a space breaks the token → no match (safe)
    expect(parseHandoff('')).toBeNull()
    expect(parseHandoff(null)).toBeNull()
  })

  it('does not match an email-ish token', () => {
    expect(HANDOFF_RE.test('foo@handoff(x)')).toBe(false)
  })

  it('takes the first handoff when several appear', () => {
    expect(parseHandoff('@handoff(a-one) then @handoff(b-two)')).toBe('a-one')
  })
})
