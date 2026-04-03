import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { NoteStore } from '../notes'

const TEST_DIR = join(tmpdir(), 'notes-test-' + Date.now())

function setupTestVault() {
  mkdirSync(join(TEST_DIR, 'notes', 'guides'), { recursive: true })
  mkdirSync(join(TEST_DIR, 'notes', 'maxims'), { recursive: true })
  mkdirSync(join(TEST_DIR, 'scratch'), { recursive: true })
  mkdirSync(join(TEST_DIR, '.obsidian'), { recursive: true })
  mkdirSync(join(TEST_DIR, 'bookmarks'), { recursive: true })

  writeFileSync(join(TEST_DIR, 'notes', 'guides', 'foo.md'), '# Foo\n\nA guide.')
  writeFileSync(join(TEST_DIR, 'notes', 'guides', 'bar.md'), '# Bar\n\nAnother guide.')
  writeFileSync(join(TEST_DIR, 'notes', 'maxims', 'baz.md'), '# Baz\n\nA maxim.')
  writeFileSync(join(TEST_DIR, 'scratch', 'quick.md'), 'Quick scratch note')
  writeFileSync(join(TEST_DIR, 'root.md'), '# Root note')
  writeFileSync(join(TEST_DIR, '.obsidian', 'app.json'), '{}')
  writeFileSync(join(TEST_DIR, 'bookmarks', 'bookmark.md'), '---\ntitle: BM\n---')
}

describe('NoteStore', () => {
  let store: NoteStore

  beforeEach(() => {
    setupTestVault()
    store = new NoteStore(TEST_DIR)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // list
  // -----------------------------------------------------------------------

  it('lists all .md files recursively', async () => {
    const files = await store.list()
    const paths = files.map((f) => f.path)

    expect(paths).toContain('notes/guides/foo.md')
    expect(paths).toContain('notes/guides/bar.md')
    expect(paths).toContain('notes/maxims/baz.md')
    expect(paths).toContain('scratch/quick.md')
    expect(paths).toContain('root.md')
  })

  it('skips .obsidian directory', async () => {
    const files = await store.list()
    const paths = files.map((f) => f.path)
    expect(paths.every((p) => !p.includes('.obsidian'))).toBe(true)
  })

  it('skips bookmarks directory', async () => {
    const files = await store.list()
    const paths = files.map((f) => f.path)
    expect(paths.every((p) => !p.startsWith('bookmarks/'))).toBe(true)
  })

  it('returns correct file metadata', async () => {
    const files = await store.list()
    const foo = files.find((f) => f.path === 'notes/guides/foo.md')!
    expect(foo.name).toBe('foo.md')
    expect(foo.dir).toBe('notes/guides')
    expect(foo.mtime).toBeGreaterThan(0)
  })

  it('returns sorted paths', async () => {
    const files = await store.list()
    const paths = files.map((f) => f.path)
    const sorted = [...paths].sort()
    expect(paths).toEqual(sorted)
  })

  // -----------------------------------------------------------------------
  // read
  // -----------------------------------------------------------------------

  it('reads file content', async () => {
    const content = await store.read('notes/guides/foo.md')
    expect(content).toBe('# Foo\n\nA guide.')
  })

  it('throws on non-existent file', async () => {
    await expect(store.read('nonexistent.md')).rejects.toThrow()
  })

  // -----------------------------------------------------------------------
  // write
  // -----------------------------------------------------------------------

  it('writes new file', async () => {
    await store.write('scratch/new.md', '# New')
    const content = readFileSync(join(TEST_DIR, 'scratch', 'new.md'), 'utf-8')
    expect(content).toBe('# New')
  })

  it('updates existing file', async () => {
    await store.write('notes/guides/foo.md', '# Updated Foo')
    const content = readFileSync(join(TEST_DIR, 'notes', 'guides', 'foo.md'), 'utf-8')
    expect(content).toBe('# Updated Foo')
  })

  it('creates intermediate directories', async () => {
    await store.write('new/nested/dir/file.md', '# Deep')
    const content = readFileSync(join(TEST_DIR, 'new', 'nested', 'dir', 'file.md'), 'utf-8')
    expect(content).toBe('# Deep')
  })

  // -----------------------------------------------------------------------
  // delete
  // -----------------------------------------------------------------------

  it('deletes file', async () => {
    await store.delete('scratch/quick.md')
    expect(existsSync(join(TEST_DIR, 'scratch', 'quick.md'))).toBe(false)
  })

  it('throws when deleting non-existent file', async () => {
    await expect(store.delete('nonexistent.md')).rejects.toThrow()
  })

  // -----------------------------------------------------------------------
  // createDir
  // -----------------------------------------------------------------------

  it('creates directory', async () => {
    await store.createDir('notes/new-section')
    expect(existsSync(join(TEST_DIR, 'notes', 'new-section'))).toBe(true)
  })

  it('creates nested directory', async () => {
    await store.createDir('deep/nested/dir')
    expect(existsSync(join(TEST_DIR, 'deep', 'nested', 'dir'))).toBe(true)
  })

  // -----------------------------------------------------------------------
  // rename
  // -----------------------------------------------------------------------

  it('renames file', async () => {
    await store.rename('scratch/quick.md', 'scratch/renamed.md')
    expect(existsSync(join(TEST_DIR, 'scratch', 'quick.md'))).toBe(false)
    expect(existsSync(join(TEST_DIR, 'scratch', 'renamed.md'))).toBe(true)
    const content = readFileSync(join(TEST_DIR, 'scratch', 'renamed.md'), 'utf-8')
    expect(content).toBe('Quick scratch note')
  })

  it('moves file to different directory', async () => {
    await store.rename('scratch/quick.md', 'notes/guides/moved.md')
    expect(existsSync(join(TEST_DIR, 'scratch', 'quick.md'))).toBe(false)
    expect(existsSync(join(TEST_DIR, 'notes', 'guides', 'moved.md'))).toBe(true)
  })

  // -----------------------------------------------------------------------
  // path validation
  // -----------------------------------------------------------------------

  it('rejects path traversal', async () => {
    await expect(store.read('../../../etc/passwd')).rejects.toThrow('Path escapes vault directory')
  })

  it('rejects absolute path traversal', async () => {
    await expect(store.write('../../escape.md', 'bad')).rejects.toThrow('Path escapes vault directory')
  })
})
