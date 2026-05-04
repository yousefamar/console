// Blog tooling: drafts, projects, tags, publish.
// Backed by /blog/* hub endpoints.

import { create } from 'zustand'
import { hubFetch } from '@/hub'

export interface DraftSummary {
  path: string
  title: string
  mtime: number
}

export interface ProjectSummary {
  slug: string
  title: string
  path: string
  status: 'active' | 'dormant' | 'complete'
  lastPostMtime: number | null
  lastPostPath: string | null
}

export interface PublishResult {
  ok: boolean
  newPath?: string
  rebuildOk?: boolean
  rebuildBody?: string
  error?: string
}

export interface ProjectPost {
  path: string
  title: string
  date: string | null
  mtime: number
}

export interface CreateDraftArgs {
  title: string
  /** Optional project slug — adds `project: <slug>` to frontmatter and prefixes filename to dodge cross-project collisions. */
  project?: string
}

export interface CreateDraftResult {
  ok: boolean
  /** Final vault-relative path of the created (or pre-existing) draft. */
  path?: string
  /** True when the file already existed and we just returned its path. */
  alreadyExists?: boolean
  error?: string
}

interface BlogState {
  drafts: DraftSummary[]
  projects: ProjectSummary[]
  tags: string[]
  postsByProject: Record<string, ProjectPost[]>
  draftsLoading: boolean
  projectsLoading: boolean
  refreshDrafts: () => Promise<void>
  refreshProjects: () => Promise<void>
  refreshTags: () => Promise<void>
  refreshProjectPosts: (slug: string) => Promise<void>
  publish: (path: string) => Promise<PublishResult>
  setProjectStatus: (slug: string, status: 'active' | 'dormant' | 'complete' | null) => Promise<{ ok: boolean; error?: string }>
  /**
   * Create a new draft in `scratch/blog-drafts/`, write starter frontmatter
   * (public: false — flipped to true on publish), and open it in the Notes
   * pane. If a draft with the same slug already exists, just opens it.
   */
  createDraft: (args: CreateDraftArgs) => Promise<CreateDraftResult>
}

const DRAFTS_DIR = 'scratch/blog-drafts'

export const useBlogStore = create<BlogState>((set) => ({
  drafts: [],
  projects: [],
  tags: [],
  postsByProject: {},
  draftsLoading: false,
  projectsLoading: false,

  refreshDrafts: async () => {
    set({ draftsLoading: true })
    try {
      const drafts = await hubFetch<DraftSummary[]>('/blog/drafts', { timeoutMs: 8000 })
      set({ drafts, draftsLoading: false })
    } catch {
      set({ draftsLoading: false })
    }
  },

  refreshProjects: async () => {
    set({ projectsLoading: true })
    try {
      const projects = await hubFetch<ProjectSummary[]>('/blog/projects', { timeoutMs: 12000 })
      set({ projects, projectsLoading: false })
    } catch {
      set({ projectsLoading: false })
    }
  },

  refreshTags: async () => {
    try {
      const tags = await hubFetch<string[]>('/blog/tags', { timeoutMs: 8000 })
      set({ tags })
    } catch {
      // keep last known
    }
  },

  refreshProjectPosts: async (slug: string) => {
    try {
      const posts = await hubFetch<ProjectPost[]>(`/blog/project/${encodeURIComponent(slug)}/posts`, { timeoutMs: 8000 })
      set((s) => ({ postsByProject: { ...s.postsByProject, [slug]: posts } }))
    } catch {
      // keep last known
    }
  },

  setProjectStatus: async (slug, status) => {
    try {
      const result = await hubFetch<{ ok: boolean; error?: string }>(`/blog/project/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
        timeoutMs: 8000,
      })
      if (result.ok) {
        // Optimistically update local projects list
        set((s) => ({
          projects: s.projects.map((p) => p.slug === slug
            ? { ...p, status: (status ?? 'active') }
            : p),
        }))
      }
      return result
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },

  publish: async (path: string): Promise<PublishResult> => {
    try {
      const result = await hubFetch<PublishResult>('/blog/publish', {
        method: 'POST',
        body: JSON.stringify({ path }),
        timeoutMs: 30000,
      })
      return result
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },

  createDraft: async ({ title, project }): Promise<CreateDraftResult> => {
    const trimmed = title.trim()
    if (!trimmed) return { ok: false, error: 'Title is required' }
    const titleSlug = slugify(trimmed)
    if (!titleSlug) return { ok: false, error: 'Title produced an empty slug' }
    const filenameSlug = project ? `${slugify(project)}-${titleSlug}` : titleSlug
    const path = `${DRAFTS_DIR}/${filenameSlug}.md`

    // Lazy import to avoid circular dependencies between stores.
    const { useNotesStore } = await import('./notes')
    const { useUiStore } = await import('./ui')

    // Use the in-store list as a quick "already exists?" check; falls back to
    // a stat via the adapter if the store is cold.
    const existing = useBlogStore.getState().drafts.find((d) => d.path === path)
    if (existing) {
      useUiStore.getState().setActivePane('notes')
      await useNotesStore.getState().openFile(path)
      return { ok: true, path, alreadyExists: true }
    }

    const fm: string[] = [
      `title: ${trimmed}`,
      'public: false',
      `date: ${nowFrontmatterDate()}`,
      'post: true',
    ]
    if (project) fm.push(`project: ${project}`)
    fm.push('tags: ')
    const content = `---\n${fm.join('\n')}\n---\n\n`

    useUiStore.getState().setActivePane('notes')
    try {
      await useNotesStore.getState().createFile(path, content)
      void useBlogStore.getState().refreshDrafts()
      return { ok: true, path }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}))

/** Extract the project slug from a vault path if it looks like a project page. */
export function projectSlugFromPath(path: string | null | undefined): string | null {
  if (!path) return null
  const m = path.match(/^projects\/([^/]+?)(?:\/index)?\.md$/)
  return m ? m[1]! : null
}

function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

function nowFrontmatterDate(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
