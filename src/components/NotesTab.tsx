import { memo, useEffect } from 'react'
import { useNotesStore } from '@/store/notes'
import { useUiStore } from '@/store/ui'
import { useBlogStore } from '@/store/blog'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { NotesFileBrowser } from './NotesFileBrowser'
import { NotesEditor } from './NotesEditor'
import { NotesQuickSwitcher } from './NotesQuickSwitcher'
import { NotesLinkPicker } from './NotesLinkPicker'
import { NotesCommandPalette } from './NotesCommandPalette'
import { NewNoteModal } from './NewNoteModal'
import { CirclesView } from './notes/CirclesView'
import { FolderOpen } from 'lucide-react'

export const NotesTab = memo(function NotesTab() {
  const vaultConnected = useNotesStore((s) => s.vaultConnected)
  const loading = useNotesStore((s) => s.loading)
  const activeFilePath = useNotesStore((s) => s.activeFilePath)
  const reconnectVault = useNotesStore((s) => s.reconnectVault)
  const connectVault = useNotesStore((s) => s.connectVault)
  const quickSwitcherOpen = useNotesStore((s) => s.quickSwitcherOpen)
  const linkPickerOpen = useNotesStore((s) => s.linkPickerOpen)
  const commandPaletteOpen = useNotesStore((s) => s.commandPaletteOpen)
  const newFileFormOpen = useNotesStore((s) => s.newFileFormOpen)
  const viewMode = useNotesStore((s) => s.viewMode)
  const isMobile = useIsMobile()

  // Try to reconnect on mount (persisted handle or hub)
  useEffect(() => {
    if (!vaultConnected) {
      reconnectVault()
    }
    // Tag set used by frontmatter autocomplete in the editor
    void useBlogStore.getState().refreshTags()
  }, [])

  // Rescan vault when switching to notes tab
  useEffect(() => {
    let prev = useUiStore.getState().activePane
    return useUiStore.subscribe((s) => {
      if (s.activePane === 'notes' && prev !== 'notes' && useNotesStore.getState().vaultConnected) {
        useNotesStore.getState().loadVaultFiles()
      }
      prev = s.activePane
    })
  }, [])

  if (loading && !vaultConnected) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-text-secondary">Loading vault...</p>
      </div>
    )
  }

  if (!vaultConnected) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-4">
        <FolderOpen size={24} className="text-text-tertiary" />
        <p className="text-sm text-text-secondary">Open your Obsidian vault</p>
        <p className="text-xs text-text-tertiary max-w-xs">
          Select the vault directory to browse and edit notes directly from Console.
        </p>
        <button
          onClick={connectVault}
          className="mt-1 px-3 py-1.5 text-xs font-medium bg-surface-2 text-text-primary rounded-sm hover:bg-surface-1 border border-border transition-colors"
        >
          Open Vault
        </button>
      </div>
    )
  }

  // Mobile: show browser/circles or editor, not both
  if (isMobile) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        {activeFilePath
          ? <NotesEditor />
          : (viewMode === 'circles' ? <CirclesView /> : <NotesFileBrowser />)}
        {quickSwitcherOpen && <NotesQuickSwitcher />}
        {linkPickerOpen && <NotesLinkPicker />}
        {commandPaletteOpen && <NotesCommandPalette />}
        {newFileFormOpen && <NewNoteModal />}
      </div>
    )
  }

  // Desktop: sidebar + editor. Circles view replaces the narrow tree with a wider pane.
  const sidebarWidthClass = viewMode === 'circles' ? 'w-[40%] min-w-[320px] max-w-[640px]' : 'w-56'
  return (
    <div className="flex flex-1 min-h-0">
      <div className={`${sidebarWidthClass} flex-shrink-0 border-r border-border overflow-hidden flex flex-col`}>
        {viewMode === 'circles' ? <CirclesView /> : <NotesFileBrowser />}
      </div>
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <NotesEditor />
      </div>
      {quickSwitcherOpen && <NotesQuickSwitcher />}
      {linkPickerOpen && <NotesLinkPicker />}
      {commandPaletteOpen && <NotesCommandPalette />}
      {newFileFormOpen && <NewNoteModal />}
    </div>
  )
})
