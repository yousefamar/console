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

describe('area posts + area drafts', () => {
  it('listAreaPosts matches on the tag across log/ AND project logs; createDraft seeds the area tag', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { NoteStore } = await import('../notes.js')
    const { listAreaPosts, createDraft, listDrafts } = await import('../blog.js')
    const dir = mkdtempSync(join(tmpdir(), 'blog-'))
    mkdirSync(join(dir, 'log', 'drafts'), { recursive: true })
    mkdirSync(join(dir, 'projects', 'console', 'log'), { recursive: true })
    writeFileSync(join(dir, 'log', '2026-01-01-00-00-00.md'), '---\ntitle: AI post\npublic: true\npost: true\ndate: 2026-01-01 00:00:00\ntags: ai\n---\nbody\n')
    writeFileSync(join(dir, 'log', '2026-01-02-00-00-00.md'), '---\ntitle: Dev post\npublic: true\npost: true\ndate: 2026-01-02 00:00:00\ntags: dev\n---\nbody\n')
    writeFileSync(join(dir, 'projects', 'console', 'log', '2026-01-03-00-00-00.md'), '---\ntitle: Console AI devlog\npublic: true\npost: true\ndate: 2026-01-03 00:00:00\ntags:\n  - projects\n  - ai\n---\nbody\n')
    const store = new NoteStore(dir)
    try {
      const ai = await listAreaPosts(store, 'ai')
      expect(ai.map((p) => [p.title, p.project])).toEqual([
        ['Console AI devlog', 'console'], // newest first, project post included
        ['AI post', null],
      ])
      expect(await listAreaPosts(store, 'life')).toEqual([])

      const r = await createDraft(store, { title: 'Thoughts on agents', area: 'ai' })
      expect(r.ok).toBe(true)
      expect(r.path).toBe('log/drafts/thoughts-on-agents.md')
      expect(readFileSync(join(dir, r.path!), 'utf-8')).toContain('tags:\n  - ai')
      const drafts = await listDrafts(store)
      expect(drafts.find((d) => d.path === r.path)?.tags).toEqual(['ai'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
