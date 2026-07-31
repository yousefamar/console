// Pure aggregation for the Home-tab Bedrock spend chart. The load-bearing
// behaviours (each of which silently produced a wrong/empty chart during
// development) are: classify Bedrock spend off the Marketplace service-name
// suffix, map `owner$` → `untagged`, and rank owners with `untagged` last.

import { describe, it, expect } from 'vitest'
import { buildCostReport, parseOwnerKey, parseBedrockModel, costWindow, OWNER_TAG_EPOCH, type CeResponse } from '../aws-costs.js'

function group(owner: string, service: string, amount: string) {
  return { Keys: [owner, service], Metrics: { UnblendedCost: { Amount: amount, Unit: 'USD' } } }
}
function bucket(start: string, end: string, groups: ReturnType<typeof group>[]) {
  return { TimePeriod: { Start: start, End: end }, Groups: groups }
}

describe('parseOwnerKey', () => {
  it('extracts the tag value', () => {
    expect(parseOwnerKey('owner$amar')).toBe('amar')
    expect(parseOwnerKey('owner$guest1')).toBe('guest1')
  })
  it('maps an empty tag value to untagged', () => {
    // CE emits `owner$` for resources with no such tag — that's most Bedrock
    // spend, since bare model ids bypass the tagged inference profiles.
    expect(parseOwnerKey('owner$')).toBe('untagged')
    expect(parseOwnerKey('')).toBe('untagged')
  })
})

describe('parseBedrockModel', () => {
  it('strips the Marketplace suffix', () => {
    expect(parseBedrockModel('Claude Opus 5 (Amazon Bedrock Edition)')).toBe('Claude Opus 5')
    expect(parseBedrockModel('OpenAI GPT-5.4 (Amazon Bedrock Edition)')).toBe('OpenAI GPT-5.4')
  })
  it('rejects non-Bedrock services', () => {
    // This is what makes the unfiltered CE query safe — everything else drops.
    expect(parseBedrockModel('Amazon Elastic Compute Cloud - Compute')).toBeNull()
    expect(parseBedrockModel('Amazon Bedrock')).toBeNull() // reports $0; not a Marketplace product
    expect(parseBedrockModel('Tax')).toBeNull()
  })
})

