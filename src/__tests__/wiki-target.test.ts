import { describe, it, expect } from 'vitest'
import { wikiTarget, wikiDisplay, resolveWikiTarget } from '../notes/wiki-target'

const VAULT = [
  'projects/console/index.md',
  'projects/astera/index.md',
  'log/2026-08-01-note.md',
  'scratch/ideas.md',
]

describe('wikiTarget', () => {
  it('unique basename → short form', () => {
    expect(wikiTarget('scratch/ideas.md', VAULT)).toBe('ideas')
  })
  it('ambiguous basename (many index.md) → full path', () => {
    expect(wikiTarget('projects/console/index.md', VAULT)).toBe('projects/console/index')
  })
})

describe('wikiDisplay', () => {
  it('basename without .md', () => {
    expect(wikiDisplay('projects/console/index.md')).toBe('index')
    expect(wikiDisplay('scratch/ideas.md')).toBe('ideas')
  })
})

describe('resolveWikiTarget', () => {
  it('full-path target wins over basename scan', () => {
    expect(resolveWikiTarget('projects/astera/index', VAULT)).toBe('projects/astera/index.md')
  })
  it('bare basename resolves to first match (legacy links)', () => {
    expect(resolveWikiTarget('ideas', VAULT)).toBe('scratch/ideas.md')
    expect(resolveWikiTarget('index', VAULT)).toBe('projects/console/index.md')
  })
  it('unknown → null', () => {
    expect(resolveWikiTarget('nope', VAULT)).toBeNull()
  })
})
