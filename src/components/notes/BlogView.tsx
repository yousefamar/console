// Blog sidebar view — the writing-focused alternative to the file tree.
// Drafts (age-coloured), projects with expandable devlogs, recent published.
// Third Notes view mode alongside tree and circles.

import { useEffect, useState } from 'react'
import {
  FileText, Folder, FolderTree, Plus, RefreshCw, ChevronRight, ExternalLink, Circle,
} from 'lucide-react'
import { useNotesStore } from '@/store/notes'
import { useBlogStore } from '@/store/blog'
import { showAlert, showPrompt } from '@/dialog'
import { permalinkForLogPath } from '@/utils/frontmatter'

export function BlogView() {
  const drafts = useBlogStore((s) => s.drafts)
  const projects = useBlogStore((s) => s.projects)
  const recentPosts = useBlogStore((s) => s.recentPosts)
  const postsByProject = useBlogStore((s) => s.postsByProject)
  const openFile = useNotesStore((s) => s.openFile)
  const setViewMode = useNotesStore((s) => s.setViewMode)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    const blog = useBlogStore.getState()
    void blog.refreshDrafts()
    void blog.refreshProjects()
    void blog.refreshRecentPosts()
  }, [])

  const refresh = async () => {
    setRefreshing(true)
    const blog = useBlogStore.getState()
    await Promise.all([blog.refreshDrafts(), blog.refreshProjects(), blog.refreshRecentPosts()])
    setRefreshing(false)
  }

  const newPost = async (project?: { slug: string; title: string }) => {
    const title = await showPrompt(
      project ? `Title for the post about ${project.title}:` : 'Post title?',
      {
        title: project ? `New post — ${project.title}` : 'New post',
        placeholder: 'e.g. Why I switched to vim',
        confirmLabel: 'Create',
      },
    )
    if (!title || !title.trim()) return
    const r = await useBlogStore.getState().createDraft({ title, project: project?.slug })
    if (!r.ok) await showAlert(`Failed to create draft: ${r.error}`, { title: 'Error' })
  }

  const toggleProject = (slug: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) {
        next.delete(slug)
      } else {
        next.add(slug)
        void useBlogStore.getState().refreshProjectPosts(slug)
      }
      return next
    })
  }

  const activeProjects = projects.filter((p) => p.status === 'active')
  const otherProjects = projects.filter((p) => p.status !== 'active')

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="text-xs text-text-secondary font-medium">Blog</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => void refresh()}
            className={`text-text-tertiary hover:text-text-secondary transition-colors p-0.5 ${refreshing ? 'animate-spin' : ''}`}
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
          <button
            onClick={() => setViewMode('circles')}
            className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5"
            title="Switch to circles view"
          >
            <Circle size={12} />
          </button>
          <button
            onClick={() => setViewMode('tree')}
            className="text-text-tertiary hover:text-text-secondary transition-colors p-0.5"
            title="Switch to tree view"
          >
            <FolderTree size={12} />
          </button>
        </div>
      </div>

      {/* New post — the headline action, prominent */}
      <div className="px-2 py-2 border-b border-border">
        <button
          onClick={() => void newPost()}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs bg-surface-2 text-text-primary rounded-sm hover:bg-surface-0 border border-border transition-colors font-medium"
        >
          <Plus size={12} />
          New post
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Drafts */}
        <SectionHeader label="Drafts" count={drafts.length} />
        {drafts.length === 0 && (
          <div className="px-3 py-2 text-[10px] text-text-tertiary">No drafts. Write something.</div>
        )}
        <ul>
          {drafts.map((d) => {
            const ageDays = (Date.now() - d.mtime) / 86400000
            const ageColor = ageDays > 30 ? 'text-red-400' : ageDays > 7 ? 'text-yellow-400' : 'text-text-tertiary'
            return (
              <li
                key={d.path}
                onClick={() => void openFile(d.path)}
                className="flex items-start gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-pointer"
                role="button"
              >
                <FileText size={11} className="text-text-tertiary mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-text-primary truncate">{d.title}</div>
                  <div className={`text-[10px] truncate ${ageColor}`}>{fmtAge(ageDays)}</div>
                </div>
              </li>
            )
          })}
        </ul>

        {/* Projects (devlogs) */}
        <SectionHeader label="Projects" count={activeProjects.length} />
        <ul>
          {[...activeProjects, ...otherProjects].map((p) => {
            const expanded = expandedProjects.has(p.slug)
            const posts = postsByProject[p.slug]
            return (
              <li key={p.slug}>
                <div
                  onClick={() => toggleProject(p.slug)}
                  className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-surface-2 cursor-pointer"
                  role="button"
                >
                  <ChevronRight
                    size={10}
                    className={`text-text-tertiary shrink-0 transition-transform duration-fast ${expanded ? 'rotate-90' : ''}`}
                  />
                  <Folder size={11} className="text-text-tertiary shrink-0" />
                  <span className="text-xs text-text-primary truncate flex-1">{p.title}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); void newPost({ slug: p.slug, title: p.title }) }}
                    className="text-text-tertiary hover:text-text-primary transition-colors shrink-0 p-1 -m-1"
                    title={`New post about ${p.title}`}
                    aria-label={`New post about ${p.title}`}
                  >
                    <Plus size={11} />
                  </button>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                    p.status === 'active' ? 'bg-green-400' :
                    p.status === 'dormant' ? 'bg-yellow-400' : 'bg-text-tertiary opacity-40'
                  }`} />
                </div>
                {expanded && (
                  <ul className="ml-5 border-l border-border">
                    {!posts && <li className="px-3 py-1 text-[10px] text-text-tertiary">Loading…</li>}
                    {posts?.length === 0 && <li className="px-3 py-1 text-[10px] text-text-tertiary">No posts yet</li>}
                    {posts?.map((post) => (
                      <PostRow key={post.path} path={post.path} title={post.title} date={post.date} onOpen={openFile} />
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>

        {/* Recent published */}
        <SectionHeader label="Recent" count={recentPosts.length} />
        <ul>
          {recentPosts.map((post) => (
            <PostRow
              key={post.path}
              path={post.path}
              title={post.title}
              date={post.date}
              project={post.project}
              onOpen={openFile}
            />
          ))}
        </ul>
      </div>
    </div>
  )
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between px-3 pt-3 pb-1">
      <span className="text-[10px] text-text-tertiary uppercase tracking-wide">{label}</span>
      <span className="text-[10px] text-text-tertiary">{count}</span>
    </div>
  )
}

function PostRow({ path, title, date, project, onOpen }: {
  path: string
  title: string
  date: string | null
  project?: string | null
  onOpen: (path: string) => Promise<void>
}) {
  const permalink = permalinkForLogPath(path)
  return (
    <li
      onClick={() => void onOpen(path)}
      className="group flex items-start gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-pointer"
      role="button"
    >
      <FileText size={11} className="text-text-tertiary mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-text-primary truncate">{title}</div>
        <div className="text-[10px] text-text-tertiary truncate">
          {date ? date.split(' ')[0] : '(no date)'}
          {project && <span className="ml-1 text-text-secondary">· {project}</span>}
        </div>
      </div>
      {permalink && (
        <a
          href={permalink}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-text-primary transition-opacity duration-fast self-center shrink-0 p-1 -m-1"
          title="View live"
          aria-label="View live"
        >
          <ExternalLink size={11} />
        </a>
      )}
    </li>
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
