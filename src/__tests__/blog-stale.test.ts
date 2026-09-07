import { describe, it, expect } from 'vitest'
import { stalePostCandidates, projectForPostPath } from '@/blog/stale'

const T = 1_000_000

describe('stalePostCandidates', () => {
  const files = [
    { path: 'log/2026-09-01-10-00-00.md', mtime: T + 5_000 },              // stale, unhomed post
    { path: 'projects/demovid/log/2026-09-07-14-02-45.md', mtime: T + 60_000 }, // stale, project post
    { path: 'log/2026-08-01-10-00-00.md', mtime: T - 1 },                  // built after save → live
    { path: 'log/2026-08-02-10-00-00.md', mtime: T },                      // same instant → live (>= wins)
    { path: 'log/drafts/idea.md', mtime: T + 9_000 },                      // draft, never a post
    { path: 'projects/demovid/log/drafts/wip.md', mtime: T + 9_000 },      // project draft
    { path: 'projects/demovid/index.md', mtime: T + 9_000 },               // not a post
    { path: 'notes/foo.md', mtime: T + 9_000 },
  ]

  it('returns only published posts saved after the build, newest first', () => {
    expect(stalePostCandidates(files, T).map((c) => c.path)).toEqual([
      'projects/demovid/log/2026-09-07-14-02-45.md',
      'log/2026-09-01-10-00-00.md',
    ])
  })

  it('an unknown build time yields nothing rather than a false alarm', () => {
    expect(stalePostCandidates(files, null)).toEqual([])
  })

  it('a build newer than every save clears the list', () => {
    expect(stalePostCandidates(files, T + 60_000)).toEqual([])
  })
})

describe('projectForPostPath', () => {
  it('reads the slug from a project-homed post and nothing else', () => {
    expect(projectForPostPath('projects/demovid/log/2026-09-07-14-02-45.md')).toBe('demovid')
    expect(projectForPostPath('log/2026-09-07-14-02-45.md')).toBeNull()
    expect(projectForPostPath('projects/demovid/log/drafts/x.md')).toBeNull()
    expect(projectForPostPath('projects/demovid/index.md')).toBeNull()
  })
})
