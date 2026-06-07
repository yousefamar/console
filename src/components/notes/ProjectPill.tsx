import { useEffect, useMemo } from 'react'
import { Bot, Folder } from 'lucide-react'
import { useBlogStore } from '@/store/blog'
import { useAgentStore } from '@/store/agent'

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
  const agentSessions = useAgentStore((s) => s.sessions)

  useEffect(() => {
    void refreshPosts(slug)
  }, [slug, refreshPosts])

  const sessionCount = useMemo(() => {
    const needle = `/projects/${slug}`
    return agentSessions.filter((s) => {
      if (!s.cwd || s.status === 'ended') return false
      return s.cwd === needle || s.cwd.endsWith(needle) || s.cwd.includes(needle + '/')
    }).length
  }, [agentSessions, slug])

  // Fall back to a humanised slug when the project isn't tracked
  // (no index.md / log:true). The directory is still the project for
  // agent-session purposes.
  const title = project?.title ?? humaniseSlug(slug)
  const status = project?.status
  const statusColor =
    status === 'complete' ? 'text-text-tertiary' :
    status === 'dormant' ? 'text-yellow-400' :
    status === 'active' ? 'text-green-400' :
    'text-text-tertiary'

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
      <span>{title}</span>
      {project && posts && <span className="text-text-tertiary">· {posts.length} {posts.length === 1 ? 'post' : 'posts'}</span>}
      {sessionCount > 0 && (
        <span className="flex items-center gap-0.5 text-green-400" title={`${sessionCount} active agent session${sessionCount === 1 ? '' : 's'}`}>
          · <Bot size={9} />{sessionCount}
        </span>
      )}
      {status && <span className={statusColor}>· {status}</span>}
      {!project && <span className="text-text-tertiary italic">· untracked</span>}
    </button>
  )
}

function humaniseSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ')
}
