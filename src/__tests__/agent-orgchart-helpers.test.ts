import { describe, it, expect } from 'vitest'
import { buildOrgLayout, hitTest, subtreeKeys, NODE_W, NODE_H, type OrgLayoutNode } from '@/components/agent/agent-orgchart-helpers'
import type { OrgNode, AgentRole } from '@/store/agent'

function role(key: string, manager: string | null): AgentRole {
  return { key, title: key.toUpperCase(), manager, goals: [], cwd: null, created: null, charter: '', hasFile: true }
}
function node(key: string, manager: string | null, children: OrgNode[] = []): OrgNode {
  return { role: role(key, manager), children }
}

describe('buildOrgLayout', () => {
  it('lays out every node with parent links and edges', () => {
    const tree: OrgNode[] = [node('al', null, [node('feeds', 'al'), node('mail', 'al', [node('mail-fork', 'mail')])])]
    const { nodes, edges } = buildOrgLayout(tree)
    expect(nodes.map((n) => n.key).sort()).toEqual(['al', 'feeds', 'mail', 'mail-fork'])
    const byKey = Object.fromEntries(nodes.map((n) => [n.key, n]))
    expect(byKey.al!.parentKey).toBeNull()
    expect(byKey.feeds!.parentKey).toBe('al')
    expect(byKey['mail-fork']!.parentKey).toBe('mail')
    expect(byKey.al!.depth).toBe(0)
    expect(byKey['mail-fork']!.depth).toBe(2)
    // one edge per non-root node
    expect(edges).toHaveLength(3)
  })

  it('deeper nodes sit lower (greater y)', () => {
    const { nodes } = buildOrgLayout([node('al', null, [node('feeds', 'al')])])
    const al = nodes.find((n) => n.key === 'al')!
    const feeds = nodes.find((n) => n.key === 'feeds')!
    expect(feeds.y).toBeGreaterThan(al.y)
  })

  it('handles multiple roots', () => {
    const { nodes } = buildOrgLayout([node('al', null), node('solo', null)])
    expect(nodes.map((n) => n.key).sort()).toEqual(['al', 'solo'])
    expect(nodes.every((n) => n.depth === 0)).toBe(true)
  })

  it('returns empty layout for no roles', () => {
    expect(buildOrgLayout([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 })
  })
})

describe('hitTest', () => {
  const nodes: OrgLayoutNode[] = [{ key: 'a', title: 'A', x: 100, y: 100, depth: 0, parentKey: null }]
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
    const { nodes } = buildOrgLayout([node('al', null, [node('eng', 'al', [node('fe', 'eng')])]), node('solo', null)])
    expect([...subtreeKeys(nodes, 'eng')].sort()).toEqual(['eng', 'fe'])
    expect(subtreeKeys(nodes, 'solo')).toEqual(new Set(['solo']))
  })
})
