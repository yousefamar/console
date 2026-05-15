import { useEffect } from 'react'
import { FileText, Plus } from 'lucide-react'
import { useBlogStore } from '@/store/blog'
import { useUiStore } from '@/store/ui'
import { useNotesStore } from '@/store/notes'
import { showAlert, showPrompt } from '@/dialog'
import { HomeScrollPane } from './HomeScrollPane'

export function BlogDraftsCard() {
  const drafts = useBlogStore((s) => s.drafts)
  const loading = useBlogStore((s) => s.draftsLoading)
  const refresh = useBlogStore((s) => s.refreshDrafts)
  const createDraft = useBlogStore((s) => s.createDraft)

  useEffect(() => {
    void refresh()
    const t = setInterval(() => { void refresh() }, 60_000)
    return () => clearInterval(t)
  }, [refresh])

  const open = (path: string) => {
    useUiStore.getState().setActivePane('notes')
    void useNotesStore.getState().openFile(path)
  }

  const create = async () => {
    const title = await showPrompt('Draft title?', { title: 'New blog draft', placeholder: 'e.g. Why I switched to vim', confirmLabel: 'Create' })
    if (!title || !title.trim()) return
    const r = await createDraft({ title })
    if (!r.ok) await showAlert(`Failed to create draft: ${r.error}`, { title: 'Error' })
  }

  return (
    <section className="flex flex-col h-full min-h-0 border border-border rounded-sm bg-surface-1 overflow-hidden">
      <header className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">Drafts</h2>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-tertiary">{drafts.length}</span>
          <button
            onClick={() => { void create() }}
            className="text-text-tertiary hover:text-text-primary transition-colors duration-fast"
            title="New draft"
            aria-label="New draft"
          >
            <Plus size={12} />
          </button>
        </div>
      </header>
      <HomeScrollPane>
        {drafts.length === 0 && (
          <div className="px-3 py-4 text-xs text-text-tertiary">{loading ? 'Loading…' : 'No drafts. Write something.'}</div>
        )}
        <ul className="divide-y divide-border">
          {drafts.map((d) => {
            const ageDays = (Date.now() - d.mtime) / 86400000
            const ageColor = ageDays > 30 ? 'text-red-400' : ageDays > 7 ? 'text-yellow-400' : 'text-text-tertiary'
            return (
              <li
                key={d.path}
                onClick={() => open(d.path)}
                className="flex items-start gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-pointer"
                role="button"
              >
                <FileText size={12} className="text-text-tertiary mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-text-primary truncate">{d.title}</div>
                  <div className={`text-[10px] truncate ${ageColor}`}>{fmtAge(ageDays)}</div>
                </div>
              </li>
            )
          })}
        </ul>
      </HomeScrollPane>
    </section>
  )
}

function fmtAge(days: number): string {
  if (days < 1) {
    const h = days * 24
    if (h < 1) return 'just now'
    return `${Math.round(h)}h ago`
  }
  if (days < 30) return `${Math.round(days)}d ago`
  if (days < 365) return `${Math.round(days / 30)}mo ago`
  return `${(days / 365).toFixed(1)}y ago`
}
