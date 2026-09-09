import { describe, it, expect } from 'vitest'
import { compareSpacesForRail, spaceNeedsAttention } from '../spaces/rail-order'
import type { SpaceSummary } from '../store/spaces'

const project = (slug: string, extra: Partial<SpaceSummary> = {}): SpaceSummary => ({
  kind: 'project', slug, title: slug, notePath: null, boardPath: null, status: null, fileCount: 0, ...extra,
})

describe('spaceNeedsAttention', () => {
  it('an alert row hoists', () => {
    expect(spaceNeedsAttention(project('astera'), new Set(['astera']))).toBe(true)
  })
  it('an Under Review card hoists even with no alert row (card-owned fork hand-back)', () => {
    expect(spaceNeedsAttention(project('console', { reviewCount: 1 }), new Set())).toBe(true)
  })
  it('nothing waiting → not hoisted', () => {
    expect(spaceNeedsAttention(project('car', { reviewCount: 0 }), new Set())).toBe(false)
    expect(spaceNeedsAttention(project('car'), new Set())).toBe(false)
  })
})

describe('compareSpacesForRail', () => {
  it('review-only and alert-only spaces share the top tier, alphabetical within tiers', () => {
    const spaces = [project('zeta'), project('memo', { reviewCount: 2 }), project('astera'), project('car')]
    const sorted = [...spaces].sort(compareSpacesForRail(new Set(['astera'])))
    expect(sorted.map((s) => s.slug)).toEqual(['astera', 'memo', 'car', 'zeta'])
  })
})
