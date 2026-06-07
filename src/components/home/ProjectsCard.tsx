import { useEffect } from 'react'
import { Folder, Plus } from 'lucide-react'
import { useBlogStore } from '@/store/blog'
import { useUiStore } from '@/store/ui'
import { useNotesStore } from '@/store/notes'
import { showAlert, showPrompt } from '@/dialog'
import { HomeScrollPane } from './HomeScrollPane'

export function ProjectsCard() {
  const projects = useBlogStore((s) => s.projects)
  const loading = useBlogStore((s) => s.projectsLoading)
  const refresh = useBlogStore((s) => s.refreshProjects)
  const createDraft = useBlogStore((s) => s.createDraft)
  const createProject = useBlogStore((s) => s.createProject)

  useEffect(() => {
    void refresh()
    const t = setInterval(() => { void refresh() }, 5 * 60_000)
    return () => clearInterval(t)
  }, [refresh])

  // Active projects only — dormant/complete are documented escapes from the nudge
  const active = projects.filter((p) => p.status === 'active')

  const open = (path: string) => {
    useUiStore.getState().setActivePane('notes')
    void useNotesStore.getState().openFile(path)
  }

  const newPost = async (slug: string, projectTitle: string) => {
    const title = await showPrompt(`Title for the post about ${projectTitle}:`, { title: `New post — ${projectTitle}`, confirmLabel: 'Create' })
    if (!title || !title.trim()) return
    const r = await createDraft({ title, project: slug })
    if (!r.ok) await showAlert(`Failed to create draft: ${r.error}`, { title: 'Error' })
  }

  const newProject = async () => {
    const title = await showPrompt('Project title:', { title: 'New project', placeholder: 'e.g. Cura', confirmLabel: 'Create' })
    if (!title || !title.trim()) return
    const r = await createProject({ title })
    if (!r.ok) await showAlert(`Failed to create project: ${r.error}`, { title: 'Error' })
  }

  return (
    <section className="flex flex-col h-full min-h-0 border border-border rounded-sm bg-surface-1 overflow-hidden">
      <header className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">Active projects</h2>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-tertiary">{active.length}</span>
          <button
            onClick={() => { void newProject() }}
            className="text-text-tertiary hover:text-text-primary transition-colors duration-fast"
            title="New project"
            aria-label="New project"
          >
            <Plus size={12} />
          </button>
        </div>
      </header>
      <HomeScrollPane>
        {active.length === 0 && (
          <div className="px-3 py-4 text-xs text-text-tertiary">{loading ? 'Loading…' : 'No active projects.'}</div>
        )}
        <ul className="divide-y divide-border">
          {active.map((p) => {
            const ageDays = p.lastPostMtime ? (Date.now() - p.lastPostMtime) / 86400000 : null
            const ageColor = ageDays === null ? 'text-text-tertiary' : ageDays > 90 ? 'text-red-400' : ageDays > 30 ? 'text-yellow-400' : 'text-text-tertiary'
            return (
              <li
                key={p.slug}
                onClick={() => open(p.path)}
                className="group flex items-start gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-pointer"
                role="button"
              >
                <Folder size={12} className="text-text-tertiary mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-text-primary truncate">{p.title}</div>
                  <div className={`text-[10px] truncate ${ageColor}`}>
                    {ageDays === null ? 'no posts yet' : `last post ${fmtAge(ageDays)}`}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); void newPost(p.slug, p.title) }}
                  className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-text-primary transition-opacity duration-fast self-center shrink-0"
                  title={`New post about ${p.title}`}
                  aria-label={`New post about ${p.title}`}
                >
                  <Plus size={12} />
                </button>
              </li>
            )
          })}
        </ul>
      </HomeScrollPane>
    </section>
  )
}

function fmtAge(days: number): string {
  if (days < 1) return 'today'
  if (days < 30) return `${Math.round(days)}d ago`
  if (days < 365) return `${Math.round(days / 30)}mo ago`
  return `${(days / 365).toFixed(1)}y ago`
}
