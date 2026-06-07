import { useEffect, useMemo, useState } from 'react'
import { X, Plus, FileText, RefreshCw, ChevronDown, Bot } from 'lucide-react'
import { useBlogStore } from '@/store/blog'
import { useNotesStore } from '@/store/notes'
import { useAgentStore, type SessionInfo } from '@/store/agent'
import { useUiStore } from '@/store/ui'
import { showAlert, showPrompt } from '@/dialog'
import { getVaultPath } from '@/notes/vault-info'

interface Props {
  slug: string
  onClose: () => void
}

// Stable empty-array reference. Without this, `useBlogStore((s) => s.postsByProject[slug] ?? [])`
// would mint a fresh `[]` on every selector call, defeating Zustand's Object.is shallow check
// and causing an infinite render loop.
const EMPTY_POSTS: never[] = []

type Status = 'active' | 'dormant' | 'complete'

/**
 * Right-side panel mirroring the cron panel pattern. Shows the project's
 * status (with dropdown to change), chronological post list, and a
 * "new post" button.
 *
 * Posts list refreshes on slug change and on manual refresh — NOT on every
 * editor keystroke.
 */
export function ProjectPanel({ slug, onClose }: Props) {
  const project = useBlogStore((s) => s.projects.find((p) => p.slug === slug))
  const posts = useBlogStore((s) => s.postsByProject[slug]) ?? EMPTY_POSTS
  const refreshPosts = useBlogStore((s) => s.refreshProjectPosts)
  const refreshProjects = useBlogStore((s) => s.refreshProjects)
  const setProjectStatus = useBlogStore((s) => s.setProjectStatus)
  const createDraft = useBlogStore((s) => s.createDraft)
  const openFile = useNotesStore((s) => s.openFile)
  const agentSessions = useAgentStore((s) => s.sessions)
  const [statusOpen, setStatusOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [vaultPath, setVaultPath] = useState<string | null>(null)

  useEffect(() => {
    void getVaultPath().then(setVaultPath)
  }, [])

  // Sessions whose cwd is anywhere under projects/<slug>/. Match on the
  // suffix so it works regardless of vault location (and survives if we
  // failed to fetch vaultPath — the suffix is unambiguous).
  const projectSessions = useMemo<SessionInfo[]>(() => {
    const needle = `/projects/${slug}`
    return agentSessions.filter((s) => {
      if (!s.cwd) return false
      if (s.status === 'ended') return false
      return s.cwd === needle || s.cwd.endsWith(needle) || s.cwd.includes(needle + '/')
    })
  }, [agentSessions, slug])

  useEffect(() => {
    void refreshPosts(slug)
  }, [slug, refreshPosts])

  // Untracked project directories (no index.md / log:true) still get the panel
  // for the agent-session affordance. Title falls back to a humanised slug.
  const title = project?.title ?? humaniseSlug(slug)
  const isUntracked = !project

  function humaniseSlug(s: string): string {
    return s
      .split('-')
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ')
  }

  const setStatus = async (status: Status) => {
    setStatusOpen(false)
    if (status === project.status) return
    const r = await setProjectStatus(slug, status)
    if (!r.ok) {
      await showAlert(`Failed to update status: ${r.error}`, { title: 'Error' })
      return
    }
    void refreshProjects()
  }

  const newPost = async () => {
    const postTitle = await showPrompt(`Title for the post about ${title}:`, {
      title: `New post — ${title}`,
      confirmLabel: 'Create',
    })
    if (!postTitle || !postTitle.trim()) return
    const r = await createDraft({ title: postTitle, project: slug })
    if (!r.ok) await showAlert(`Failed to create draft: ${r.error}`, { title: 'Error' })
  }

  const startAgent = async () => {
    if (!vaultPath) {
      await showAlert('Vault path not loaded yet — try again in a moment.', { title: 'Not ready' })
      return
    }
    const prompt = await showPrompt(`First message for the new ${title} agent:`, {
      title: `Start agent — ${title}`,
      placeholder: 'e.g. Help me plan the next iteration',
      confirmLabel: 'Start',
    })
    if (!prompt || !prompt.trim()) return
    const cwd = `${vaultPath}/projects/${slug}`
    useAgentStore.getState().createSession(prompt.trim(), cwd, undefined, title)
    useUiStore.getState().setActivePane('agents')
  }

  const jumpToSession = (sessionId: string) => {
    useAgentStore.getState().selectSession(sessionId)
    useUiStore.getState().setActivePane('agents')
  }

  const refresh = async () => {
    setRefreshing(true)
    await refreshPosts(slug)
    setRefreshing(false)
  }

  const statusColor: Record<Status, string> = {
    active: 'text-green-400',
    dormant: 'text-yellow-400',
    complete: 'text-text-tertiary',
  }

  return (
    <div className="absolute inset-y-0 right-0 z-30 w-80 max-w-full border-l border-border bg-surface-1 shadow-lg flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-medium text-text-primary truncate">{title}</span>
          <span className="text-[10px] text-text-tertiary truncate">
            {slug}{isUntracked && ' · untracked'}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={refresh}
            className={`text-text-tertiary hover:text-text-primary transition-colors ${refreshing ? 'animate-spin' : ''}`}
            title="Refresh posts"
          >
            <RefreshCw size={12} />
          </button>
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text-primary transition-colors"
            title="Close panel"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Status dropdown */}
      <div className="px-3 py-2 border-b border-border relative">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-text-tertiary uppercase tracking-wide">Status</span>
          <button
            onClick={() => setStatusOpen((v) => !v)}
            className={`flex items-center gap-1 px-2 py-0.5 text-xs cursor-pointer bg-surface-0 border border-border rounded-sm hover:bg-surface-2 transition-colors duration-fast ${statusColor[project.status]}`}
          >
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${
              project.status === 'active' ? 'bg-green-400' :
              project.status === 'dormant' ? 'bg-yellow-400' : 'bg-text-tertiary'
            }`} />
            {project.status}
            <ChevronDown size={10} className={`transition-transform duration-fast ${statusOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>
        {statusOpen && (
          <div className="absolute top-full right-3 mt-1 bg-surface-0 border border-border rounded-sm shadow-lg z-10 min-w-32 overflow-hidden">
            {(['active', 'dormant', 'complete'] as const).map((s) => (
              <button
                key={s}
                onClick={() => void setStatus(s)}
                className={`flex items-center gap-1.5 w-full text-left px-3 py-1 text-xs cursor-pointer hover:bg-surface-2 transition-colors duration-fast ${
                  s === project.status ? 'bg-surface-2 text-text-primary' : statusColor[s]
                }`}
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                  s === 'active' ? 'bg-green-400' :
                  s === 'dormant' ? 'bg-yellow-400' : 'bg-text-tertiary'
                }`} />
                <span className="flex-1">{s}</span>
                {s === project.status && <span className="text-text-tertiary">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Posts list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {posts.length === 0 ? (
          <div className="px-3 py-4 text-xs text-text-tertiary">No posts yet — write one ↓</div>
        ) : (
          <ul className="divide-y divide-border">
            {posts.map((p) => (
              <li
                key={p.path}
                onClick={() => void openFile(p.path)}
                className="flex items-start gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-pointer"
                role="button"
              >
                <FileText size={11} className="text-text-tertiary mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-text-primary truncate">{p.title}</div>
                  <div className="text-[10px] text-text-tertiary truncate">
                    {p.date ? p.date.split(' ')[0] : '(no date)'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Agent sessions for this project */}
      <div className="border-t border-border">
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="text-[10px] text-text-tertiary uppercase tracking-wide">
            Agent sessions
          </span>
          <span className="text-[10px] text-text-tertiary">{projectSessions.length}</span>
        </div>
        {projectSessions.length > 0 && (
          <ul className="divide-y divide-border">
            {projectSessions.map((s) => (
              <li
                key={s.id}
                onClick={() => jumpToSession(s.id)}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-pointer"
                role="button"
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                  s.status === 'running' ? 'bg-green-400' :
                  s.status === 'idle' ? 'bg-text-tertiary' : 'bg-text-tertiary opacity-40'
                }`} />
                <span className="text-xs text-text-primary truncate flex-1 min-w-0">
                  {s.name || s.prompt || s.id}
                </span>
                {s.hasUnread && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer — actions */}
      <div className="border-t border-border px-3 py-2 flex flex-col gap-1.5">
        <button
          onClick={() => void startAgent()}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-1 text-xs bg-surface-2 text-text-primary rounded-sm hover:bg-surface-0 border border-border transition-colors"
          title={`Start an agent in projects/${slug}/`}
        >
          <Bot size={11} />
          Start agent in {project.title}
        </button>
        <button
          onClick={() => void newPost()}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-1 text-xs bg-surface-2 text-text-primary rounded-sm hover:bg-surface-0 border border-border transition-colors"
        >
          <Plus size={11} />
          New post about {project.title}
        </button>
      </div>
    </div>
  )
}
