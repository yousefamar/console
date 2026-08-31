import { describe, it, expect } from 'vitest'
import { vaultRelative } from '../agents/vault-edit.js'

describe('vaultRelative', () => {
  const vault = '/home/u/sync/brain/root'

  it('resolves a vault file to a relative path', () => {
    expect(vaultRelative(vault, '/home/u/sync/brain/root/projects/x/index.md')).toBe('projects/x/index.md')
  })

  it('rejects files outside the vault', () => {
    expect(vaultRelative(vault, '/home/u/proj/code/console/README.md')).toBeNull()
  })

  it('rejects a sibling dir sharing the vault prefix', () => {
    expect(vaultRelative(vault, '/home/u/sync/brain/root-other/a.md')).toBeNull()
  })

  it('rejects the vault root itself', () => {
    expect(vaultRelative(vault, '/home/u/sync/brain/root')).toBeNull()
  })

  it('normalises .. traversal before comparing', () => {
    expect(vaultRelative(vault, '/home/u/sync/brain/root/../secrets.md')).toBeNull()
    expect(vaultRelative(vault, '/home/u/sync/brain/root/a/../b.md')).toBe('b.md')
  })
})
