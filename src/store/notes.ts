import { create } from 'zustand'
import {
  type VaultAdapter,
  type VaultFile,
  FsaVaultAdapter,
  HubVaultAdapter,
  persistHandle,
  retrieveHandle,
} from '@/notes/vault-adapter'
import { NotesSearchIndex, type FilenameResult, type SearchResult } from '@/notes/search-index'
import { getPref, setPref, prefsReady, isPrefsLoaded, type PrefValue } from '@/prefs'
import { hubBus } from '@/sync-bus'
import { hubFetch } from '@/hub'

const EXPANDED_DIRS_PREF = 'notesExpandedDirs'
const VIEW_MODE_PREF = 'notesViewMode'

export type NotesViewMode = 'tree' | 'circles' | 'blog'
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenFile {
  path: string
  content: string
  savedContent: string   // last saved version — dirty = content !== savedContent
  /** Disk mtime this buffer is based on — the conflict-guard base for saves.
   *  Undefined = unknown (legacy tab), save falls back to last-writer-wins. */
  baseMtime?: number
}

export interface TreeNode {
  name: string
  path: string
  isDir: boolean
  /** File mtime; for dirs, the newest descendant's mtime (drives recency sort). */
  mtime: number
  children: TreeNode[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a tree structure from flat file list */
export function buildFileTree(files: VaultFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isDir: true, mtime: 0, children: [] }

  for (const f of files) {
    const parts = f.path.split('/')
    let node = root

    // Create intermediate directories; a dir's mtime is its newest descendant
    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i]!
      const dirPath = parts.slice(0, i + 1).join('/')
      let child = node.children.find((c) => c.isDir && c.name === dirName)
      if (!child) {
        child = { name: dirName, path: dirPath, isDir: true, mtime: 0, children: [] }
        node.children.push(child)
      }
      child.mtime = Math.max(child.mtime, f.mtime)
      node = child
    }

    // Add file
    node.children.push({
      name: parts[parts.length - 1]!,
      path: f.path,
      isDir: false,
      mtime: f.mtime,
      children: [],
    })
  }

  // Sort: directories first, then most recently modified first (dirs by
  // their newest descendant), name as tiebreaker
  const sortChildren = (node: TreeNode) => {
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return b.mtime - a.mtime || a.name.localeCompare(b.name)
    })
    for (const child of node.children) {
      if (child.isDir) sortChildren(child)
    }
  }
  sortChildren(root)

  return root.children
}

/** Slugify a title into a filename */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Extract unique directories from file list, sorted by most recent mtime. `scratch` always first. */
export function getDirectoriesByRecency(files: VaultFile[]): string[] {
  const dirMtime = new Map<string, number>()
  for (const f of files) {
    if (!f.dir) continue
    const cur = dirMtime.get(f.dir) ?? 0
    if (f.mtime > cur) dirMtime.set(f.dir, f.mtime)
  }
  // Always include scratch even if empty
  if (!dirMtime.has('scratch')) dirMtime.set('scratch', Infinity)
  const dirs = [...dirMtime.entries()]
    .sort((a, b) => {
      // scratch always first
      if (a[0] === 'scratch') return -1
      if (b[0] === 'scratch') return 1
      return b[1] - a[1]
    })
    .map(([dir]) => dir)
  return dirs
}

/** A pen-page file written by the live-stream pipeline: scratch/pen/<note>/page-<n>.svg */
export function isPenPagePath(path: string | null | undefined): boolean {
  return !!path && path.startsWith('scratch/pen/') && path.endsWith('.svg')
}

function penPageNum(path: string): number {
  const m = path.match(/page-(\d+)\.svg$/)
  return m ? parseInt(m[1]!, 10) : 0
}

