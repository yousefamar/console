import { describe, it, expect } from 'vitest'
import { fuzzyScore, rankEntries, launcherSection, type Rankable, type CommandKind } from '@/commandbar/rank'

const e = (key: string, kind: CommandKind, recency = 0, hint?: string): Rankable => ({ key, title: key, kind, recency, hint })

describe('fuzzyScore', () => {
  it('prefers contiguous matches, earlier first', () => {
    expect(fuzzyScore('mail', 'mail')).toBe(0)
    expect(fuzzyScore('my mail', 'mail')).toBe(3)
    expect(fuzzyScore('m-a-i-l', 'mail')).toBe(1000)
    expect(fuzzyScore('xyz', 'mail')).toBe(-1)
  })
})

describe('rankEntries — query', () => {
  it('structure beats content on an equal score, then recency', () => {
    const out = rankEntries([
      e('mail thread newer', 'thread', 200),
      e('mail thread older', 'thread', 100),
      e('Mail', 'pane'),
    ], 'mail')
    expect(out.map((x) => x.key)).toEqual(['Mail', 'mail thread newer', 'mail thread older'])
  })

  it('matches on the hint too and drops non-matches', () => {
    const out = rankEntries([
      e('index.md', 'file', 1, 'projects/console'),
      e('todo.md', 'file', 2, 'projects/astera'),
    ], 'astera')
    expect(out.map((x) => x.key)).toEqual(['todo.md'])
  })

  it('caps the result count', () => {
    const many = Array.from({ length: 80 }, (_, i) => e(`room ${i}`, 'room', i))
    expect(rankEntries(many, 'room', { limit: 50 })).toHaveLength(50)
  })
})

describe('rankEntries — empty query launcher', () => {
  it('recent band is capped per kind so one source cannot flood it', () => {
    const threads = Array.from({ length: 20 }, (_, i) => e(`t${i}`, 'thread', 1000 + i))
    const out = rankEntries([...threads, e('sess', 'session', 5), e('f.md', 'file', 4)], '', { recentLimit: 10, recentPerKind: 3 })
    const recent = out.filter((x) => launcherSection(x.kind) === 'Recent')
    expect(recent.filter((x) => x.kind === 'thread')).toHaveLength(3)
    expect(recent.map((x) => x.key)).toEqual(['t19', 't18', 't17', 'sess', 'f.md'])
  })

  it('upcoming events sort soonest first; panes and actions always trail', () => {
    const out = rankEntries([
      e('Home', 'pane'),
      e('later', 'event', 3000),
      e('soon', 'event', 2000),
      e('Compose', 'action'),
      e('never-active', 'session', 0),
      e('Astera', 'project', 9),
    ], '')
    expect(out.map((x) => x.key)).toEqual(['soon', 'later', 'Home', 'Compose'])
  })
})
