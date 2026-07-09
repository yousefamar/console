import { memo, useEffect, useState } from 'react'
import { useNotesStore, isPenPagePath } from '@/store/notes'
import { useBlogStore, enclosingProjectSlug } from '@/store/blog'
import { NotesEditorCore } from './NotesEditorCore'
import { PenPageRenderer } from './notes/PenPageRenderer'
import { ProjectPill } from './notes/ProjectPill'
import { ProjectPanel } from './notes/ProjectPanel'
import { WriteMetaBar } from './notes/WriteMetaBar'
import { WriteActionBar } from './notes/WriteActionBar'
import { X, ChevronLeft, ExternalLink, Send } from 'lucide-react'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { showConfirm } from '@/dialog'
import { useUiStore } from '@/store/ui'
import { isDraftPath, isPublishedPath, permalinkForLogPath } from '@/utils/frontmatter'

const PANEL_TOGGLE_KEY = 'console:notes:projectPanelOpen'
const MOBILE_VIM_KEY = 'console:notes:mobileVim'

export const NotesEditor = memo(function NotesEditor() {
  const openFiles = useNotesStore((s) => s.openFiles)
  const activeFilePath = useNotesStore((s) => s.activeFilePath)
  const setActiveFile = useNotesStore((s) => s.setActiveFile)
  const closeFile = useNotesStore((s) => s.closeFile)
  const isFileDirty = useNotesStore((s) => s.isFileDirty)
  const isMobile = useIsMobile()

  // Project panel: relevant for ANY file under projects/<slug>/, even when
  // that project isn't tracked by the blog tooling (no index.md / log:true).
  // The agent affordance still applies — the directory IS the project as
  // far as the spawned agent is concerned.
  const slug = enclosingProjectSlug(activeFilePath)
  // Per-client toggle (localStorage, not synced) — defaults to last user choice.
  // First-time default: open on desktop, closed on mobile (so it doesn't fill the screen).
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false
    const v = localStorage.getItem(PANEL_TOGGLE_KEY)
    if (v === 'true') return true
    if (v === 'false') return false
    return !isMobile  // first-run default
  })
  useEffect(() => { localStorage.setItem(PANEL_TOGGLE_KEY, String(panelOpen)) }, [panelOpen])
  const showPanel = panelOpen && slug !== null && !isMobile

  // Mobile vim: off by default (soft keyboards fight modal editing), but a
  // hardware (BT) keyboard flips it on. Detection is heuristic: soft keyboards
  // emit composition events (keyCode 229 / key 'Unidentified') — a real
  // Escape or Ctrl-chord can only come from physical keys. Manual fallback:
  // the status-bar 'vim' chip is tappable on mobile.
  const [mobileVim, setMobileVim] = useState<boolean>(() => localStorage.getItem(MOBILE_VIM_KEY) === 'true')
  useEffect(() => { localStorage.setItem(MOBILE_VIM_KEY, String(mobileVim)) }, [mobileVim])
  useEffect(() => {
    if (!isMobile || mobileVim) return
    const onKey = (e: KeyboardEvent) => {
      const physical = e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key.length === 1)
      if (physical && e.keyCode !== 229 && e.key !== 'Unidentified') {
        setMobileVim(true)
        useUiStore.getState().pushToast({ kind: 'info', message: 'Hardware keyboard detected — vim mode on', detail: 'Tap "vim" in the status bar to toggle' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMobile, mobileVim])

  const paths = Object.keys(openFiles)
  const activeFile = activeFilePath ? openFiles[activeFilePath] : null

  // "Writing files" get the focused-writing chrome: meta bar, action bar,
  // no gutters. Drafts AND published posts qualify.
  const isWritingFile = isDraftPath(activeFilePath) || isPublishedPath(activeFilePath)
  const permalink = activeFilePath ? permalinkForLogPath(activeFilePath) : null

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

  const handleClose = async (path: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    const dirty = isFileDirty(path)
    if (dirty) {
      if (!(await showConfirm('This file has unsaved changes. Close anyway?', { title: 'Unsaved changes', danger: true, confirmLabel: 'Close' }))) return
    }
    closeFile(path, true)
  }

  const handlePublish = async () => {
    if (!activeFilePath || !isDraftPath(activeFilePath)) return
    const dirty = isFileDirty(activeFilePath)
    if (dirty) {
      if (!(await showConfirm('This draft has unsaved changes. Save and publish?', { title: 'Publish draft', confirmLabel: 'Save & publish' }))) return
      await useNotesStore.getState().saveFile()
    } else {
      if (!(await showConfirm('Publish this draft? It will be moved to log/ and the site rebuilt.', { title: 'Publish draft', confirmLabel: 'Publish' }))) return
    }
    const path = activeFilePath
    const ui = useUiStore.getState()
    const blog = useBlogStore.getState()
    const notes = useNotesStore.getState()
    ui.pushToast({ kind: 'info', message: 'Publishing…' })
    const r = await blog.publish(path)
    if (!r.ok) {
      ui.pushToast({ kind: 'error', message: `Publish failed: ${r.error}` })
      return
    }
    ui.pushToast({
      kind: r.rebuildOk ? 'success' : 'error',
      message: r.rebuildOk ? `Published → ${r.newPath}` : `Moved but rebuild failed: ${r.rebuildBody ?? '?'}`,
    })
    notes.closeFile(path, true)
    // Rescan the vault (draft file was moved to log/) then open the published
    // post, and refresh every blog list so the post shows as published:
    // it leaves Drafts, appears in Recent, and updates its project's devlog.
    await notes.loadVaultFiles()
    if (r.newPath) await notes.openFile(r.newPath)
    void blog.refreshDrafts()
    void blog.refreshRecentPosts()
    void blog.refreshProjects()
  }

  // Re-publish an already-published post: save edits, then re-trigger the
  // Eleventy build. No move, date unchanged.
  const handleRepublish = async () => {
    if (!activeFilePath || !isPublishedPath(activeFilePath)) return
    const ui = useUiStore.getState()
    const blog = useBlogStore.getState()
    const notes = useNotesStore.getState()
    if (isFileDirty(activeFilePath)) await notes.saveFile()
    ui.pushToast({ kind: 'info', message: 'Re-publishing…' })
    const r = await blog.republish(activeFilePath)
    if (!r.ok) { ui.pushToast({ kind: 'error', message: `Re-publish failed: ${r.error}` }); return }
    ui.pushToast({
      kind: r.rebuildOk ? 'success' : 'error',
      message: r.rebuildOk ? 'Re-published — site rebuilt' : `Saved but rebuild failed: ${r.rebuildBody ?? '?'}`,
      href: permalink ?? undefined,
    })
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

      {/* Post metadata bar — drafts and published posts only */}
      {isWritingFile && <WriteMetaBar path={activeFilePath!} />}

      {/* Editor + side panel overlay */}
      <div className="relative flex flex-col flex-1 min-h-0">
        {isPenPagePath(activeFilePath) ? (
          <PenPageRenderer filePath={activeFilePath!} content={activeFile.content} />
        ) : (
          <NotesEditorCore
            key={activeFilePath!}
            filePath={activeFilePath!}
            content={activeFile.content}
            options={isMobile ? { vim: mobileVim, gutters: false } : (isWritingFile ? { gutters: false } : undefined)}
          />
        )}
        {showPanel && slug && (
          <ProjectPanel slug={slug} onClose={() => setPanelOpen(false)} />
        )}
      </div>

      {/* Writing action bar — mobile-first thumb zone for posts */}
      {isWritingFile && (
        <WriteActionBar path={activeFilePath!} onPublish={() => void handlePublish()} onRepublish={() => void handleRepublish()} />
      )}

      {/* Status bar */}
      <div className="flex items-center justify-between border-t border-border px-3 py-0.5 flex-shrink-0">
        <span className="text-[10px] text-text-tertiary truncate">
          {activeFilePath}
        </span>
        <div className="flex items-center gap-2">
          {isDraftPath(activeFilePath) && !isWritingFile && (
            <button
              onClick={() => { void handlePublish() }}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-text-primary hover:bg-surface-2 rounded-sm transition-colors"
              title="Publish this draft (:publish)"
            >
              <Send size={10} />
              publish
            </button>
          )}
          {isPublishedPath(activeFilePath) && !isWritingFile && (
            <button
              onClick={() => { void handleRepublish() }}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-text-primary hover:bg-surface-2 rounded-sm transition-colors"
              title="Re-publish (save edits + rebuild the site)"
            >
              <Send size={10} />
              re-publish
            </button>
          )}
          {isPublishedPath(activeFilePath) && permalink && (
            <a
              href={permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-text-primary hover:bg-surface-2 rounded-sm transition-colors"
              title="View the live post"
            >
              <ExternalLink size={10} />
              live
            </a>
          )}
          {slug && !isMobile && (
            <ProjectPill slug={slug} open={panelOpen} onToggle={() => setPanelOpen((v) => !v)} />
          )}
          {isFileDirty(activeFilePath!) && (
            <span className="text-[10px] text-accent">modified</span>
          )}
          {isMobile ? (
            <button
              onClick={() => setMobileVim((v) => !v)}
              className={`text-[10px] px-1 rounded-sm transition-colors ${mobileVim ? 'text-text-primary bg-surface-2' : 'text-text-tertiary'}`}
              title="Toggle vim keybindings"
            >
              vim{mobileVim ? '' : ' off'}
            </button>
          ) : (
            <span className="text-[10px] text-text-tertiary">vim</span>
          )}
        </div>
      </div>
    </div>
  )
})
