import { describe, it, expect } from 'vitest'
import { buildMergeRequest, buildMergeEnvelope, buildForkSeed } from '../agents/merge.js'

describe('buildForkSeed', () => {
  it('names the parent and marks the inherited/own-branch boundary', () => {
    const s = buildForkSeed('Gravel general')
    expect(s).toContain('Gravel general')
    expect(s).toContain('FORK')
    expect(s).toMatch(/inherited/i)
    expect(s).toMatch(/branch/i)
  })
})

describe('buildMergeRequest', () => {
  it('names the parent and asks for a concise final summary', () => {
    const r = buildMergeRequest('Gravel general')
    expect(r).toContain('Gravel general')
    expect(r).toContain('MERGE')
    expect(r).toMatch(/concise|summary/i)
    expect(r).toMatch(/final message|closed/i)
  })
})

describe('buildMergeEnvelope', () => {
  it('wraps the fork summary as an absorb-this event', () => {
    const e = buildMergeEnvelope('Gravel general (fork)', 'Found the auth uses mTLS; rotated keys via vault.')
    expect(e).toContain('Gravel general (fork)')
    expect(e).toContain('mTLS')
    expect(e).toMatch(/Memory/)
  })
  it('handles an empty summary gracefully', () => {
    const e = buildMergeEnvelope('x (fork)', '')
    expect(e).toContain('no summary')
  })
})
