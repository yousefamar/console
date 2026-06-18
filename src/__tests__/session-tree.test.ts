import { describe, it, expect } from 'vitest'
import { flattenSidebarOrder } from '@/components/agent/session-tree'
import type { SessionInfo } from '@/store/agent'

const mk = (id: string, cwd: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, cwd, createdAt: 0, status: 'idle', prompt: '', totalCost: 0, totalTokens: { input: 0, output: 0 }, ...extra }) as unknown as SessionInfo

describe('flattenSidebarOrder', () => {
  it('respects sessionOrder within one cwd', () => {
    const sess = [mk('a', '/x'), mk('b', '/x'), mk('c', '/x')]
    expect(flattenSidebarOrder(sess, ['c', 'a', 'b']).map((s) => s.id)).toEqual(['c', 'a', 'b'])
  })

  it('nests a fork right after its parent', () => {
    const sess = [
      mk('p', '/x', { claudeSessionId: 'cp' }),
      mk('q', '/x', { claudeSessionId: 'cq' }),
      mk('f', '/x', { claudeSessionId: 'cf', parentClaudeSessionId: 'cp' }),
    ]
    expect(flattenSidebarOrder(sess, ['p', 'q', 'f']).map((s) => s.id)).toEqual(['p', 'f', 'q'])
  })

  it('clusters by cwd, groups ordered by their first member', () => {
    const sess = [mk('a', '/x'), mk('b', '/z')]
    expect(flattenSidebarOrder(sess, ['b', 'a']).map((s) => s.id)).toEqual(['b', 'a'])
    expect(flattenSidebarOrder(sess, ['a', 'b']).map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('skips collapsed groups', () => {
    const sess = [mk('a', '/x'), mk('b', '/z')]
    expect(flattenSidebarOrder(sess, ['a', 'b'], new Set(['/z'])).map((s) => s.id)).toEqual(['a'])
  })

  it('is NOT createdAt order (the old bug) — order beats recency', () => {
    const sess = [mk('old', '/x', { createdAt: 1 }), mk('new', '/x', { createdAt: 999 })]
    expect(flattenSidebarOrder(sess, ['old', 'new']).map((s) => s.id)).toEqual(['old', 'new'])
  })
})
