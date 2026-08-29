import { describe, it, expect } from 'vitest'
import { pickSpaceView, pathInScope, spaceScopePrefixes, VAULT_SPACE, UNASSIGNED_SPACE } from '../spaces/scope'
import type { SpaceSummary } from '../store/spaces'

const project = (slug: string): SpaceSummary => ({
  kind: 'project', slug, title: slug, notePath: null, boardPath: null, status: null, fileCount: 0,
})
const area = (slug: string): SpaceSummary => ({
  kind: 'area', slug, title: slug, notePath: null, boardPath: null, status: null, fileCount: 0,
})

describe('pickSpaceView', () => {
  it('board-only space lands on board regardless of memory', () => {
    expect(pickSpaceView({ hasBoard: true, hasOpenDoc: false, remembered: 'docs' })).toBe('board')
  })
  it('docs-only space lands on docs regardless of memory', () => {
    expect(pickSpaceView({ hasBoard: false, hasOpenDoc: true, remembered: 'board' })).toBe('docs')
  })
  it('neither side has content → docs (no board to show)', () => {
    expect(pickSpaceView({ hasBoard: false, hasOpenDoc: false, remembered: null })).toBe('docs')
  })
  it('both sides → remembered view', () => {
    expect(pickSpaceView({ hasBoard: true, hasOpenDoc: true, remembered: 'docs' })).toBe('docs')
    expect(pickSpaceView({ hasBoard: true, hasOpenDoc: true, remembered: 'board' })).toBe('board')
  })
  it('both sides, no memory → board default', () => {
    expect(pickSpaceView({ hasBoard: true, hasOpenDoc: true, remembered: null })).toBe('board')
  })
})

describe('pathInScope', () => {
  it('prefix match', () => {
    expect(pathInScope('projects/console/notes.md', ['projects/console/'])).toBe(true)
    expect(pathInScope('projects/consoleX/notes.md', ['projects/console/'])).toBe(false)
  })
  it('a dir prefix also claims the flat .md sibling', () => {
    expect(pathInScope('projects/console.md', ['projects/console/'])).toBe(true)
  })
})

describe('spaceScopePrefixes', () => {
  it('vault scopes to everything, unassigned to nothing', () => {
    expect(spaceScopePrefixes(VAULT_SPACE)).toEqual([''])
    expect(spaceScopePrefixes(UNASSIGNED_SPACE)).toEqual([])
  })
  it('projects own their folder, flat file, and legacy drafts', () => {
    expect(spaceScopePrefixes(project('console'))).toEqual([
      'projects/console/', 'projects/console.md', 'scratch/blog-drafts/console-',
    ])
  })
  it('areas scope to the writing dirs', () => {
    expect(spaceScopePrefixes(area('ai'))).toEqual(['log/', 'scratch/blog-drafts/'])
  })
})
