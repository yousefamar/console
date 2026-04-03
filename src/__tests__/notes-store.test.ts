import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useNotesStore, buildFileTree, slugify } from '@/store/notes'
import type { VaultFile } from '@/notes/vault-adapter'

// ---------------------------------------------------------------------------
// buildFileTree
// ---------------------------------------------------------------------------

describe('buildFileTree', () => {
  it('builds a tree from flat file list', () => {
    const files: VaultFile[] = [
      { path: 'notes/guides/foo.md', name: 'foo.md', dir: 'notes/guides', mtime: 1 },
      { path: 'notes/guides/bar.md', name: 'bar.md', dir: 'notes/guides', mtime: 2 },
      { path: 'notes/maxims/baz.md', name: 'baz.md', dir: 'notes/maxims', mtime: 3 },
      { path: 'root-file.md', name: 'root-file.md', dir: '', mtime: 4 },
    ]
    const tree = buildFileTree(files)

    // Root should have: notes/ dir, root-file.md
    expect(tree.length).toBe(2) // notes dir + root-file.md
    const notesDir = tree.find((n) => n.name === 'notes')!
    expect(notesDir.isDir).toBe(true)
    expect(notesDir.children.length).toBe(2) // guides, maxims

    const guidesDir = notesDir.children.find((n) => n.name === 'guides')!
    expect(guidesDir.isDir).toBe(true)
    expect(guidesDir.children.length).toBe(2)
    expect(guidesDir.children.map((c) => c.name).sort()).toEqual(['bar.md', 'foo.md'])
  })

  it('sorts directories before files', () => {
    const files: VaultFile[] = [
      { path: 'a-file.md', name: 'a-file.md', dir: '', mtime: 1 },
      { path: 'b-dir/child.md', name: 'child.md', dir: 'b-dir', mtime: 2 },
    ]
    const tree = buildFileTree(files)
    expect(tree[0]!.name).toBe('b-dir') // dir first
    expect(tree[1]!.name).toBe('a-file.md') // then file
  })

  it('handles empty file list', () => {
    expect(buildFileTree([])).toEqual([])
  })

  it('handles deeply nested files', () => {
    const files: VaultFile[] = [
      { path: 'a/b/c/d.md', name: 'd.md', dir: 'a/b/c', mtime: 1 },
    ]
    const tree = buildFileTree(files)
    expect(tree[0]!.name).toBe('a')
    expect(tree[0]!.children[0]!.name).toBe('b')
    expect(tree[0]!.children[0]!.children[0]!.name).toBe('c')
    expect(tree[0]!.children[0]!.children[0]!.children[0]!.name).toBe('d.md')
  })
})

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('converts title to slug', () => {
    expect(slugify('My Cool Note')).toBe('my-cool-note')
  })
  it('handles special characters', () => {
    expect(slugify("What's Up?")).toBe('whats-up')
  })
  it('handles empty string', () => {
    expect(slugify('')).toBe('')
  })
  it('collapses multiple dashes', () => {
    expect(slugify('a  --  b')).toBe('a-b')
  })
})

// ---------------------------------------------------------------------------
// Store: open/close/save/dirty
// ---------------------------------------------------------------------------

