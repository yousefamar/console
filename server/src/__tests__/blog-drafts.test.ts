import { describe, it, expect } from 'vitest'
import { isDraftPath, projectForDraftPath } from '../blog.js'

describe('draft paths', () => {
  it('accepts scratch and project drafts, rejects posts/index', () => {
    expect(isDraftPath('scratch/blog-drafts/x.md')).toBe(true)
    expect(isDraftPath('projects/console/drafts/burning-tokens.md')).toBe(true)
    expect(isDraftPath('projects/console/log/2026-01-01-00-00-00.md')).toBe(false)
    expect(isDraftPath('projects/console/index.md')).toBe(false)
    expect(isDraftPath('log/x.md')).toBe(false)
  })
  it('projectForDraftPath reads the slug from the path only', () => {
    expect(projectForDraftPath('projects/console/drafts/x.md')).toBe('console')
    expect(projectForDraftPath('scratch/blog-drafts/console-x.md')).toBeNull()
  })
})
