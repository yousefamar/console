import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ForkCostLedger, aggregate, recordOf, type ForkLike } from '../agents/fork-cost.js'

const fork = (over: Partial<ForkLike> = {}): ForkLike => ({
  agentKey: 'eng-aa-fork', name: 'Aa (fork)', claudeSessionId: 'c1', parentClaudeSessionId: 'p1',
  forkContext: 'fresh', turnCount: 10, totalTokens: { input: 100, output: 50, cacheRead: 40_000, cacheCreation: 2_000 },
  totalCost: 1.5, createdAt: 1_000, ...over,
})

describe('ForkCostLedger', () => {
  it('appends one JSONL line per ended fork and reads them back (skipping garbage)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fork-cost-'))
    try {
      const file = join(dir, 'nested', 'fork-cost.jsonl')
      const ledger = new ForkCostLedger(file)
      const rec = ledger.record(fork(), 5_000)
      expect(rec).toMatchObject({ ts: 5_000, context: 'fresh', turns: 10, cost: 1.5, lifeMs: 4_000 })
      ledger.record(fork({ forkContext: 'inherited', totalTokens: { input: 1, output: 1, cacheRead: 1_300_000 } }), 6_000)
      writeFileSync(file, `${readFileSync(file, 'utf-8')}not json\n`)
      const all = ledger.read()
      expect(all).toHaveLength(2)
      expect(all[1]!.tokens.cacheRead).toBe(1_300_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a fork with no recorded mode lands in the unknown bucket', () => {
    expect(recordOf(fork({ forkContext: undefined })).context).toBe('unknown')
  })
})

describe('aggregate', () => {
  it('buckets ended + live forks by context and reports cache_read per turn', () => {
    const ended = [
      recordOf(fork(), 10),
      recordOf(fork({ forkContext: 'inherited', turnCount: 400, totalTokens: { input: 5, output: 5, cacheRead: 50_000_000 }, totalCost: 120 }), 20),
    ]
    const live = [fork({ turnCount: 5, totalTokens: { input: 1, output: 1, cacheRead: 15_000 }, totalCost: 0.5 })]
    const buckets = aggregate(ended, live)
    expect(buckets.map((b) => b.context)).toEqual(['fresh', 'inherited'])
    const fresh = buckets[0]!
    expect(fresh).toMatchObject({ sessions: 2, turns: 15, cacheRead: 55_000, cost: 2 })
    expect(fresh.cacheReadPerTurn).toBe(Math.round(55_000 / 15))
    const inh = buckets[1]!
    expect(inh.cacheReadPerTurn).toBe(125_000)
    expect(inh.costPerTurn).toBe(0.3)
  })

  it('sinceTs filters ended records only; live forks always count; non-forks are ignored', () => {
    const ended = [recordOf(fork(), 10), recordOf(fork(), 100)]
    const live = [fork(), fork({ parentClaudeSessionId: null })]
    const buckets = aggregate(ended, live, { sinceTs: 50 })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.sessions).toBe(2) // one ended (ts 100) + one live fork; the root session is skipped
  })

  it('zero turns never divides by zero', () => {
    const b = aggregate([recordOf(fork({ turnCount: 0 }))])
    expect(b[0]!.cacheReadPerTurn).toBe(0)
    expect(b[0]!.costPerTurn).toBe(0)
  })
})
