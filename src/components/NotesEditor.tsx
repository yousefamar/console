import { memo } from 'react'
import { useNotesStore } from '@/store/notes'
import { NotesEditorCore } from './NotesEditorCore'
import { X, ChevronLeft } from 'lucide-react'
import { useIsMobile } from '@/hooks/useMediaQuery'

export const NotesEditor = memo(function NotesEditor() {
  const openFiles = useNotesStore((s) => s.openFiles)
  const activeFilePath = useNotesStore((s) => s.activeFilePath)
  const setActiveFile = useNotesStore((s) => s.setActiveFile)
  const closeFile = useNotesStore((s) => s.closeFile)
  const isFileDirty = useNotesStore((s) => s.isFileDirty)
  const isMobile = useIsMobile()

  const paths = Object.keys(openFiles)
  const activeFile = activeFilePath ? openFiles[activeFilePath] : null

  if (!activeFile) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center space-y-1">
          <p className="text-xs text-text-tertiary">No file open</p>
          <p className="text-[10px] text-text-tertiary">
            {isMobile ? 'Tap a file to open' : 'Select a file from the tree or press Ctrl+P'}
          </p>
        </div>
      </div>
    )
  }

  const handleClose = (path: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    const dirty = isFileDirty(path)
    if (dirty) {
      if (!confirm('This file has unsaved changes. Close anyway?')) return
    }
    closeFile(path, true)
  }

  const displayName = (path: string) => {
    const parts = path.split('/')
    return parts[parts.length - 1]!.replace(/\.md$/, '')
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border overflow-x-auto flex-shrink-0">
        {isMobile && (
          <button
            onClick={() => useNotesStore.setState({ activeFilePath: null })}
            className="flex items-center gap-0.5 px-2 py-1 text-xs text-text-tertiary hover:text-text-secondary flex-shrink-0"
          >
            <ChevronLeft size={12} />
          </button>
        )}
        {paths.map((path) => {
          const isActive = path === activeFilePath
          const dirty = isFileDirty(path)
          return (
            <div
              key={path}
              onClick={() => setActiveFile(path)}
              onMouseDown={(e) => {
                if (e.button === 1 && !isFileDirty(path)) closeFile(path, true)
              }}
              className={`flex items-center gap-1 px-2 py-1 text-xs cursor-pointer border-r border-border flex-shrink-0 transition-colors duration-fast ${
                isActive
                  ? 'bg-surface-0 text-text-primary'
                  : 'bg-surface-1 text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {dirty && <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />}
              <span className="truncate max-w-32">{displayName(path)}</span>
              <button
                onClick={(e) => handleClose(path, e)}
                className="text-text-tertiary hover:text-text-secondary transition-colors ml-0.5"
              >
                <X size={10} />
              </button>
            </div>
          )
        })}
      </div>

      {/* Editor */}
      <NotesEditorCore
        key={activeFilePath!}
        filePath={activeFilePath!}
        content={activeFile.content}
      />

      {/* Status bar */}
      <div className="flex items-center justify-between border-t border-border px-3 py-0.5 flex-shrink-0">
        <span className="text-[10px] text-text-tertiary truncate">
          {activeFilePath}
        </span>
        <div className="flex items-center gap-2">
          {isFileDirty(activeFilePath!) && (
            <span className="text-[10px] text-accent">modified</span>
          )}
          <span className="text-[10px] text-text-tertiary">vim</span>
        </div>
      </div>
    </div>
  )
})
