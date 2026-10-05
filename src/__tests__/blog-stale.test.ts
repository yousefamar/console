import { describe, it, expect } from 'vitest'
import { stalePostCandidates, projectForPostPath, buildClock } from '@/blog/stale'

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

describe('buildClock', () => {
  const started = '2026-10-05T19:38:04.522Z'
  const ms = Date.parse(started)

  it('reads the clock off the last successful build, at its START', () => {
    const finished = '2026-10-05T19:38:39.176Z'
    expect(buildClock({ rebuilding: false, lastBuild: { ok: true, startedAt: started, finishedAt: finished } }, null))
      .toEqual({ builtAt: ms, error: null, rebuilding: false })
  })

  it('keeps the previous clock and names the error when the last build FAILED', () => {
    const err = '[11ty] Problem writing Eleventy templates: expected variable end'
    expect(buildClock({ rebuilding: false, lastBuild: { ok: false, startedAt: started, error: err } }, 500))
      .toEqual({ builtAt: 500, error: err, rebuilding: false })
  })

  it('a failed build with no error text still reports a failure', () => {
    expect(buildClock({ rebuilding: false, lastBuild: { ok: false, startedAt: started } }, 500).error)
      .toBe('The last site build failed')
  })

  it('keeps the previous clock when the blog server has no build on record', () => {
    expect(buildClock({ rebuilding: true, lastBuild: null }, 500)).toEqual({ builtAt: 500, error: null, rebuilding: true })
    expect(buildClock(null, 500)).toEqual({ builtAt: 500, error: null, rebuilding: false })
    // Nothing cached either → the store falls back to a page probe.
    expect(buildClock(null, null).builtAt).toBeNull()
  })

  it('ignores an unparseable timestamp rather than blanking the clock', () => {
    expect(buildClock({ lastBuild: { ok: true, startedAt: 'not a date' } }, 500).builtAt).toBe(500)
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