/** Open the prev/next pen page in the same notebook folder (ordered by page number). */
async function stepPenPage(get: () => NotesState, dir: 1 | -1): Promise<void> {
  const { activeFilePath, files, openFile } = get()
  if (!activeFilePath || !isPenPagePath(activeFilePath)) return
  const folder = activeFilePath.split('/').slice(0, -1).join('/')
  const siblings = files
    .filter((f) => isPenPagePath(f.path) && f.path.split('/').slice(0, -1).join('/') === folder)
    .sort((a, b) => penPageNum(a.path) - penPageNum(b.path))
  const idx = siblings.findIndex((f) => f.path === activeFilePath)
  if (idx < 0) return
  const target = siblings[idx + dir]
  if (target) await openFile(target.path)
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface NotesState {
  // Vault
  adapter: VaultAdapter | null
  vaultConnected: boolean
  files: VaultFile[]
  fileTree: TreeNode[]
  loading: boolean

  // Live pen activity — drives the Notes tab red dot + auto-open-on-switch.
  penActivePagePath: string | null  // page currently/most-recently getting strokes
  penActiveAt: number               // ms timestamp of last pen activity
  penStreaming: boolean             // pen is live-streaming into Notes (drives the tab dot)

  // Open files — use a plain object for Zustand compatibility
  openFiles: Record<string, OpenFile>
  activeFilePath: string | null

  // Recently closed tabs (for reopen)
  recentlyClosedPaths: string[]

  // File browser
  expandedDirs: Set<string>
  selectedPath: string | null
  viewMode: NotesViewMode

  // Search
  quickSwitcherOpen: boolean
  quickSwitcherMode: 'filename' | 'content'
  searchIndex: NotesSearchIndex

  // Command palette
  commandPaletteOpen: boolean

  // New file form (triggered from Ctrl+N, context menu, sidebar button)
  newFileFormOpen: boolean
  newFileFormDir: string  // pre-filled directory
  newFileFormTitle: string // pre-filled title (e.g. from the Spaces switcher query)

  // Link picker
  linkPickerOpen: boolean
  linkPickerContext: { from: number; to: number; selectedText: string; mode: 'wiki' | 'both' } | null
  editorView: any | null  // EditorView — typed as any to avoid importing CM6 in store
  // Which file `editorView` belongs to. NotesEditorCore is keyed on the path and
  // remounts per file, so during a switch the slot briefly still holds the OLD
  // file's view — anyone dispatching positions into it (anchor scroll) must
  // check this first or they'll act on the wrong document.
  editorViewPath: string | null

  // Actions
  connectVault: () => Promise<void>
  reconnectVault: () => Promise<void>
  loadVaultFiles: () => Promise<void>
  /** Show dotfiles/dot-dirs in listings (persisted per device). */
  showHidden: boolean
  toggleShowHidden: () => Promise<void>
  restoreTabs: () => Promise<void>
  openFile: (path: string) => Promise<void>
  closeFile: (path: string, force?: boolean) => boolean
  saveFile: (path?: string) => Promise<void>
  updateFileContent: (path: string, content: string) => void
  createFile: (path: string, content?: string) => Promise<void>
  deleteFile: (path: string) => Promise<void>
  renameFile: (oldPath: string, newPath: string) => Promise<void>
  setActiveFile: (path: string) => void
  nextTab: () => void
  prevTab: () => void
  nextPageInFolder: () => Promise<void>
  prevPageInFolder: () => Promise<void>
  notePageSaved: (relPath: string) => void
  toggleDir: (path: string) => void
  setSelectedPath: (path: string | null) => void
  setViewMode: (mode: NotesViewMode) => void
  reopenLastClosedTab: () => void
  openQuickSwitcher: (mode?: 'filename' | 'content') => void
  closeQuickSwitcher: () => void
  openCommandPalette: () => void
  closeCommandPalette: () => void
  openNewFileForm: (dir?: string, title?: string) => void
  closeNewFileForm: () => void
  openLinkPicker: (ctx: { from: number; to: number; selectedText: string; mode: 'wiki' | 'both' }) => void
  closeLinkPicker: () => void
  setEditorView: (view: any | null, path?: string | null) => void
  searchFilenames: (query: string) => FilenameResult[]
  searchContent: (query: string) => SearchResult[]
  isFileDirty: (path: string) => boolean
  resolveImageUrl: (imagePath: string, fromFile: string) => Promise<string | null>
  pasteImage: (blob: Blob, filename: string) => Promise<string | null>
}

// ---------------------------------------------------------------------------
// Tab persistence
//
// The open-tab set is real user state — losing it is losing work-in-progress
// context — so the hub pref `notesOpenTabs` is authoritative and localStorage
// is only an offline mirror (read when the hub is unreachable at boot).
//
// Restoring MUST wait for `prefsReady()`: reading the pref cache before
// `initPrefs()` resolves yields the empty default, and the first subsequent
// persistTabs() would then write that empty set back over the real one.
// ---------------------------------------------------------------------------

const TABS_STORAGE_KEY = 'notesOpenTabs'
const TABS_PREF = 'notesOpenTabs'

type PersistedTabs = { paths: string[]; active: string | null }

// Set while restoreTabs() is re-opening the saved paths one at a time. Each
// openFile() would otherwise persist the partial set, so a reload landing
// mid-restore would truncate the saved tabs to however many had re-opened.
let restoring = false

/** Per-path save queue — see saveFile. Zustand-declaration-order note: must
 *  sit ABOVE the store (create() runs eagerly; a const below is in its TDZ). */
const savesInFlight = new Map<string, Promise<void>>()

function persistTabs(openFiles: Record<string, OpenFile>, activeFilePath: string | null) {
  if (restoring) return
  const data: PersistedTabs = {
    paths: Object.keys(openFiles),
    active: activeFilePath,
  }
  // Never push up while the pref cache is unloaded: the hub may hold a full tab
  // set we simply haven't read yet, and this write would destroy it. The local
  // mirror is still safe to update, and the next write after prefs land syncs.
  if (isPrefsLoaded()) setPref(TABS_PREF, data)
  try {
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(data))
  } catch {}
}

