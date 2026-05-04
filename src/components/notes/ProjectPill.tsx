import { useEffect } from 'react'
import { Folder } from 'lucide-react'
import { useBlogStore } from '@/store/blog'

interface Props {
  slug: string
  open: boolean
  onToggle: () => void
}

/**
 * Status-bar chip in the Notes editor: "📁 al · 17 posts · active".
 * Mirrors the cron pill pattern. Only rendered when the active file is
 * a tracked project page (slug present in useBlogStore.projects).
 */
export function ProjectPill({ slug, open, onToggle }: Props) {
  const project = useBlogStore((s) => s.projects.find((p) => p.slug === slug))
  const posts = useBlogStore((s) => s.postsByProject[slug])
  const refreshPosts = useBlogStore((s) => s.refreshProjectPosts)

  useEffect(() => {
    void refreshPosts(slug)
  }, [slug, refreshPosts])

  if (!project) return null

  const status = project.status
  const statusColor =
    status === 'complete' ? 'text-text-tertiary' :
    status === 'dormant' ? 'text-yellow-400' :
    'text-green-400'

  return (
    <button
      onClick={onToggle}
      className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-sm transition-colors duration-fast ${
        open
          ? 'bg-surface-2 text-text-primary'
          : 'text-text-tertiary hover:text-text-secondary'
      }`}
      title={open ? 'Hide project panel' : 'Show project panel'}
    >
      <Folder size={10} />
      <span>{project.title}</span>
      {posts && <span className="text-text-tertiary">· {posts.length} {posts.length === 1 ? 'post' : 'posts'}</span>}
      <span className={statusColor}>· {status}</span>
    </button>
  )
}
