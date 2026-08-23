import { describe, it, expect } from 'vitest'
import { isDraftPath, projectForDraftPath } from '../blog.js'

describe('draft paths', () => {
  it('accepts log/drafts, project log/drafts, legacy scratch; rejects posts/index', () => {
    expect(isDraftPath('log/drafts/x.md')).toBe(true)
    expect(isDraftPath('projects/console/log/drafts/burning-tokens.md')).toBe(true)
    expect(isDraftPath('scratch/blog-drafts/x.md')).toBe(true) // legacy
    expect(isDraftPath('projects/console/log/2026-01-01-00-00-00.md')).toBe(false)
    expect(isDraftPath('projects/console/index.md')).toBe(false)
    expect(isDraftPath('log/x.md')).toBe(false)
  })
  it('projectForDraftPath reads the slug from the path only', () => {
    expect(projectForDraftPath('projects/console/log/drafts/x.md')).toBe('console')
    expect(projectForDraftPath('log/drafts/x.md')).toBeNull()
    expect(projectForDraftPath('scratch/blog-drafts/console-x.md')).toBeNull()
  })
  it('a draft never counts as a post (log/drafts is not a direct log child)', async () => {
    const { isPostPath } = await import('../blog.js')
    expect(isPostPath('log/drafts/x.md')).toBe(false)
    expect(isPostPath('projects/console/log/drafts/x.md')).toBe(false)
    expect(isPostPath('log/x.md')).toBe(true)
    expect(isPostPath('projects/console/log/x.md')).toBe(true)
  })
})