function coerceTabs(raw: unknown): PersistedTabs {
  const data = (raw ?? {}) as { paths?: unknown; active?: unknown }
  return {
    paths: Array.isArray(data.paths) ? data.paths.filter((p): p is string => typeof p === 'string') : [],
    active: typeof data.active === 'string' ? data.active : null,
  }
}

function localTabs(): PersistedTabs {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY)
    return raw ? coerceTabs(JSON.parse(raw)) : { paths: [], active: null }
  } catch {
    return { paths: [], active: null }
  }
}

async function loadPersistedTabs(): Promise<PersistedTabs> {
  // A hub that never answers must not block the restore forever, and a store
  // used outside the app (tests) never sees initPrefs() at all.
  await Promise.race([prefsReady(), new Promise((r) => setTimeout(r, 4000))])
  const fromHub = coerceTabs(getPref<PrefValue>(TABS_PREF, null))
  if (fromHub.paths.length > 0) return fromHub
  // Hub silent or empty: fall back to this device's last-known set. If it has
  // anything, it gets pushed up on the next persistTabs().
  return localTabs()
}

export const useNotesStore = create<NotesState>((set, get) => ({
  adapter: null,
  vaultConnected: false,
  files: [],
  fileTree: [],
  loading: false,
  // typeof guard: node-env unit tests import this store without a DOM.
  showHidden: typeof localStorage !== 'undefined' && localStorage.getItem('console:notes:showHidden') === 'true',
  penActivePagePath: null,
  penActiveAt: 0,
  penStreaming: false,
  openFiles: {},
  activeFilePath: null,
  recentlyClosedPaths: [],
  expandedDirs: new Set<string>(getPref<string[]>(EXPANDED_DIRS_PREF, [])),
  selectedPath: null,
  viewMode: getPref<NotesViewMode>(VIEW_MODE_PREF, 'tree'),
  quickSwitcherOpen: false,
  quickSwitcherMode: 'filename' as const,
  searchIndex: new NotesSearchIndex(),
  commandPaletteOpen: false,
  newFileFormOpen: false,
  newFileFormDir: 'scratch',
  newFileFormTitle: '',
  linkPickerOpen: false,
  linkPickerContext: null,
  editorView: null,
  editorViewPath: null,

  connectVault: async () => {
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' })
      await persistHandle(handle)
      const adapter = new FsaVaultAdapter(handle)
      set({ adapter, vaultConnected: true })
      await get().loadVaultFiles()
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        console.error('Failed to connect vault:', err)
      }
    }
  },

  reconnectVault: async () => {
    // Try FSA first (persisted handle)
    const handle = await retrieveHandle()
    if (handle) {
      try {
        const permission = await (handle as any).requestPermission({ mode: 'readwrite' })
        if (permission === 'granted') {
          const adapter = new FsaVaultAdapter(handle)
          set({ adapter, vaultConnected: true })
          await get().loadVaultFiles()
          return
        }
      } catch {
        // Permission denied or handle invalid — fall through
      }
    }

    // Try hub fallback
    try {
      const hubAdapter = new HubVaultAdapter()
      const files = await hubAdapter.listFiles()
      set({
        adapter: hubAdapter,
        vaultConnected: true,
        files,
        fileTree: buildFileTree(files),
      })
      // This path doesn't go through loadVaultFiles(), so it needs its own
      // restore — without it, a hub-adapter boot came up with zero tabs.
      await get().restoreTabs()
      // Index in background
      const idx = get().searchIndex
      idx.buildIndex(files, (p) => hubAdapter.readFile(p))
    } catch {
      // Neither available
      set({ vaultConnected: false })
    }
  },

  toggleShowHidden: async () => {
    const next = !get().showHidden
    localStorage.setItem('console:notes:showHidden', String(next))
    set({ showHidden: next })
    await get().loadVaultFiles()
  },

  loadVaultFiles: async () => {
    const { adapter } = get()
    if (!adapter) return
    set({ loading: true })
    try {
      const files = await adapter.listFiles(get().showHidden)
      const tree = buildFileTree(files)
      const current = get().expandedDirs
      // Auto-expand top-level directories on first load (when nothing persisted)
      const expanded = current.size > 0
        ? current
        : new Set(tree.filter((n) => n.isDir).map((n) => n.path))
      set({ files, fileTree: tree, loading: false, expandedDirs: expanded })

      await get().restoreTabs()

      // Build search index in background
      const idx = get().searchIndex
      idx.buildIndex(files, (p) => adapter.readFile(p))
    } catch (err) {
      console.error('Failed to load vault files:', err)
      set({ loading: false })
    }
  },

  restoreTabs: async () => {
    const saved = await loadPersistedTabs()
    if (saved.paths.length === 0) return
    restoring = true
    try {
      // Re-opening is idempotent (openFile short-circuits on an already-open
      // path), so a second restore — e.g. a reconnect — is harmless.
      for (const path of saved.paths) await get().openFile(path)
    } finally {
      restoring = false
    }
    const active = saved.active && get().openFiles[saved.active] ? saved.active : get().activeFilePath
    set({ activeFilePath: active })
    // One write at the end, reflecting whatever actually re-opened (a deleted
    // file drops out here rather than lingering in the pref forever).
    persistTabs(get().openFiles, active)
  },

  openFile: async (path) => {
    const { adapter, openFiles } = get()
    if (!adapter) return

    // Already open — just switch to it
    if (openFiles[path]) {
      set({ activeFilePath: path })
      persistTabs(get().openFiles, path)
      return
    }

    try {
      const { content, mtime } = await adapter.readFileWithMeta(path)
      set((s) => ({
        openFiles: {
          ...s.openFiles,
          [path]: { path, content, savedContent: content, baseMtime: mtime },
        },
        activeFilePath: path,
      }))
      persistTabs(get().openFiles, path)
    } catch (err) {
      console.error('Failed to open file:', err)
    }
  },

  closeFile: (path, force = false) => {
    const { openFiles, activeFilePath } = get()
    const file = openFiles[path]
    if (!file) return true

    // Check dirty state
    if (!force && file.content !== file.savedContent) {
      return false // caller should show confirmation
    }

    const paths = Object.keys(openFiles)
    const idx = paths.indexOf(path)
    const newOpenFiles = { ...openFiles }
    delete newOpenFiles[path]

    // Pick next active tab
    let newActive = activeFilePath
    if (activeFilePath === path) {
      const remaining = Object.keys(newOpenFiles)
      if (remaining.length > 0) {
        // Try same index, then previous
        newActive = paths[idx + 1] ?? paths[idx - 1] ?? remaining[0]!
        if (!newOpenFiles[newActive!]) newActive = remaining[0]!
      } else {
        newActive = null
      }
    }

    const closed = [path, ...get().recentlyClosedPaths].slice(0, 20)
    set({ openFiles: newOpenFiles, activeFilePath: newActive, recentlyClosedPaths: closed })
    persistTabs(newOpenFiles, newActive)
    return true
  },

  saveFile: async (path?) => {
    const { adapter, searchIndex } = get()
    const filePath = path ?? get().activeFilePath
    if (!adapter || !filePath) return

    // Serialize concurrent saves of the same file: Ctrl+S reaches BOTH the
    // window keybinding and CM6's Mod-s keymap, and two racing writes made
    // the second 409 against the first's fresh mtime (a false conflict
    // dialog with identical byte counts). Queue, and re-read state inside —
    // the second save then sees the re-armed baseMtime and no-ops clean.
    const prev = savesInFlight.get(filePath) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(async () => {
    const file = get().openFiles[filePath]
    if (!file) return
    if (file.content === file.savedContent && file.baseMtime !== undefined) return

    try {
      let mtime: number | undefined
      try {
        mtime = (await adapter.writeFile(filePath, file.content, { baseMtime: file.baseMtime })).mtime
      } catch (err) {
        const { VaultConflictError } = await import('@/notes/vault-adapter')
        if (!(err instanceof VaultConflictError)) throw err
        // Disk moved under us (another device/agent saved since this tab
        // loaded). NEVER silently clobber — this ate a blog post (2026-08-21).
        const { showConfirm } = await import('@/dialog')
        const keepMine = await showConfirm(
          `"${filePath}" changed on disk since this tab loaded (this buffer: ${file.content.length} chars, disk: ${err.serverContent.length} chars).\n\nOverwrite the disk copy with this buffer? "Cancel" keeps YOUR text in the tab (unsaved) and re-arms against the disk version so you can compare first.`,
          { confirmLabel: 'Overwrite disk', cancelLabel: 'Keep editing', danger: true },
        )
        if (!keepMine) {
          // Re-arm the base so a LATER deliberate save wins; buffer untouched.
          set((s) => ({
            openFiles: {
              ...s.openFiles,
              [filePath]: { ...s.openFiles[filePath]!, savedContent: err.serverContent, baseMtime: err.serverMtime },
            },
          }))
          return
        }
        mtime = (await adapter.writeFile(filePath, file.content)).mtime
      }
      set((s) => {
        // Bump the in-memory mtime so consumers that compare against it
        // (recency sorts, the blog live-status chip) see the write without
        // waiting for a full vault rescan.
        const files = s.files.map((f) => (f.path === filePath ? { ...f, mtime: Date.now() } : f))
        return {
          openFiles: {
            ...s.openFiles,
            [filePath]: { ...s.openFiles[filePath]!, savedContent: file.content, baseMtime: mtime ?? Date.now() },
          },
          files,
          fileTree: buildFileTree(files),
        }
      })

      // Update search index
      searchIndex.updateDocument(filePath, file.content)

      // Saving a project index note re-derives its space title (frontmatter
      // `title:` is where a project is renamed) — refresh the Spaces rail.
      if (/^projects\/[^/]+(\/index)?\.md$/.test(filePath)) {
        void import('@/store/spaces').then(({ useSpacesStore }) => useSpacesStore.getState().refreshSpaces())
      }
    } catch (err) {
      console.error('Failed to save file:', err)
    }
    })
    savesInFlight.set(filePath, run)
    return run
  },

  updateFileContent: (path, content) => {
    set((s) => {
      const file = s.openFiles[path]
      if (!file || file.content === content) return s
      return {
        openFiles: {
          ...s.openFiles,
          [path]: { ...file, content },
        },
      }
    })
  },


  createFile: async (path, content = '') => {
    const { adapter, searchIndex } = get()
    if (!adapter) return

    await adapter.writeFile(path, content)

    // Refresh file list
    const files = await adapter.listFiles()
    set({ files, fileTree: buildFileTree(files) })

    // Update index
    searchIndex.updateDocument(path, content)

    // Open the new file
    await get().openFile(path)
  },

  deleteFile: async (path) => {
    const { adapter, searchIndex } = get()
    if (!adapter) return

    await adapter.deleteFile(path)

    // Close if open
    get().closeFile(path, true)

    // Refresh file list
    const files = await adapter.listFiles()
    set({ files, fileTree: buildFileTree(files) })

    // Remove from index
    searchIndex.removeDocument(path)
  },

  renameFile: async (oldPath, newPath) => {
    const { adapter, openFiles, searchIndex } = get()
    if (!adapter) return

    await adapter.renameFile(oldPath, newPath)

    // Update open tab if it was open
    const file = openFiles[oldPath]
    if (file) {
      const newOpenFiles = { ...openFiles }
      delete newOpenFiles[oldPath]
      newOpenFiles[newPath] = { ...file, path: newPath }
      set((s) => ({
        openFiles: newOpenFiles,
        activeFilePath: s.activeFilePath === oldPath ? newPath : s.activeFilePath,
      }))
    }

    // Refresh file list
    const files = await adapter.listFiles()
    set({ files, fileTree: buildFileTree(files) })

    // Update index
    searchIndex.removeDocument(oldPath)
    if (file) searchIndex.updateDocument(newPath, file.content)
  },

  setActiveFile: (path) => {
    set({ activeFilePath: path })
    persistTabs(get().openFiles, path)
  },

  nextTab: () => {
    const { openFiles, activeFilePath } = get()
    const paths = Object.keys(openFiles)
    if (paths.length <= 1) return
    const idx = paths.indexOf(activeFilePath ?? '')
    set({ activeFilePath: paths[(idx + 1) % paths.length] })
  },

  prevTab: () => {
    const { openFiles, activeFilePath } = get()
    const paths = Object.keys(openFiles)
    if (paths.length <= 1) return
    const idx = paths.indexOf(activeFilePath ?? '')
    set({ activeFilePath: paths[(idx - 1 + paths.length) % paths.length] })
  },

  nextPageInFolder: async () => { await stepPenPage(get, 1) },
  prevPageInFolder: async () => { await stepPenPage(get, -1) },

  notePageSaved: (relPath) => {
    if (!isPenPagePath(relPath)) return
    const { files } = get()
    if (files.some((f) => f.path === relPath)) return
    const name = relPath.split('/').pop() ?? relPath
    const dir = relPath.split('/').slice(0, -1).join('/')
    const vf: VaultFile = { path: relPath, name, dir, mtime: Date.now(), size: 0 }
    const next = [...files, vf].sort((a, b) => a.path.localeCompare(b.path))
    set({ files: next, fileTree: buildFileTree(next) })
  },

  toggleDir: (path) => {
    set((s) => {
      const next = new Set(s.expandedDirs)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      setPref(EXPANDED_DIRS_PREF, [...next])
      return { expandedDirs: next }
    })
  },

  setSelectedPath: (path) => set({ selectedPath: path }),

  setViewMode: (mode) => {
    setPref(VIEW_MODE_PREF, mode)
    set({ viewMode: mode })
  },

  reopenLastClosedTab: async () => {
    const { recentlyClosedPaths, openFiles } = get()
    // Find the first closed path that isn't already open
    const path = recentlyClosedPaths.find((p) => !openFiles[p])
    if (!path) return
    set({ recentlyClosedPaths: recentlyClosedPaths.filter((p) => p !== path) })
    await get().openFile(path)
  },

  openQuickSwitcher: (mode = 'filename') => set({ quickSwitcherOpen: true, quickSwitcherMode: mode as 'filename' | 'content' }),
  closeQuickSwitcher: () => set({ quickSwitcherOpen: false }),

  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),

  openNewFileForm: (dir = 'scratch', title = '') => set({ newFileFormOpen: true, newFileFormDir: dir, newFileFormTitle: title }),
  closeNewFileForm: () => set({ newFileFormOpen: false, newFileFormDir: 'scratch' }),

  openLinkPicker: (ctx) => set({ linkPickerOpen: true, linkPickerContext: ctx }),
  closeLinkPicker: () => set({ linkPickerOpen: false, linkPickerContext: null }),
  setEditorView: (view, path = null) => set({ editorView: view, editorViewPath: view ? path : null }),

  searchFilenames: (query) => {
    return get().searchIndex.searchFilenames(query)
  },

  searchContent: (query) => {
    return get().searchIndex.searchContent(query)
  },

  isFileDirty: (path) => {
    const file = get().openFiles[path]
    if (!file) return false
    return file.content !== file.savedContent
  },

  resolveImageUrl: async (imagePath, fromFile) => {
    const { adapter } = get()
    if (!adapter) return null

    // Try multiple resolution strategies (like Obsidian):
    // 1. Relative path from current file's directory
    // 2. Absolute path from vault root
    // 3. Search vault for matching filename (wiki-link style)

    const fileDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
    const candidates: string[] = []

    // If it's a bare filename (wiki-link style, e.g. "image.png"), search the vault
    const isBareFilename = !imagePath.includes('/')

    if (!isBareFilename) {
      // Resolve relative path from file's directory
      const parts = fileDir ? fileDir.split('/') : []
      for (const segment of imagePath.split('/')) {
        if (segment === '..') parts.pop()
        else if (segment !== '.') parts.push(segment)
      }
      candidates.push(parts.join('/'))
      // Also try from vault root
      candidates.push(imagePath)
    } else {
      // Bare filename — try current directory first, then search vault
      if (fileDir) candidates.push(`${fileDir}/${imagePath}`)
      candidates.push(imagePath)

      // Search common image directories
      candidates.push(`assets/${imagePath}`)
      candidates.push(`assets/images/${imagePath}`)

      // files only contains .md — we try the adapter directly below
    }

    // Try each candidate
    for (const path of candidates) {
      try {
        const blob = await adapter.readFileBinary(path)
        return URL.createObjectURL(blob)
      } catch {
        // Not found at this path, try next
      }
    }

    // If bare filename, try recursive search via adapter
    if (isBareFilename) {
      // Try common vault image locations
      const searchDirs = ['', fileDir, 'assets', 'assets/images', 'al/assets']
      for (const dir of searchDirs) {
        const path = dir ? `${dir}/${imagePath}` : imagePath
        if (candidates.includes(path)) continue
        try {
          const blob = await adapter.readFileBinary(path)
          return URL.createObjectURL(blob)
        } catch {
          // continue
        }
      }
    }

    // Final fallback: the SIBLING assets dir (~/sync/brain/assets — outside
    // the vault root, so no adapter can reach it). This is where Obsidian's
    // attachment folder and Eleventy's published assets actually live; the
    // hub serves it at /notes/asset/. Wiki-embeds like ![[Pasted image X.png]]
    // resolve here.
    const bareName = imagePath.split('/').pop()!
    for (const assetPath of [`images/${bareName}`, bareName]) {
      try {
        const { getHubUrl } = await import('@/hub')
        const res = await fetch(`${getHubUrl()}/notes/asset/${encodeURIComponent(assetPath)}`)
        if (res.ok) {
          const blob = await res.blob()
          return URL.createObjectURL(blob)
        }
      } catch {
        // hub unreachable — give up on this candidate
      }
    }

    return null
  },

  pasteImage: async (blob, filename) => {
    // Images go to the SIBLING assets dir (~/sync/brain/assets/images) via the
    // hub — that's Obsidian's attachment folder AND what Eleventy passthrough-
    // copies to the published site. Writing inside the vault root would render
    // in-editor but 404 on the live blog.
    try {
      const { getHubUrl } = await import('@/hub')
      const res = await fetch(`${getHubUrl()}/notes/asset/${encodeURIComponent(`images/${filename}`)}`, {
        method: 'PUT',
        body: blob,
      })
      if (res.ok) return filename
    } catch {
      // hub unreachable — fall through to vault-local write
    }

    // Fallback (offline / hub down): write inside the vault via the adapter.
    // Won't publish, but at least the content isn't lost.
    const { adapter } = get()
    if (!adapter) return null
    const path = `assets/images/${filename}`
    try {
      await adapter.createDirectory('assets/images')
      await adapter.writeFileBinary(path, blob)
      return path
    } catch (err) {
      console.error('Failed to paste image:', err)
      return null
    }
  },
}))

