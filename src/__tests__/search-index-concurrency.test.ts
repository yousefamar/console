import { describe, it, expect } from 'vitest'
import { NotesSearchIndex } from '@/notes/search-index'
import type { VaultFile } from '@/notes/vault-adapter'

const files = (n: number): VaultFile[] =>
  Array.from({ length: n }, (_, i) => ({ path: `n/${i}.md`, name: `${i}.md`, mtime: 0, size: 0 } as unknown as VaultFile))

describe('NotesSearchIndex.buildIndex concurrency', () => {
  it('a second build started mid-way supersedes the first instead of double-adding', async () => {
    const idx = new NotesSearchIndex()
    const read = async (p: string) => `# ${p}\nbody`
    // 120 files = 3 batches, so the first build yields twice; the second
    // build starts during its first yield. Without the generation guard both
    // builds addAll the same batch → MiniSearch "duplicate ID" throw.
    const first = idx.buildIndex(files(120), read)
    await new Promise((r) => setTimeout(r, 0))
    const second = idx.buildIndex(files(120), read)
    await expect(Promise.all([first, second])).resolves.toBeDefined()
    expect(idx.searchContent('body').length).toBeGreaterThan(0)
  })
})
