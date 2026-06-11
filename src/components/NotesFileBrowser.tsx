import { useState, useRef, useCallback, useEffect } from 'react'
import { useNotesStore, type TreeNode } from '@/store/notes'
import { showConfirm } from '@/dialog'
import { ChevronRight, Circle, File, FilePlus, Folder, Plus, RefreshCw, Search, Trash2, PenLine, NotebookPen } from 'lucide-react'

interface ContextMenu {
  x: number
  y: number
  path: string
  name: string
  isDir: boolean
}

export function NotesFileBrowser() {
  const fileTree = useNotesStore((s) => s.fileTree)
  const expandedDirs = useNotesStore((s) => s.expandedDirs)
  const activeFilePath = useNotesStore((s) => s.activeFilePath)
  const selectedPath = useNotesStore((s) => s.selectedPath)
  const loading = useNotesStore((s) => s.loading)
  const openFile = useNotesStore((s) => s.openFile)
  const toggleDir = useNotesStore((s) => s.toggleDir)
  const setSelectedPath = useNotesStore((s) => s.setSelectedPath)
  const openQuickSwitcher = useNotesStore((s) => s.openQuickSwitcher)
  const openNewFileForm = useNotesStore((s) => s.openNewFileForm)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  // Auto-expand parent dirs and scroll active file into view
  useEffect(() => {
    if (!activeFilePath) return
    // Expand all ancestor directories
    const parts = activeFilePath.split('/')
    const dirs: string[] = []
    for (let i = 0; i < parts.length - 1; i++) {
      dirs.push(parts.slice(0, i + 1).join('/'))
    }
    const { expandedDirs: current, toggleDir: toggle } = useNotesStore.getState()
    for (const dir of dirs) {
      if (!current.has(dir)) toggle(dir)
    }
    // Scroll into view after DOM updates
    requestAnimationFrame(() => {
      const el = treeRef.current?.querySelector(`[data-path="${CSS.escape(activeFilePath)}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    })
  }, [activeFilePath])

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, name: string, isDir = false) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, path, name, isDir })
  }, [])

  const handleDelete = useCallback(async (path: string, name: string) => {
    setContextMenu(null)
    if (await showConfirm(`Delete "${name.replace(/\.md$/, '')}"?`, { title: 'Delete file', danger: true, confirmLabel: 'Delete' })) {
      await useNotesStore.getState().deleteFile(path)
    }
  }, [])

  const handleStartRename = useCallback((path: string, name: string) => {
    setContextMenu(null)
    setRenaming({ path, value: name.replace(/\.md$/, '') })
  }, [])

  const handleRenameSubmit = useCallback(async () => {
    if (!renaming || !renaming.value.trim()) { setRenaming(null); return }
    const dir = renaming.path.split('/').slice(0, -1).join('/')
    const newPath = dir ? `${dir}/${renaming.value.trim()}.md` : `${renaming.value.trim()}.md`
    if (newPath !== renaming.path) {
      await useNotesStore.getState().renameFile(renaming.path, newPath)
    }
    setRenaming(null)
  }, [renaming])

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [contextMenu])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <button
          onClick={() => openQuickSwitcher()}
          className="flex-1 text-left text-xs text-text-tertiary hover:text-text-secondary transition-colors truncate"
        >
          Find file...
        </button>
        <button
          onClick={() => useNotesStore.getState().setViewMode('blog')}
          className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5"
          title="Switch to blog view"
        >
          <NotebookPen size={12} />
        </button>
        <button
          onClick={() => useNotesStore.getState().setViewMode('circles')}
          className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5"
          title="Switch to circles view"
        >
          <Circle size={12} />
        </button>
        <button
          onClick={() => useNotesStore.getState().loadVaultFiles()}
          className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5"
          title="Refresh file tree"
        >
          <RefreshCw size={12} />
        </button>
        <button
          onClick={() => useNotesStore.getState().openQuickSwitcher('content')}
          className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5"
          title="Search in files (Ctrl+Shift+F)"
        >
          <Search size={12} />
        </button>
        <button
          onClick={() => openNewFileForm()}
          className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5"
          title="New note (Ctrl+N)"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* File tree */}
      <div ref={treeRef} className="flex-1 overflow-y-auto py-0.5" data-notes-tree>
        {loading ? (
          <div className="px-3 py-4 text-center text-xs text-text-tertiary">Scanning vault...</div>
        ) : fileTree.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-text-tertiary">No files found</div>
        ) : (
          fileTree.map((node) => (
            <TreeNodeItem
              key={node.path}
              node={node}
              depth={0}
              expandedDirs={expandedDirs}
              activeFilePath={activeFilePath}
              selectedPath={selectedPath}
              renaming={renaming}
              onToggleDir={toggleDir}
              onOpenFile={openFile}
              onSelect={setSelectedPath}
              onContextMenu={handleContextMenu}
              onRenameChange={(v) => setRenaming(renaming ? { ...renaming, value: v } : null)}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={() => setRenaming(null)}
            />
          ))
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-surface-0 border border-border rounded-sm shadow-lg py-0.5 min-w-32"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.isDir ? (
            <button
              onClick={() => { setContextMenu(null); openNewFileForm(contextMenu.path) }}
              className="flex items-center gap-2 w-full px-3 py-1 text-xs text-text-primary hover:bg-surface-1 transition-colors"
            >
              <FilePlus size={11} className="text-text-tertiary" />
              New Note
            </button>
          ) : (
            <>
              <button
                onClick={() => handleStartRename(contextMenu.path, contextMenu.name)}
                className="flex items-center gap-2 w-full px-3 py-1 text-xs text-text-primary hover:bg-surface-1 transition-colors"
              >
                <PenLine size={11} className="text-text-tertiary" />
                Rename
              </button>
              <button
                onClick={() => handleDelete(contextMenu.path, contextMenu.name)}
                className="flex items-center gap-2 w-full px-3 py-1 text-xs text-red-400 hover:bg-surface-1 transition-colors"
              >
                <Trash2 size={11} />
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function TreeNodeItem({
  node,
  depth,
  expandedDirs,
  activeFilePath,
  selectedPath,
  renaming,
  onToggleDir,
  onOpenFile,
  onSelect,
  onContextMenu,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
}: {
  node: TreeNode
  depth: number
  expandedDirs: Set<string>
  activeFilePath: string | null
  selectedPath: string | null
  renaming: { path: string; value: string } | null
  onToggleDir: (path: string) => void
  onOpenFile: (path: string) => Promise<void>
  onSelect: (path: string | null) => void
  onContextMenu: (e: React.MouseEvent, path: string, name: string, isDir?: boolean) => void
  onRenameChange: (value: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
}) {
  const isExpanded = expandedDirs.has(node.path)
  const isActive = node.path === activeFilePath
  const isSelected = node.path === selectedPath
  const paddingLeft = 8 + depth * 14

  if (node.isDir) {
    return (
      <>
        <div
          onClick={() => onToggleDir(node.path)}
          onMouseDown={() => onSelect(node.path)}
          onContextMenu={(e) => onContextMenu(e, node.path, node.name, true)}
          className={`flex items-center gap-1 py-0.5 pr-2 cursor-pointer text-xs transition-colors duration-fast
            ${isSelected ? 'bg-surface-2' : 'hover:bg-surface-1'}
          `}
          style={{ paddingLeft }}
        >
          <ChevronRight
            size={10}
            className={`text-text-tertiary flex-shrink-0 transition-transform duration-fast ${isExpanded ? 'rotate-90' : ''}`}
          />
          <Folder size={11} className="text-text-tertiary flex-shrink-0" />
          <span className="text-text-secondary truncate">{node.name}</span>
        </div>
        {isExpanded &&
          node.children.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedDirs={expandedDirs}
              activeFilePath={activeFilePath}
              selectedPath={selectedPath}
              renaming={renaming}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              onRenameChange={onRenameChange}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
            />
          ))}
      </>
    )
  }

  const displayName = node.name.replace(/\.md$/, '')
  const isRenaming = renaming?.path === node.path

  if (isRenaming) {
    return (
      <div
        data-path={node.path}
        className="flex items-center gap-1 py-0.5 pr-2"
        style={{ paddingLeft }}
      >
        <File size={10} className="text-text-tertiary flex-shrink-0" />
        <input
          autoFocus
          type="text"
          value={renaming.value}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameSubmit()
            if (e.key === 'Escape') onRenameCancel()
          }}
          onBlur={onRenameSubmit}
          className="flex-1 min-w-0 px-1 py-0 text-xs bg-surface-1 border border-accent rounded-sm text-text-primary outline-none"
        />
      </div>
    )
  }

  return (
    <div
      data-path={node.path}
      onClick={() => onOpenFile(node.path)}
      onMouseDown={() => onSelect(node.path)}
      onContextMenu={(e) => onContextMenu(e, node.path, node.name)}
      className={`flex items-center gap-1 py-0.5 pr-2 cursor-pointer text-xs transition-colors duration-fast
        ${isActive ? 'bg-surface-2 text-text-primary' : isSelected ? 'bg-surface-1 text-text-secondary' : 'text-text-secondary hover:bg-surface-1'}
      `}
      style={{ paddingLeft }}
    >
      <File size={10} className="text-text-tertiary flex-shrink-0" />
      <span className="truncate">{displayName}</span>
    </div>
  )
}
