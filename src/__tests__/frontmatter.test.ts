import { describe, it, expect } from 'vitest'
import {
  parseFrontmatter,
  stampFrontmatter,
  frontmatterRange,
  permalinkForLogPath,
  isDraftPath,
  isPublishedPath,
} from '@/utils/frontmatter'

const SAMPLE = `---
title: My Post
public: false
date: 2026-06-08 10:00:00
post: true
tags:
  - writing
  - dev
---

Hello world.
`

describe('parseFrontmatter', () => {
  it('parses standard fields', () => {
    const { fm, body } = parseFrontmatter(SAMPLE)
    expect(fm.title).toBe('My Post')
    expect(fm.public).toBe(false)
    expect(fm.post).toBe(true)
    expect(fm.date).toBe('2026-06-08 10:00:00')
    expect(body).toContain('Hello world.')
  })

  it('parses block-list tags', () => {
    const { fm } = parseFrontmatter(SAMPLE)
    expect(fm.tags).toEqual(['writing', 'dev'])
  })

  it('parses inline-array tags', () => {
    const { fm } = parseFrontmatter('---\ntags: [a, b]\n---\nx')
    expect(fm.tags).toEqual(['a', 'b'])
  })

  it('parses scalar tags (single + comma list)', () => {
    expect(parseFrontmatter('---\ntags: solo\n---\n').fm.tags).toEqual(['solo'])
    expect(parseFrontmatter('---\ntags: a, b\n---\n').fm.tags).toEqual(['a', 'b'])
  })

  it('returns empty fm for content without frontmatter', () => {
    const { fm, body } = parseFrontmatter('just text')
    expect(fm).toEqual({})
    expect(body).toBe('just text')
  })

  it('strips quotes from values', () => {
    const { fm } = parseFrontmatter('---\ntitle: "Quoted"\n---\n')
    expect(fm.title).toBe('Quoted')
  })
})

describe('stampFrontmatter', () => {
  it('replaces an existing scalar key', () => {
    const out = stampFrontmatter(SAMPLE, { title: 'New Title' })
    expect(parseFrontmatter(out).fm.title).toBe('New Title')
    // Body untouched
    expect(out).toContain('Hello world.')
  })

  it('appends a missing key', () => {
    const out = stampFrontmatter(SAMPLE, { project: 'memo' })
    expect(parseFrontmatter(out).fm.project).toBe('memo')
  })

  it('replaces block-list tags with new block list', () => {
    const out = stampFrontmatter(SAMPLE, { tags: ['x', 'y', 'z'] })
    expect(parseFrontmatter(out).fm.tags).toEqual(['x', 'y', 'z'])
    // No leftover old items
    expect(out).not.toContain('- writing')
  })

  it('replaces scalar tags with block list', () => {
    const src = '---\ntags: old\n---\nbody'
    const out = stampFrontmatter(src, { tags: ['new1', 'new2'] })
    expect(parseFrontmatter(out).fm.tags).toEqual(['new1', 'new2'])
    expect(out).not.toContain('tags: old')
  })

  it('empty tags array leaves an empty tags key', () => {
    const out = stampFrontmatter(SAMPLE, { tags: [] })
    expect(parseFrontmatter(out).fm.tags).toBeUndefined()
    expect(out).toContain('tags: ')
  })

  it('round-trips: parse(stamp(x)) preserves untouched keys', () => {
    const out = stampFrontmatter(SAMPLE, { title: 'Changed' })
    const { fm } = parseFrontmatter(out)
    expect(fm.public).toBe(false)
    expect(fm.post).toBe(true)
    expect(fm.tags).toEqual(['writing', 'dev'])
    expect(fm.date).toBe('2026-06-08 10:00:00')
  })

  it('creates frontmatter on content without any', () => {
    const out = stampFrontmatter('plain body', { title: 'T' })
    const { fm, body } = parseFrontmatter(out)
    expect(fm.title).toBe('T')
    expect(body).toBe('plain body')
  })
})

describe('frontmatterRange', () => {
  it('covers the full fence block', () => {
    const r = frontmatterRange(SAMPLE)!
    expect(r.from).toBe(0)
    expect(SAMPLE.slice(r.from, r.to)).toMatch(/^---\n[\s\S]*\n---\n$/)
  })

  it('null when no frontmatter', () => {
    expect(frontmatterRange('nope')).toBeNull()
  })
})

describe('permalinkForLogPath', () => {
  it('maps log path to public URL', () => {
    expect(permalinkForLogPath('log/2026-06-08-10-00-00.md'))
      .toBe('https://yousefamar.com/memo/log/2026-06-08-10-00-00/')
  })

  it('null for non-log paths', () => {
    expect(permalinkForLogPath('scratch/blog-drafts/foo.md')).toBeNull()
    expect(permalinkForLogPath('projects/al/index.md')).toBeNull()
  })
})

describe('path classifiers', () => {
  it('isDraftPath', () => {
    expect(isDraftPath('scratch/blog-drafts/x.md')).toBe(true)
    expect(isDraftPath('log/x.md')).toBe(false)
    expect(isDraftPath(null)).toBe(false)
  })

  it('isPublishedPath', () => {
    expect(isPublishedPath('log/x.md')).toBe(true)
    expect(isPublishedPath('log/sub/x.md')).toBe(false)
    expect(isPublishedPath('scratch/blog-drafts/x.md')).toBe(false)
  })
})
