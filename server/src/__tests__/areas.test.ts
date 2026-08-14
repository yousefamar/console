import { describe, it, expect } from 'vitest'
import { validTags, isValidTag, lintTagPairs, type AreaRegistry } from '../areas.js'

const REGISTRY: AreaRegistry = {
  areas: [
    { slug: 'life', title: 'Life' },
    { slug: 'ai', title: 'AI' },
  ],
  reserved: ['projects'],
}

describe('validTags', () => {
  it('includes areas and reserved tags', () => {
    const v = validTags(REGISTRY)
    expect(v.has('life')).toBe(true)
    expect(v.has('ai')).toBe(true)
    expect(v.has('projects')).toBe(true)
    expect(v.has('gardening')).toBe(false)
  })
})

describe('isValidTag', () => {
  it('accepts registered, rejects unknown', () => {
    expect(isValidTag('life', REGISTRY)).toBe(true)
    expect(isValidTag('projects', REGISTRY)).toBe(true)
    expect(isValidTag('meta', REGISTRY)).toBe(false)
  })
})

describe('lintTagPairs', () => {
  it('reports every unknown tag with its file', () => {
    const issues = lintTagPairs(
      [
        { path: 'log/a.md', tags: ['life'] },
        { path: 'log/b.md', tags: ['gardening', 'ai'] },
        { path: 'log/c.md', tags: ['meta', 'typo'] },
      ],
      REGISTRY,
    )
    expect(issues).toEqual([
      { path: 'log/b.md', tag: 'gardening' },
      { path: 'log/c.md', tag: 'meta' },
      { path: 'log/c.md', tag: 'typo' },
    ])
  })

  it('empty registry flags everything (fail loud, not open)', () => {
    const empty: AreaRegistry = { areas: [], reserved: [] }
    const issues = lintTagPairs([{ path: 'log/a.md', tags: ['life'] }], empty)
    expect(issues).toHaveLength(1)
  })
})