// Live pen pages → Notes integration:
//  • page_saved registers the new page file in the tree (no manual rescan).
//  • any activity tracks the actively-written page (for auto-open on tab switch)
//    and sets a sticky red-dot marker when strokes arrive while you're elsewhere.
// (PenPageRenderer subscribes to 'pen' independently for the live stroke overlay.)
if (typeof window !== 'undefined') {
  const penPath = (d: unknown): string | null => {
    const o = d as { relPath?: string; note?: number; page?: number } | null
    if (o?.relPath) return o.relPath
    if (o && o.note != null && o.page != null) return `scratch/pen/${o.note}/page-${o.page}.svg`
    return null
  }
  let lastWrite = 0
  const noteActivity = (data: unknown) => {
    const relPath = penPath(data)
    if (!relPath) return
    const now = Date.now()
    const pageChanged = useNotesStore.getState().penActivePagePath !== relPath
    // Throttle the high-frequency stroke_delta writes; always write on a change.
    if (!pageChanged && now - lastWrite < 1000) return
    lastWrite = now
    useNotesStore.setState({ penActivePagePath: relPath, penActiveAt: now })
  }
  hubBus.on('pen', 'page_open', noteActivity)
  hubBus.on('pen', 'stroke_delta', noteActivity)
  hubBus.on('pen', 'page_saved', (data) => {
    const relPath = penPath(data)
    if (relPath) useNotesStore.getState().notePageSaved(relPath)
    noteActivity(data)
  })

  // Streaming-active state drives the Notes-tab red dot. The hub broadcasts on
  // change; fetch once on load since SyncBus broadcasts aren't replayed.
  hubBus.on('pen', 'streaming', (d) => {
    useNotesStore.setState({ penStreaming: (d as { active?: boolean } | null)?.active === true })
  })
  hubFetch<{ active?: boolean }>('/pen/stream')
    .then((r) => useNotesStore.setState({ penStreaming: r?.active === true }))
    .catch(() => {})
}
