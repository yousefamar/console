import { describe, it, expect } from 'vitest'
import { buildOrgLayout, hitTest, subtreeKeys, NODE_W, NODE_H, type OrgLayoutNode } from '@/components/agent/agent-orgchart-helpers'
import type { AgentRole } from '@/store/agent'

function role(key: string, manager: string | null, cwd: string | null = null, title = key): AgentRole {
  return { key, title, manager, goals: [], cwd, created: null, charter: '', hasFile: true, folder: false }
}
function folder(key: string, manager: string | null, title = key): AgentRole {
  return { key, title, manager, goals: [], cwd: null, created: null, charter: '', hasFile: true, folder: true }
}

describe('buildOrgLayout — hierarchy', () => {
  it('roots at Al; reports nest; deeper nodes sit further right', () => {
    const { nodes } = buildOrgLayout([
      role('al', null, '/home/amar/sync/brain/root/projects/al/workspace', 'Al'),
      role('console-general', 'al', '/home/amar/proj/code/console', 'Console general'),
      role('feeds', 'console-general', '/home/amar/proj/code/console', 'Feeds'),
    ])
    const byKey = Object.fromEntries(nodes.map((n) => [n.key, n]))
    expect(byKey.al!.kind).toBe('al')
    expect(byKey.al!.depth).toBe(0)
    expect(byKey['console-general']!.parentKey).toBe('al')
    expect(byKey.feeds!.parentKey).toBe('console-general')
    expect(byKey.feeds!.x).toBeGreaterThan(byKey['console-general']!.x)
  })

  it('renders a real folder as a group node with its members nested', () => {
    const { nodes } = buildOrgLayout([
      role('al', null, null, 'Al'),
      folder('projects', 'al', 'Projects'),
      role('car', 'projects', '/x/car', 'Car'),
      role('home', 'projects', '/x/home', 'Home'),
    ])
    const group = nodes.find((n) => n.key === 'projects')!
    expect(group.kind).toBe('group')
    expect(group.parentKey).toBe('al')
    expect(group.childCount).toBe(2)
    expect(nodes.find((n) => n.key === 'car')!.parentKey).toBe('projects')
    expect(nodes.find((n) => n.key === 'home')!.parentKey).toBe('projects')
  })

  it('a managerless agent hangs directly under Al', () => {
    const { nodes } = buildOrgLayout([
      role('al', null, null, 'Al'),
      role('sainsburys', null, '/home/amar/proj/code/sainsburys', 'Sainsburys'),
    ])
    expect(nodes.some((n) => n.kind === 'group')).toBe(false)
    expect(nodes.find((n) => n.key === 'sainsburys')!.parentKey).toBe('al')
  })

  it('an explicit manager nests the agent under it', () => {
    const { nodes } = buildOrgLayout([
      role('al', null, null, 'Al'),
      role('artanis-general', 'al', '/home/amar/proj/code/artanis', 'Artanis general'),
      role('cold', 'artanis-general', '/home/amar/Downloads/cold', 'Cold outreach'),
    ])
    expect(nodes.find((n) => n.key === 'cold')!.parentKey).toBe('artanis-general')
  })

  it('breaks manager cycles without infinite recursion', () => {
    const { nodes } = buildOrgLayout([
      role('al', null, null, 'Al'),
      role('a', 'b', '/x/a', 'A'),
      role('b', 'a', '/x/b', 'B'),
    ])
    const keys = nodes.map((n) => n.key)
    expect(keys).toContain('a')
    expect(keys).toContain('b')
    // cycle broken → both fall back to top-level (under Al)
    expect(nodes.find((n) => n.key === 'a')!.parentKey).toBe('al')
  })

  it('collapsing a node prunes its subtree but keeps it counted', () => {
    const roles = [role('al', null, null, 'Al'), role('eng', 'al', '/c/eng', 'Eng'), role('fe', 'eng', '/c/fe', 'FE')]
    expect(buildOrgLayout(roles).nodes.some((n) => n.key === 'fe')).toBe(true)
    const closed = buildOrgLayout(roles, new Set(['eng']))
    expect(closed.nodes.some((n) => n.key === 'fe')).toBe(false)
    const eng = closed.nodes.find((n) => n.key === 'eng')!
    expect(eng.collapsed).toBe(true)
    expect(eng.hasChildren).toBe(true)
    expect(eng.descendantCount).toBe(1)
  })

  it('returns an empty layout for no roles', () => {
    expect(buildOrgLayout([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 })
  })
})

describe('buildOrgLayout — focus filter', () => {
  const roles = [
    role('al', null, null, 'Al'),
    folder('projects', 'al', 'Projects'),
    role('car', 'projects', '/x/car', 'Car'),
    role('home', 'projects', '/x/home', 'Home'),
    role('console', 'al', '/x/console', 'Console'),
  ]

  it('prunes to the matched node plus its ancestor chain', () => {
    const { nodes } = buildOrgLayout(roles, new Set(), new Set(['car']))
    const keys = nodes.map((n) => n.key).sort()
    // car + its ancestors (projects, al); home and console pruned away
    expect(keys).toEqual(['al', 'car', 'projects'])
  })

  it('keeps multiple matched branches', () => {
    const { nodes } = buildOrgLayout(roles, new Set(), new Set(['car', 'console']))
    const keys = nodes.map((n) => n.key).sort()
    expect(keys).toEqual(['al', 'car', 'console', 'projects'])
  })

  it('an empty filter set leaves only the root', () => {
    const { nodes } = buildOrgLayout(roles, new Set(), new Set())
    expect(nodes.map((n) => n.key)).toEqual(['al'])
  })

  it('null filter (default) shows everything', () => {
    expect(buildOrgLayout(roles).nodes.length).toBe(roles.length)
  })
})

describe('hitTest', () => {
  const nodes: OrgLayoutNode[] = [{ key: 'a', title: 'A', kind: 'role', x: 100, y: 100, depth: 0, parentKey: null }]
  it('hits inside the box, misses outside', () => {
    expect(hitTest(nodes, 100, 100)!.key).toBe('a')
    expect(hitTest(nodes, 100 + NODE_W / 2 - 1, 100 + NODE_H / 2 - 1)!.key).toBe('a')
    expect(hitTest(nodes, 100 + NODE_W, 100)).toBeNull()
  })
  it('respects the exclude set', () => {
    expect(hitTest(nodes, 100, 100, new Set(['a']))).toBeNull()
  })
})

describe('subtreeKeys', () => {
  it('returns the inclusive subtree (illegal reparent targets)', () => {
    const { nodes } = buildOrgLayout([
      role('al', null, null, 'Al'),
      role('eng', 'al', '/code/eng', 'Eng'),
      role('fe', 'eng', '/code/fe', 'FE'),
    ])
    expect([...subtreeKeys(nodes, 'eng')].sort()).toEqual(['eng', 'fe'])
  })
})
