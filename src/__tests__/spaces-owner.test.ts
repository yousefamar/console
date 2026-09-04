import { describe, it, expect } from 'vitest'
import { conventionOwnerKey, effectiveOwnerKey } from '@/spaces/owner'

const s = (agentKey: string | null, extra: Partial<{ name: string; project: string; status: string; parentClaudeSessionId: string }> = {}) => ({
  agentKey, project: 'console', status: 'idle', ...extra,
})

describe('conventionOwnerKey (mirror of the hub resolveDefaultOwner)', () => {
  it('single bound root session owns', () => {
    expect(conventionOwnerKey('console', [s('console-general')])).toBe('console-general')
  })
  it('several → the -general key', () => {
    expect(conventionOwnerKey('console', [s('opsec'), s('console-general'), s('zeta')])).toBe('console-general')
  })
  it('several, none -general by key → title ending in "general"', () => {
    expect(conventionOwnerKey('console', [s('zeta'), s('alpha', { name: 'Console General' })])).toBe('alpha')
  })
  it('several, no general → first by key', () => {
    expect(conventionOwnerKey('console', [s('zeta'), s('alpha')])).toBe('alpha')
  })
  it('ignores forks, ended sessions, keyless sessions and other projects', () => {
    expect(conventionOwnerKey('console', [
      s('console-general-bold-fox-fork', { parentClaudeSessionId: 'x' }),
      s('dead', { status: 'ended' }),
      s(null),
      s('astera-general', { project: 'astera' }),
      s('opsec'),
    ])).toBe('opsec')
  })
  it('nothing bound → null', () => {
    expect(conventionOwnerKey('console', [s('astera-general', { project: 'astera' })])).toBeNull()
  })
})

describe('effectiveOwnerKey', () => {
  it('frontmatter default_owner wins even with no live session behind it', () => {
    expect(effectiveOwnerKey('console', 'someone-else', [s('console-general')])).toBe('someone-else')
  })
  it('falls back to the convention pick when unset', () => {
    expect(effectiveOwnerKey('console', null, [s('opsec'), s('console-general')])).toBe('console-general')
    expect(effectiveOwnerKey('console', undefined, [s('opsec')])).toBe('opsec')
  })
})
