import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globToRegExp, loadSkillIndex, parseSkillFrontmatter, skillHintLines, skillsForCard, type SkillHint } from '../kanban/skill-hints.js'
import { buildBoardEnvelope } from '../kanban/dispatch.js'

const property: SkillHint = {
  name: 'property', file: '.claude/skills/property/SKILL.md',
  paths: ['server/src/property/**', 'cli/src/commands/map-property.ts'],
  keywords: ['rightmove', 'house-hunt', 'con map property'],
}
const ring: SkillHint = {
  name: 'ring', file: '.claude/skills/ring/SKILL.md',
  paths: ['server/src/ring/**', 'server/src/lists/**'],
  keywords: ['pebble', 'ring-schema', 'voice command'],
}
const index = [property, ring]

describe('parseSkillFrontmatter', () => {
  it('reads name, paths and metadata.card_keywords', () => {
    const fm = parseSkillFrontmatter([
      '---', 'name: property', 'description: blah, with commas', 'paths: server/src/property/**, cli/src/commands/map-property.ts',
      'user-invocable: false', 'metadata:', '  card_keywords: "rightmove, house-hunt"', '---', '# body',
    ].join('\n'))
    expect(fm).toEqual({ name: 'property', paths: ['server/src/property/**', 'cli/src/commands/map-property.ts'], keywords: ['rightmove', 'house-hunt'] })
  })
  it('no frontmatter → empty', () => {
    expect(parseSkillFrontmatter('# just a body')).toEqual({ paths: [], keywords: [] })
  })
})

describe('globToRegExp', () => {
  it('** spans directories, * stays within one, suffix matches after a / boundary', () => {
    const re = globToRegExp('server/src/property/**')
    expect(re.test('server/src/property/sync.ts')).toBe(true)
    expect(re.test('server/src/property/clients/rightmove.ts')).toBe(true)
    expect(re.test('~/proj/code/console/server/src/property/sync.ts')).toBe(true)
    expect(re.test('server/src/propertyx/sync.ts')).toBe(false)
    const one = globToRegExp('src/map/property-*.ts')
    expect(one.test('src/map/property-review.ts')).toBe(true)
    expect(one.test('src/map/property-review/deep.ts')).toBe(false)
  })
})

describe('skillsForCard', () => {
  it('matches a path in the card text against a paths glob', () => {
    expect(skillsForCard('Fix the reseed race in server/src/property/sync.ts', index).map((s) => s.name)).toEqual(['property'])
  })
  it('matches a curated keyword as a whole phrase, case-insensitive', () => {
    expect(skillsForCard('Rightmove pins are missing since the tier change', index).map((s) => s.name)).toEqual(['property'])
    expect(skillsForCard('Update ring-schema.md with a timer alias', index).map((s) => s.name)).toEqual(['ring'])
  })
  it('never matches on the bare skill name or a substring', () => {
    expect(skillsForCard('This property of the scheduler is surprising; the ring buffer overflows', index)).toEqual([])
    expect(skillsForCard('Springboard for the pebbled path', index)).toEqual([])
  })
  it('a card can touch several skills; index order is kept', () => {
    const hits = skillsForCard('add rightmove listings to the pebble ring flow', index)
    expect(hits.map((s) => s.name)).toEqual(['property', 'ring'])
  })
})

describe('loadSkillIndex', () => {
  it('reads every .claude/skills/<name>/SKILL.md and skips skills with no paths/keywords', () => {
    const repo = mkdtempSync(join(tmpdir(), 'skills-'))
    mkdirSync(join(repo, '.claude/skills/alpha'), { recursive: true })
    mkdirSync(join(repo, '.claude/skills/plain'), { recursive: true })
    writeFileSync(join(repo, '.claude/skills/alpha/SKILL.md'), '---\nname: alpha\npaths: src/a/**\n---\nbody')
    writeFileSync(join(repo, '.claude/skills/plain/SKILL.md'), '---\nname: plain\ndescription: a procedure\n---\nbody')
    expect(loadSkillIndex(repo)).toEqual([{ name: 'alpha', file: '.claude/skills/alpha/SKILL.md', paths: ['src/a/**'], keywords: [] }])
    expect(loadSkillIndex(join(repo, 'nope'))).toEqual([])
  })
})

describe('envelope stanza', () => {
  it('names the SKILL.md path and tells the fork to Read it first', () => {
    const lines = skillHintLines([property])
    expect(lines[0]).toContain('`property` → `.claude/skills/property/SKILL.md`')
    expect(lines[0]).toMatch(/Read.*before you start/)
    expect(skillHintLines([])).toEqual([])
  })
  it('buildBoardEnvelope carries it between the card and the instructions; absent when no hint', () => {
    const base = { boardAbsPath: '/v/projects/console/board.md', card: { text: 'Fix rightmove pins', blockId: 'a-b', lines: ['- [ ] Fix rightmove pins'] }, column: 'In Progress', project: 'console' }
    const withHint = buildBoardEnvelope({ ...base, skills: [property] })
    expect(withHint).toContain('SKILLS: this card looks like it touches `property`')
    expect(withHint.indexOf('Fix rightmove pins')).toBeLessThan(withHint.indexOf('SKILLS:'))
    expect(withHint.indexOf('SKILLS:')).toBeLessThan(withHint.indexOf('This card was assigned to you'))
    expect(buildBoardEnvelope(base)).not.toContain('SKILLS:')
  })
})
