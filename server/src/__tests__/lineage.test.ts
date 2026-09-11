import { describe, it, expect } from 'vitest'
import { wouldCycle, type LineageNode } from '../agents/lineage.js'

function tree(...nodes: LineageNode[]): Map<string, LineageNode> {
  return new Map(nodes.filter((n) => n.claudeSessionId).map((n) => [n.claudeSessionId!, n]))
}

describe('wouldCycle', () => {
  const root: LineageNode = { claudeSessionId: 'root' }
  const a: LineageNode = { claudeSessionId: 'a', parentClaudeSessionId: 'root' }
  const b: LineageNode = { claudeSessionId: 'b', parentClaudeSessionId: 'a' }
  const other: LineageNode = { claudeSessionId: 'other' }
  const byId = tree(root, a, b, other)

  it('allows moving a fork under an unrelated session', () => {
    expect(wouldCycle(b, other, byId)).toBe(false)
  })

  it('allows moving a root under another root', () => {
    expect(wouldCycle(other, root, byId)).toBe(false)
  })

  it('refuses a session as its own parent', () => {
    expect(wouldCycle(a, a, byId)).toBe(true)
  })

  it('refuses a descendant as parent', () => {
    expect(wouldCycle(root, b, byId)).toBe(true)
    expect(wouldCycle(a, b, byId)).toBe(true)
  })

  it('terminates on a pre-existing loop in the map', () => {
    const x: LineageNode = { claudeSessionId: 'x', parentClaudeSessionId: 'y' }
    const y: LineageNode = { claudeSessionId: 'y', parentClaudeSessionId: 'x' }
    expect(wouldCycle(other, x, tree(x, y, other))).toBe(false)
  })
})