describe('notes store', () => {
  beforeEach(() => {
    useNotesStore.setState({
      adapter: null,
      vaultConnected: false,
      files: [],
      fileTree: [],
      loading: false,
      openFiles: {},
      activeFilePath: null,
      expandedDirs: new Set(),
      selectedPath: null,
      quickSwitcherOpen: false,
    })
  })

  it('openFile adds to openFiles and sets active', async () => {
    const mockAdapter = {
      readFile: vi.fn().mockResolvedValue('# Hello'),
      listFiles: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      createDirectory: vi.fn(),
      renameFile: vi.fn(),
      exists: vi.fn(),
    }
    useNotesStore.setState({ adapter: mockAdapter as any, vaultConnected: true })

    await useNotesStore.getState().openFile('notes/foo.md')

    const state = useNotesStore.getState()
    expect(state.activeFilePath).toBe('notes/foo.md')
    expect(state.openFiles['notes/foo.md']).toBeDefined()
    expect(state.openFiles['notes/foo.md']!.content).toBe('# Hello')
    expect(state.openFiles['notes/foo.md']!.savedContent).toBe('# Hello')
  })

  it('openFile switches to existing tab without re-reading', async () => {
    const mockAdapter = {
      readFile: vi.fn().mockResolvedValue('content'),
      listFiles: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      createDirectory: vi.fn(),
      renameFile: vi.fn(),
      exists: vi.fn(),
    }
    useNotesStore.setState({ adapter: mockAdapter as any, vaultConnected: true })

    await useNotesStore.getState().openFile('a.md')
    await useNotesStore.getState().openFile('b.md')
    await useNotesStore.getState().openFile('a.md') // switch back

    expect(useNotesStore.getState().activeFilePath).toBe('a.md')
    // readFile called twice (a.md + b.md), not three times
    expect(mockAdapter.readFile).toHaveBeenCalledTimes(2)
  })

  it('closeFile removes from openFiles', async () => {
    useNotesStore.setState({
      openFiles: {
        'a.md': { path: 'a.md', content: 'test', savedContent: 'test' },
        'b.md': { path: 'b.md', content: 'test2', savedContent: 'test2' },
      },
      activeFilePath: 'a.md',
    })

    const closed = useNotesStore.getState().closeFile('a.md')
    expect(closed).toBe(true)
    expect(useNotesStore.getState().openFiles['a.md']).toBeUndefined()
    // Should switch to next tab
    expect(useNotesStore.getState().activeFilePath).toBe('b.md')
  })

  it('closeFile returns false for dirty file without force', () => {
    useNotesStore.setState({
      openFiles: {
        'a.md': { path: 'a.md', content: 'modified', savedContent: 'original' },
      },
      activeFilePath: 'a.md',
    })

    const closed = useNotesStore.getState().closeFile('a.md', false)
    expect(closed).toBe(false)
    expect(useNotesStore.getState().openFiles['a.md']).toBeDefined()
  })

  it('closeFile with force closes dirty file', () => {
    useNotesStore.setState({
      openFiles: {
        'a.md': { path: 'a.md', content: 'modified', savedContent: 'original' },
      },
      activeFilePath: 'a.md',
    })

    const closed = useNotesStore.getState().closeFile('a.md', true)
    expect(closed).toBe(true)
    expect(useNotesStore.getState().openFiles['a.md']).toBeUndefined()
  })

  it('saveFile writes content and marks clean', async () => {
    const mockAdapter = {
      readFile: vi.fn(),
      listFiles: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn(),
      createDirectory: vi.fn(),
      renameFile: vi.fn(),
      exists: vi.fn(),
    }
    useNotesStore.setState({
      adapter: mockAdapter as any,
      vaultConnected: true,
      openFiles: {
        'a.md': { path: 'a.md', content: 'updated content', savedContent: 'original' },
      },
      activeFilePath: 'a.md',
    })

    await useNotesStore.getState().saveFile()

    expect(mockAdapter.writeFile).toHaveBeenCalledWith('a.md', 'updated content')
    const file = useNotesStore.getState().openFiles['a.md']!
    expect(file.savedContent).toBe('updated content')
  })

  it('updateFileContent updates in-memory content', () => {
    useNotesStore.setState({
      openFiles: {
        'a.md': { path: 'a.md', content: 'old', savedContent: 'old' },
      },
    })

    useNotesStore.getState().updateFileContent('a.md', 'new text')
    expect(useNotesStore.getState().openFiles['a.md']!.content).toBe('new text')
  })

  it('isFileDirty returns true when content differs from saved', () => {
    useNotesStore.setState({
      openFiles: {
        'a.md': { path: 'a.md', content: 'modified', savedContent: 'original' },
        'b.md': { path: 'b.md', content: 'same', savedContent: 'same' },
      },
    })

    expect(useNotesStore.getState().isFileDirty('a.md')).toBe(true)
    expect(useNotesStore.getState().isFileDirty('b.md')).toBe(false)
  })

  it('nextTab and prevTab cycle through open files', () => {
    useNotesStore.setState({
      openFiles: {
        'a.md': { path: 'a.md', content: '', savedContent: '' },
        'b.md': { path: 'b.md', content: '', savedContent: '' },
        'c.md': { path: 'c.md', content: '', savedContent: '' },
      },
      activeFilePath: 'a.md',
    })

    useNotesStore.getState().nextTab()
    expect(useNotesStore.getState().activeFilePath).toBe('b.md')

    useNotesStore.getState().nextTab()
    expect(useNotesStore.getState().activeFilePath).toBe('c.md')

    useNotesStore.getState().nextTab()
    expect(useNotesStore.getState().activeFilePath).toBe('a.md') // wraps

    useNotesStore.getState().prevTab()
    expect(useNotesStore.getState().activeFilePath).toBe('c.md')
  })

  it('toggleDir expands and collapses', () => {
    useNotesStore.getState().toggleDir('notes')
    expect(useNotesStore.getState().expandedDirs.has('notes')).toBe(true)

    useNotesStore.getState().toggleDir('notes')
    expect(useNotesStore.getState().expandedDirs.has('notes')).toBe(false)
  })

  it('quick switcher open/close', () => {
    useNotesStore.getState().openQuickSwitcher()
    expect(useNotesStore.getState().quickSwitcherOpen).toBe(true)

    useNotesStore.getState().closeQuickSwitcher()
    expect(useNotesStore.getState().quickSwitcherOpen).toBe(false)
  })

  it('deleteFile removes from vault and closes tab', async () => {
    const mockAdapter = {
      readFile: vi.fn(),
      listFiles: vi.fn().mockResolvedValue([]),
      writeFile: vi.fn(),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      createDirectory: vi.fn(),
      renameFile: vi.fn(),
      exists: vi.fn(),
    }
    useNotesStore.setState({
      adapter: mockAdapter as any,
      vaultConnected: true,
      openFiles: {
        'a.md': { path: 'a.md', content: 'test', savedContent: 'test' },
      },
      activeFilePath: 'a.md',
    })

    await useNotesStore.getState().deleteFile('a.md')

    expect(mockAdapter.deleteFile).toHaveBeenCalledWith('a.md')
    expect(useNotesStore.getState().openFiles['a.md']).toBeUndefined()
    expect(useNotesStore.getState().activeFilePath).toBeNull()
  })

  it('renameFile updates open tab path', async () => {
    const mockAdapter = {
      readFile: vi.fn(),
      listFiles: vi.fn().mockResolvedValue([]),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      createDirectory: vi.fn(),
      renameFile: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn(),
    }
    useNotesStore.setState({
      adapter: mockAdapter as any,
      vaultConnected: true,
      openFiles: {
        'old.md': { path: 'old.md', content: 'test', savedContent: 'test' },
      },
      activeFilePath: 'old.md',
    })

    await useNotesStore.getState().renameFile('old.md', 'new.md')

    expect(mockAdapter.renameFile).toHaveBeenCalledWith('old.md', 'new.md')
    expect(useNotesStore.getState().openFiles['old.md']).toBeUndefined()
    expect(useNotesStore.getState().openFiles['new.md']).toBeDefined()
    expect(useNotesStore.getState().activeFilePath).toBe('new.md')
  })
})
