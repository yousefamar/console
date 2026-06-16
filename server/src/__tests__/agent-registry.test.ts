// AgentRegistry + org-tree derivation. Pins the durable-role layer: robust
// frontmatter parse, the anti-clobber surgical setManager stamp, and defensive
// org-tree derivation (cycles / dangling managers / orphans).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry, buildOrgTree, parseRole, slugify, type AgentRole } from '../agents/registry.js'

let dir: string
const reg = () => new AgentRegistry(dir)

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-reg-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function role(key: string, manager: string | null, title = key): AgentRole {
  return { key, title, manager, goals: [], cwd: null, created: null, charter: '', hasFile: true }
}

describe('parseRole', () => {
  it('parses frontmatter (block-list goals, comments) and keeps the body whole', () => {
    const content = [
      '---',
      'title: Feeds Tab',
      'manager: al',
      'goals:',
      '  - Keep the feeds pane fast',
      '  - Add OPML round-trip',
      'cwd: /home/amar/proj/code/console',
      '# a human comment the agent left',
      '---',
      '',
      'You are the Feeds agent.',
      '',
      '## Memory',
      '- 2026-06-15: readability extraction lives in feeds/extract.ts',
    ].join('\n')
    const r = parseRole('feeds-tab', content)
    expect(r.key).toBe('feeds-tab')          // key from filename, never frontmatter
    expect(r.title).toBe('Feeds Tab')
    expect(r.manager).toBe('al')
    expect(r.goals).toEqual(['Keep the feeds pane fast', 'Add OPML round-trip'])
    expect(r.cwd).toBe('/home/amar/proj/code/console')
    expect(r.charter).toContain('You are the Feeds agent.')
    expect(r.charter).toContain('## Memory')      // memory NOT split out — injected whole
    expect(r.charter).toContain('extract.ts')
  })

  it('falls back to key for title and null manager when absent', () => {
    const r = parseRole('lonely', 'no frontmatter here, just prose')
    expect(r.title).toBe('lonely')
    expect(r.manager).toBeNull()
    expect(r.goals).toEqual([])
    expect(r.charter).toBe('no frontmatter here, just prose')
  })
})

describe('slugify', () => {
  it('kebab-cases and strips junk', () => {
    expect(slugify('Feeds Tab!')).toBe('feeds-tab')
    expect(slugify('  yousefamar.com migration ')).toBe('yousefamar-com-migration')
    expect(slugify('')).toBe('agent')
  })
})

describe('AgentRegistry create + mintKey', () => {
  it('creates a role file and is idempotent', () => {
    const r = reg()
    const role1 = r.create('feeds', { title: 'Feeds', manager: 'al', charter: 'do feeds', goals: ['g1'] })
    expect(role1.title).toBe('Feeds')
    const before = readFileSync(join(dir, 'feeds.md'), 'utf-8')
    // second create is a no-op (file exists) — does not rewrite
    r.create('feeds', { title: 'DIFFERENT', charter: 'changed' })
    expect(readFileSync(join(dir, 'feeds.md'), 'utf-8')).toBe(before)
    expect(r.get('feeds')!.title).toBe('Feeds')
  })

  it('mints collision-suffixed keys', () => {
    const r = reg()
    r.create('console-general', { title: 'Console general' })
    expect(r.mintKey('Console general')).toBe('console-general-1')
  })
})

describe('AgentRegistry.setManager — surgical, anti-clobber', () => {
  it('changes ONLY the manager line; body + other frontmatter byte-identical', () => {
    const r = reg()
    const original = [
      '---',
      'title: Feeds',
      'manager: al',
      'goals:',
      '  - keep it fast',
      'cwd: /x',
      '# keep my comment',
      '---',
      '',
      'Charter body here.',
      '',
      '## Memory',
      '- a note',
      '',
    ].join('\n')
    writeFileSync(join(dir, 'feeds.md'), original)
    r.load()
    r.setManager('feeds', 'console-general')
    const after = readFileSync(join(dir, 'feeds.md'), 'utf-8')
    // Every line except the manager line is preserved verbatim.
    const origLines = original.split('\n')
    const afterLines = after.split('\n')
    expect(afterLines.filter((l) => !l.startsWith('manager:')))
      .toEqual(origLines.filter((l) => !l.startsWith('manager:')))
    expect(after).toContain('manager: console-general')
    expect(after).toContain('# keep my comment')
    expect(after).toContain('- a note')
    expect(r.get('feeds')!.manager).toBe('console-general')
  })

  it('reparent to root removes the manager line; body intact', () => {
    const r = reg()
    r.create('feeds', { title: 'Feeds', manager: 'al', charter: 'body' })
    r.setManager('feeds', null)
    const after = readFileSync(join(dir, 'feeds.md'), 'utf-8')
    expect(after).not.toContain('manager:')
    expect(after).toContain('body')
    expect(r.get('feeds')!.manager).toBeNull()
  })
})

describe('buildOrgTree', () => {
  it('nests reports under managers; sorts by title', () => {
    const tree = buildOrgTree([role('al', null, 'Al'), role('feeds', 'al', 'Feeds'), role('mail', 'al', 'Mail')])
    expect(tree).toHaveLength(1)
    expect(tree[0]!.role.key).toBe('al')
    expect(tree[0]!.children.map((c) => c.role.key)).toEqual(['feeds', 'mail'])
  })

  it('surfaces a dangling manager as an annotated root (never dropped)', () => {
    const tree = buildOrgTree([role('orphan', 'ghost')])
    expect(tree).toHaveLength(1)
    expect(tree[0]!.role.key).toBe('orphan')
    expect(tree[0]!.danglingManager).toBe('ghost')
  })

  it('breaks a cycle and keeps every node', () => {
    const tree = buildOrgTree([role('a', 'b', 'A'), role('b', 'a', 'B')])
    const keys: string[] = []
    const walk = (ns: ReturnType<typeof buildOrgTree>) => ns.forEach((n) => { keys.push(n.role.key); walk(n.children) })
    walk(tree)
    expect(keys.sort()).toEqual(['a', 'b'])      // both present, no infinite recursion
    expect(tree.some((n) => n.cycleBroken)).toBe(true)
  })

  it('handles multiple roots + nested grandchildren', () => {
    const tree = buildOrgTree([
      role('al', null, 'Al'), role('eng', 'al', 'Eng'), role('fe', 'eng', 'FE'),
      role('solo', null, 'Solo'),
    ])
    expect(tree.map((n) => n.role.key)).toEqual(['al', 'solo'])
    expect(tree[0]!.children[0]!.children[0]!.role.key).toBe('fe')
  })
})
