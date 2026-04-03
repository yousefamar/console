import { useState, useRef, useMemo } from 'react'
import { useFeedStore } from '@/store/feeds'
import { X, Upload, Plus } from 'lucide-react'

export function FeedAddModal() {
  const setShowAddModal = useFeedStore((s) => s.setShowAddModal)
  const addFeed = useFeedStore((s) => s.addFeed)
  const importOpml = useFeedStore((s) => s.importOpml)
  const feeds = useFeedStore((s) => s.feeds)

  const [url, setUrl] = useState('')
  const [folder, setFolder] = useState('')
  const [fullText, setFullText] = useState(false)
  const [importing, setImporting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [showFolderSuggestions, setShowFolderSuggestions] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Unique folder names for autocomplete
  const existingFolders = useMemo(() => {
    const set = new Set<string>()
    for (const f of feeds) {
      if (f.folder) set.add(f.folder)
    }
    return Array.from(set).sort()
  }, [feeds])

  const filteredFolders = useMemo(() => {
    if (!folder.trim()) return existingFolders
    const q = folder.toLowerCase()
    return existingFolders.filter((f) => f.toLowerCase().includes(q))
  }, [folder, existingFolders])

  const handleAdd = async () => {
    const trimmedUrl = url.trim()
    const trimmedFolder = folder.trim() || undefined

    // Folder-only: no URL means just create the folder (it'll appear when a feed uses it)
    if (!trimmedUrl && trimmedFolder) {
      // Nothing to actually create — folders are implicit from feed.folder
      // Just close the modal; user will add feeds to it later
      setShowAddModal(false)
      return
    }

    if (!trimmedUrl) return
    setAdding(true)
    await addFeed(trimmedUrl, trimmedFolder, fullText || undefined)
    setAdding(false)
    setShowAddModal(false)
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    await importOpml(file)
    setImporting(false)
    setShowAddModal(false)
  }

  const buttonLabel = !url.trim() && folder.trim()
    ? 'Create Folder'
    : adding ? 'Adding...' : 'Add Feed'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowAddModal(false)}>
      <div
        className="bg-surface-0 border border-border rounded-sm shadow-lg w-80 max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-text-primary">Add Feed</span>
          <button
            onClick={() => setShowAddModal(false)}
            className="text-text-tertiary hover:text-text-secondary"
          >
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="px-3 py-3 space-y-3">
          <div className="space-y-1.5">
            <label className="text-[10px] text-text-tertiary uppercase tracking-wider">Feed URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="https://example.com/feed.xml"
              className="w-full bg-surface-1 border border-border rounded-sm px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-text-tertiary"
              autoFocus
            />

            <label className="text-[10px] text-text-tertiary uppercase tracking-wider">Folder</label>
            <div className="relative">
              <input
                type="text"
                value={folder}
                onChange={(e) => { setFolder(e.target.value); setShowFolderSuggestions(true) }}
                onFocus={() => setShowFolderSuggestions(true)}
                onBlur={() => setTimeout(() => setShowFolderSuggestions(false), 150)}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                placeholder="Folder (optional — new name creates folder)"
                className="w-full bg-surface-1 border border-border rounded-sm px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-text-tertiary"
              />
              {showFolderSuggestions && filteredFolders.length > 0 && (
                <div className="absolute z-10 left-0 right-0 top-full mt-0.5 bg-surface-0 border border-border rounded-sm shadow-lg max-h-32 overflow-y-auto">
                  {filteredFolders.map((f) => (
                    <button
                      key={f}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setFolder(f); setShowFolderSuggestions(false) }}
                      className="w-full text-left px-2 py-1 text-xs text-text-secondary hover:bg-surface-1 transition-colors"
                    >
                      {f}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Full text toggle — only relevant when adding a feed */}
            {url.trim() && (
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fullText}
                  onChange={(e) => setFullText(e.target.checked)}
                  className="accent-text-primary"
                />
                <span className="text-[10px] text-text-secondary">Fetch full article text</span>
              </label>
            )}

            <button
              onClick={handleAdd}
              disabled={(!url.trim() && !folder.trim()) || adding}
              className="w-full flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium bg-surface-2 text-text-primary rounded-sm hover:bg-surface-1 border border-border transition-colors disabled:opacity-50"
            >
              <Plus size={12} />
              {buttonLabel}
            </button>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-2">
            <div className="flex-1 border-t border-border" />
            <span className="text-[10px] text-text-tertiary">or</span>
            <div className="flex-1 border-t border-border" />
          </div>

          {/* Import OPML */}
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".opml,.xml"
              onChange={handleImport}
              className="hidden"
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={importing}
              className="w-full flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium bg-surface-2 text-text-primary rounded-sm hover:bg-surface-1 border border-border transition-colors disabled:opacity-50"
            >
              <Upload size={12} />
              {importing ? 'Importing...' : 'Import OPML File'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