describe('buildCostReport', () => {
  it('aggregates per day by owner and model, dropping non-Bedrock services', () => {
    const res: CeResponse = {
      ResultsByTime: [
        bucket('2026-07-29', '2026-07-30', [
          group('owner$amar', 'Claude Opus 5 (Amazon Bedrock Edition)', '2'),
          group('owner$guest1', 'Claude Opus 5 (Amazon Bedrock Edition)', '3'),
          group('owner$', 'Claude Fable 5 (Amazon Bedrock Edition)', '10'),
          group('owner$', 'Amazon Elastic Compute Cloud - Compute', '99'), // dropped
        ]),
        bucket('2026-07-30', '2026-07-31', [
          group('owner$amar', 'Claude Fable 5 (Amazon Bedrock Edition)', '1'),
        ]),
      ],
    }
    const r = buildCostReport(res)
    expect(r.days).toHaveLength(2)
    expect(r.days[0]!.byOwner).toEqual({ amar: 2, guest1: 3, untagged: 10 })
    expect(r.days[0]!.byModel).toEqual({ 'Claude Opus 5': 5, 'Claude Fable 5': 10 })
    expect(r.days[0]!.usd).toBe(15) // EC2's $99 excluded
    expect(r.days[1]!.byOwner).toEqual({ amar: 1 })
    expect(r.totalUsd).toBe(16)
    expect(r.totalByOwner).toEqual({ amar: 3, guest1: 3, untagged: 10 })
    expect(r.totalByModel).toEqual({ 'Claude Opus 5': 5, 'Claude Fable 5': 11 })
    expect(r.empty).toBe(false)
    expect(r.start).toBe('2026-07-29')
    expect(r.end).toBe('2026-07-31') // exclusive, matches the query
  })

  it('ranks owners by spend but always sorts untagged last', () => {
    // untagged dominates in practice; it must not take the first stack slot.
    const res: CeResponse = {
      ResultsByTime: [
        bucket('2026-07-29', '2026-07-30', [
          group('owner$', 'Claude Opus 5 (Amazon Bedrock Edition)', '500'),
          group('owner$amar', 'Claude Opus 5 (Amazon Bedrock Edition)', '2'),
          group('owner$sam', 'Claude Opus 5 (Amazon Bedrock Edition)', '9'),
        ]),
      ],
    }
    expect(buildCostReport(res).owners).toEqual(['sam', 'amar', 'untagged'])
  })

  it('keeps zero-spend days as buckets so the time axis has no holes', () => {
    const res: CeResponse = {
      ResultsByTime: [
        bucket('2026-07-29', '2026-07-30', [group('owner$amar', 'Claude Opus 5 (Amazon Bedrock Edition)', '1')]),
        bucket('2026-07-30', '2026-07-31', []),
      ],
    }
    const r = buildCostReport(res)
    expect(r.days).toHaveLength(2)
    expect(r.days[1]!.usd).toBe(0)
    expect(r.days[1]!.byOwner).toEqual({})
  })

  it('flags an all-zero window as empty rather than erroring', () => {
    const res: CeResponse = {
      ResultsByTime: [bucket('2026-07-29', '2026-07-30', [group('owner$', 'AWS Lambda', '0')])],
    }
    const r = buildCostReport(res)
    expect(r.empty).toBe(true)
    expect(r.owners).toEqual([])
  })

  it('carries the owner-tag activation epoch so the UI can mark unattributable days', () => {
    // Tag activation (2026-07-29) is not backfilled — everything earlier is
    // untagged by construction, and the chart must say so rather than implying
    // one person spent it all.
    expect(buildCostReport({}).ownerTagEpoch).toBe(OWNER_TAG_EPOCH)
    expect(OWNER_TAG_EPOCH).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('averages complete days only, reporting today separately', () => {
    // Today's CE bucket is real but partially billed, so averaging it in would
    // make the headline figure sag every morning and recover by night.
    const res: CeResponse = {
      ResultsByTime: [
        bucket('2026-07-29', '2026-07-30', [group('owner$amar', 'Claude Opus 5 (Amazon Bedrock Edition)', '10')]),
        bucket('2026-07-30', '2026-07-31', [group('owner$amar', 'Claude Opus 5 (Amazon Bedrock Edition)', '20')]),
        bucket('2026-07-31', '2026-08-01', [group('owner$amar', 'Claude Opus 5 (Amazon Bedrock Edition)', '1')]),
      ],
    }
    const r = buildCostReport(res, { today: '2026-07-31' })
    expect(r.totalUsd).toBe(31) // today still counts toward the total
    expect(r.avgPerDayUsd).toBe(15) // (10 + 20) / 2, not 31/3
    expect(r.avgDayCount).toBe(2)
    expect(r.todayUsd).toBe(1)
  })

  it('reports a zero average when the window holds only today', () => {
    const res: CeResponse = {
      ResultsByTime: [
        bucket('2026-07-31', '2026-08-01', [group('owner$amar', 'Claude Opus 5 (Amazon Bedrock Edition)', '5')]),
      ],
    }
    const r = buildCostReport(res, { today: '2026-07-31' })
    expect(r.avgDayCount).toBe(0)
    expect(r.avgPerDayUsd).toBe(0) // no complete day to average — don't divide by zero
    expect(r.todayUsd).toBe(5)
  })

  it('tolerates a malformed / empty response', () => {
    expect(buildCostReport({}).days).toEqual([])
    expect(buildCostReport({ ResultsByTime: [{ Groups: [{ Keys: ['owner$amar'] }] }] }).days).toEqual([])
  })
})

describe('costWindow', () => {
  it('ends tomorrow so today\'s partial spend is inside the exclusive bound', () => {
    const now = new Date('2026-07-31T14:00:00Z')
    expect(costWindow(7, now)).toEqual({ start: '2026-07-25', end: '2026-08-01' })
    expect(costWindow(1, now)).toEqual({ start: '2026-07-31', end: '2026-08-01' })
  })
  it('clamps nonsense day counts', () => {
    const now = new Date('2026-07-31T00:00:00Z')
    expect(costWindow(0, now).start).toBe('2026-07-02') // 0 → default 30
    expect(costWindow(-5, now).start).toBe('2026-07-31') // negative → 1
    expect(costWindow(9999, now).start).toBe('2026-02-02') // capped at 180
  })
})
