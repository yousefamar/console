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
  tags: string[]
}

export interface PublishedPost {
  path: string
  title: string
  date: string | null
  mtime: number
  project: string | null
  tags: string[]
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

export interface CreateProjectArgs {
  title: string
  /** Optional slug override; defaults to a slug derived from title. */
  slug?: string
}

export interface CreateProjectResult {
  ok: boolean
  path?: string
  slug?: string
  error?: string
}

interface BlogState {
  drafts: DraftSummary[]
  projects: ProjectSummary[]
  tags: string[]
  postsByProject: Record<string, ProjectPost[]>
  draftsLoading: boolean
  projectsLoading: boolean
  recentPosts: PublishedPost[]
  recentPostsLoading: boolean
  refreshDrafts: () => Promise<void>
  refreshProjects: () => Promise<void>
  refreshTags: () => Promise<void>
  refreshProjectPosts: (slug: string) => Promise<void>
  refreshRecentPosts: (limit?: number) => Promise<void>
  /** Format dictated text via the hub LLM endpoint. Returns formatted text or null on failure. */
  formatDictation: (text: string) => Promise<{ ok: boolean; text?: string; error?: string }>
  publish: (path: string) => Promise<PublishResult>
  /** Re-trigger the Eleventy build for an already-published log/ post. */
  republish: (path: string) => Promise<PublishResult>
  /** Current ETag/Last-Modified of a live page (null if unreachable). */
  fetchPageEtag: (url: string) => Promise<string | null>
  /** Poll a permalink until its ETag moves off the given baseline (build
   *  landed). Resolves false after ~3 minutes. */
  waitForSiteUpdate: (url: string, baselineEtag: string | null) => Promise<boolean>
  setProjectStatus: (slug: string, status: 'active' | 'dormant' | 'complete' | null) => Promise<{ ok: boolean; error?: string }>
  /**
   * Create a new draft in `scratch/blog-drafts/`, write starter frontmatter
   * (public: false — flipped to true on publish), and open it in the Notes
   * pane. If a draft with the same slug already exists, just opens it.
   */
  createDraft: (args: CreateDraftArgs) => Promise<CreateDraftResult>
  /**
   * Create a new project stub in `projects/<slug>.md` with `log: true` and
   * `status: active`, then open it in the Notes pane. Hub-backed so the CLI
   * and the SPA share one implementation.
   */
  createProject: (args: CreateProjectArgs) => Promise<CreateProjectResult>
}

export const useBlogStore = create<BlogState>((set) => ({
  drafts: [],
  projects: [],
  tags: [],
  postsByProject: {},
  draftsLoading: false,
  projectsLoading: false,
  recentPosts: [],
  recentPostsLoading: false,

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

  refreshRecentPosts: async (limit = 20) => {
    set({ recentPostsLoading: true })
    try {
      const recentPosts = await hubFetch<PublishedPost[]>(`/blog/posts?limit=${limit}`, { timeoutMs: 12000 })
      set({ recentPosts, recentPostsLoading: false })
    } catch {
      set({ recentPostsLoading: false })
    }
  },

  formatDictation: async (text) => {
    try {
      return await hubFetch<{ ok: boolean; text?: string; error?: string }>('/blog/format', {
        method: 'POST',
        body: JSON.stringify({ text }),
        timeoutMs: 95000,
      })
    } catch (e) {
      return { ok: false, error: (e as Error).message }
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

  republish: async (path: string): Promise<PublishResult> => {
    try {
      return await hubFetch<PublishResult>('/blog/republish', {
        method: 'POST',
        body: JSON.stringify({ path }),
        timeoutMs: 30000,
      })
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },

  fetchPageEtag: async (url: string): Promise<string | null> => {
    // Via the hub — the SPA can't HEAD yousefamar.com cross-origin (no CORS).
    try {
      const r = await hubFetch<{ etag: string | null }>(`/blog/page-etag?url=${encodeURIComponent(url)}`, { timeoutMs: 12000 })
      return r.etag
    } catch {
      return null
    }
  },

  waitForSiteUpdate: async (url: string, baselineEtag: string | null): Promise<boolean> => {
    // The blog's /rebuild endpoint only QUEUES a build (3s debounce +
    // Syncthing propagation + Eleventy run), so "queued: true" says nothing
    // about the page being live. Poll the permalink until its ETag /
    // Last-Modified moves off the pre-publish baseline — robust to clock
    // skew and to the site's 200-for-unbuilt-URLs catch-all.
    const INTERVAL_MS = 5000
    const MAX_TRIES = 36 // ~3 minutes
    for (let i = 0; i < MAX_TRIES; i++) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS))
      const etag = await useBlogStore.getState().fetchPageEtag(url)
      if (etag && etag !== baselineEtag) return true
    }
    return false
  },

  createDraft: async ({ title, project }): Promise<CreateDraftResult> => {
    const trimmed = title.trim()
    if (!trimmed) return { ok: false, error: 'Title is required' }

    // Delegate to the hub — single implementation for frontmatter seeding
    // (incl. inheriting tags from the project's most recent post). The hub
    // writes straight to the vault dir on disk, which both adapters see.
    let result: CreateDraftResult
    try {
      result = await hubFetch<CreateDraftResult>('/blog/draft', {
        method: 'POST',
        body: JSON.stringify({ title: trimmed, project }),
        timeoutMs: 12000,
      })
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    if (!result.ok || !result.path) return result

    // Lazy import to avoid circular dependencies between stores.
    const { useNotesStore } = await import('./notes')
    const { useUiStore } = await import('./ui')
    useUiStore.getState().setActivePane('notes')
    // New file → rescan so the tree/browser sees it before opening.
    if (!result.alreadyExists) await useNotesStore.getState().loadVaultFiles()
    await useNotesStore.getState().openFile(result.path)
    void useBlogStore.getState().refreshDrafts()
    return result
  },

  createProject: async ({ title, slug }): Promise<CreateProjectResult> => {
    try {
      const result = await hubFetch<CreateProjectResult>('/blog/project', {
        method: 'POST',
        body: JSON.stringify({ title, slug }),
      })
      if (result.ok && result.path) {
        const { useNotesStore } = await import('./notes')
        const { useUiStore } = await import('./ui')
        useUiStore.getState().setActivePane('notes')
        // Refresh notes file list so the new project shows in the tree
        await useNotesStore.getState().loadVaultFiles()
        await useNotesStore.getState().openFile(result.path)
        void useBlogStore.getState().refreshProjects()
      }
      return result
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },
}))

/** Extract the project slug from a vault path if it looks like a project page. */
export function projectSlugFromPath(path: string | null | undefined): string | null {
  if (!path) return null
  const m = path.match(/^projects\/([^/]+?)(?:\/index)?\.md$/)
  return m ? m[1]! : null
}

/**
 * Slug of the project ENCLOSING the given vault path. Returns a slug for any
 * file under `projects/<slug>/...`, not just the index page — so an agent
 * session can be started from any note within a project.
 */
export function enclosingProjectSlug(path: string | null | undefined): string | null {
  if (!path) return null
  if (!path.startsWith('projects/')) return null
  const rest = path.slice('projects/'.length)
  const slashIdx = rest.indexOf('/')
  if (slashIdx === -1) {
    // Top-level file like `projects/foo.md` (legacy) — strip extension
    return rest.replace(/\.md$/, '') || null
  }
  return rest.slice(0, slashIdx) || null
}

