import { describe, it, expect } from 'vitest'
import { buildMergeRequest, buildChildMergeRequest, buildMergeEnvelope, buildForkSeed } from '../agents/merge.js'

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

describe('buildChildMergeRequest', () => {
  it('names the manager and asks the org child to summarise its whole role', () => {
    const r = buildChildMergeRequest('Console general')
    expect(r).toContain('Console general')
    expect(r).toContain('MERGE')
    expect(r).toMatch(/manager/i)
    expect(r).toMatch(/Memory/) // org child folds in its durable notes
    expect(r).toMatch(/final message|closed/i)
    expect(r).not.toMatch(/you are a fork/i) // it's NOT a fork
  })
})

describe('buildMergeEnvelope', () => {
  it('wraps the fork summary as an absorb-this event', () => {
    const e = buildMergeEnvelope('Gravel general (fork)', 'Found the auth uses mTLS; rotated keys via vault.')
    expect(e).toContain('Gravel general (fork)')
    expect(e).toContain('mTLS')
    expect(e).toMatch(/fork/)
    expect(e).toMatch(/Memory/)
  })
  it('handles an empty summary gracefully', () => {
    const e = buildMergeEnvelope('x (fork)', '')
    expect(e).toContain('no summary')
  })
  it('labels an absorbed org agent (kind=agent) and notes role absorption', () => {
    const e = buildMergeEnvelope('Geocaching', 'Owns the gc.com scraper; daily budget 400.', 'agent')
    expect(e).toContain('Geocaching')
    expect(e).toContain('budget 400')
    expect(e).toMatch(/agent/)
    expect(e).toMatch(/absorbed its role/)
  })
})
