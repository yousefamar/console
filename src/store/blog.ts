// Blog tooling: drafts, projects, tags, publish.
// Backed by /blog/* hub endpoints.

import { create } from 'zustand'
import { hubFetch } from '@/hub'
import { stalePostCandidates, projectForPostPath, buildClock, type SiteStatus } from '@/blog/stale'

/** Last-resort build clock, for when the blog server has no build on record
 *  (it forgets across restarts). The log index is regenerated whenever a post
 *  is added, so it tracks publishing far better than the memo landing page —
 *  which has not been written since 3 Oct 2026 (see `@/blog/stale`). */
const SITE_PROBE_URL = 'https://yousefamar.com/memo/log/'

export interface DraftSummary {
  path: string
  title: string
  mtime: number
  project: string | null
  tags: string[]
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
  /** Syncthing propagation outcome before the rebuild fired (server-side). */
  synced?: boolean
  syncTimedOut?: boolean
  syncWaitedMs?: number
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
  /** Optional area slug — seeds `tags: [<area>]` so the post belongs to the area from birth. */
  area?: string
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

export type LiveStatus = 'live' | 'stale' | 'building' | 'failed' | 'unknown'

/** A published post saved after the site's last build — its edits aren't live. */
export interface StalePost {
  path: string
  title: string
  project: string | null
  tags: string[]
  mtime: number
}

interface BlogState {
  drafts: DraftSummary[]
  projects: ProjectSummary[]
  tags: string[]
  /** Registered area/reserved tag slugs from the vault's `_data/areas.json`. Empty = registry unavailable (validation disabled). */
  validTags: string[]
  postsByProject: Record<string, ProjectPost[]>
  /** Published posts per area tag — ALL history, newest first. */
  postsByArea: Record<string, PublishedPost[]>
  areaPostsLoading: boolean
  draftsLoading: boolean
  projectsLoading: boolean
  recentPosts: PublishedPost[]
  recentPostsLoading: boolean
  refreshDrafts: () => Promise<void>
  refreshProjects: () => Promise<void>
  refreshTags: () => Promise<void>
  refreshProjectPosts: (slug: string) => Promise<void>
  refreshAreaPosts: (slug: string) => Promise<void>
  refreshRecentPosts: (limit?: number) => Promise<void>
  /** Format dictated text via the hub LLM endpoint. Returns formatted text or null on failure. */
  formatDictation: (text: string) => Promise<{ ok: boolean; text?: string; error?: string }>
  publish: (path: string) => Promise<PublishResult>
  /** Re-trigger the Eleventy build for an already-published log/ post. */
  republish: (path: string) => Promise<PublishResult>
  /** The blog server's build record (null if unreachable). */
  fetchSiteStatus: () => Promise<SiteStatus | null>
  /** Poll until the blog server reports a build newer than `baselineStartedAt`
   *  (capture it BEFORE triggering the rebuild). Gives up after ~3 minutes. */
  waitForBuild: (baselineStartedAt: string | null) => Promise<{ ok: boolean; error?: string }>
  /** Persistent live-state per published post path. 'live' = the last build
   *  read the file as you last saved it; 'stale' = local edits not yet on the
   *  site; 'building' = a queued build is being polled; 'failed' = the site's
   *  last build errored, so nothing new is live. */
  liveStatusByPath: Record<string, LiveStatus>
  setLiveStatus: (path: string, status: LiveStatus) => void
  /** Start of the site's last successful build (ms). Files saved before it are
   *  live. null = no build on record and the site unreachable. */
  siteBuiltAt: number | null
  /** `[11ty]` problem lines when the site's last build FAILED — the site is
   *  frozen at the previous build until it is fixed. */
  siteBuildError: string | null
  /** Probe the site's build clock and recompute `stalePosts`. */
  refreshSiteBuiltAt: () => Promise<void>
  /** Published posts whose vault file is newer than `siteBuiltAt` — the
   *  sidebar twin of drafts ("saved, not live"). */
  stalePosts: StalePost[]
  /** Re-derive `stalePosts` from the notes store's file list (cheap; frontmatter
   *  is fetched only for new stale paths). */
  recomputeStalePosts: () => Promise<void>
  /** Compare the site's build clock against the local file's mtime; updates
   *  liveStatusByPath. */
  checkLiveStatus: (path: string) => Promise<void>
  setProjectStatus: (slug: string, status: 'active' | 'dormant' | 'complete' | null) => Promise<{ ok: boolean; error?: string }>
  /**
   * Create a new draft in `log/drafts/` (or `projects/<slug>/log/drafts/`), write starter frontmatter
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

export const useBlogStore = create<BlogState>((set, get) => ({
  drafts: [],
  projects: [],
  tags: [],
  validTags: [],
  postsByProject: {},
  postsByArea: {},
  areaPostsLoading: false,
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
    try {
      const registry = await hubFetch<{ areas: Array<{ slug: string }>; reserved: string[] }>('/blog/areas', { timeoutMs: 8000 })
      set({ validTags: [...registry.areas.map((a) => a.slug), ...registry.reserved] })
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

  refreshAreaPosts: async (slug: string) => {
    set({ areaPostsLoading: true })
    try {
      const posts = await hubFetch<PublishedPost[]>(`/blog/area/${encodeURIComponent(slug)}/posts`, { timeoutMs: 12000 })
      set((s) => ({ postsByArea: { ...s.postsByArea, [slug]: posts }, areaPostsLoading: false }))
    } catch {
      set({ areaPostsLoading: false })
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
      // Server waits for Syncthing to propagate to the VPS (≤60s) before the
      // rebuild (≤15s), so allow generous headroom over that worst case.
      const result = await hubFetch<PublishResult>('/blog/publish', {
        method: 'POST',
        body: JSON.stringify({ path }),
        timeoutMs: 90000,
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
        timeoutMs: 90000,
      })
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },

  liveStatusByPath: {},

  setLiveStatus: (path, status) => {
    set((s) => ({ liveStatusByPath: { ...s.liveStatusByPath, [path]: status } }))
  },

  siteBuiltAt: null,
  siteBuildError: null,
  stalePosts: [],

  fetchSiteStatus: async () => {
    try {
      return await hubFetch<SiteStatus>('/blog/site-status', { timeoutMs: 12000 })
    } catch {
      return null
    }
  },

  refreshSiteBuiltAt: async () => {
    const clock = buildClock(await useBlogStore.getState().fetchSiteStatus(), get().siteBuiltAt)
    if (clock.builtAt !== null || clock.error) {
      set({ siteBuiltAt: clock.builtAt, siteBuildError: clock.error })
    } else {
      // No build on record (blog server restarted) and nothing cached — fall
      // back to a page's Last-Modified as a lower bound.
      try {
        const r = await hubFetch<{ lastModified: string | null }>(`/blog/page-etag?url=${encodeURIComponent(SITE_PROBE_URL)}`, { timeoutMs: 12000 })
        const ms = r.lastModified ? Date.parse(r.lastModified) : NaN
        set({ siteBuiltAt: Number.isNaN(ms) ? null : ms, siteBuildError: null })
      } catch {
        set({ siteBuiltAt: null, siteBuildError: null })
      }
    }
    await useBlogStore.getState().recomputeStalePosts()
  },

  recomputeStalePosts: async () => {
    const { useNotesStore } = await import('./notes')
    const files = useNotesStore.getState().files
    const candidates = stalePostCandidates(files, get().siteBuiltAt)
    const prev = new Map(get().stalePosts.map((p) => [p.path, p]))
    const next: StalePost[] = []
    for (const c of candidates) {
      const cached = prev.get(c.path)
      if (cached && cached.mtime === c.mtime) { next.push(cached); continue }
      try {
        const { parseFrontmatter } = await import('@/utils/frontmatter')
        const r = await hubFetch<{ content: string }>(`/notes/file/${encodeURIComponent(c.path)}`, { timeoutMs: 8000 })
        const { fm } = parseFrontmatter(r.content)
        next.push({
          path: c.path,
          title: fm.title?.trim() || c.path.split('/').pop()!.replace(/\.md$/, ''),
          project: projectForPostPath(c.path) ?? fm.project ?? null,
          tags: fm.tags ?? [],
          mtime: c.mtime,
        })
      } catch {
        next.push({ path: c.path, title: c.path.split('/').pop()!.replace(/\.md$/, ''), project: projectForPostPath(c.path), tags: [], mtime: c.mtime })
      }
    }
    // Skip the set() when nothing changed — this runs on every file-list tick.
    const cur = get().stalePosts
    if (cur.length === next.length && cur.every((p, i) => p.path === next[i]!.path && p.mtime === next[i]!.mtime)) return
    set({ stalePosts: next })
  },

  checkLiveStatus: async (path: string) => {
    const { useNotesStore } = await import('./notes')
    const fileMtime = useNotesStore.getState().files.find((f) => f.path === path)?.mtime ?? 0
    await useBlogStore.getState().refreshSiteBuiltAt()
    const { siteBuiltAt, siteBuildError } = get()
    // The build read the vault at `siteBuiltAt`, so anything saved before it
    // is live. Small clock skew between this machine and the VPS can blur the
    // boundary; a save always flips to 'stale' locally regardless.
    const status: LiveStatus =
      siteBuildError ? 'failed' :
      siteBuiltAt === null ? 'unknown' :
      siteBuiltAt >= fileMtime ? 'live' : 'stale'
    useBlogStore.getState().setLiveStatus(path, status)
  },

  waitForBuild: async (baselineStartedAt: string | null): Promise<{ ok: boolean; error?: string }> => {
    // The blog's /rebuild endpoint only QUEUES a build (3s debounce +
    // Syncthing propagation + Eleventy run), so "queued: true" says nothing
    // about the post being live. Wait for the build RECORD to move off the
    // pre-publish baseline: a page's ETag can never move (Eleventy writes
    // byte-identical output, or the template is not in the build at all) and
    // the record also carries the failure reason.
    const INTERVAL_MS = 5000
    const MAX_TRIES = 36 // ~3 minutes
    for (let i = 0; i < MAX_TRIES; i++) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS))
      const status = await useBlogStore.getState().fetchSiteStatus()
      const last = status?.lastBuild
      if (!last || last.startedAt === baselineStartedAt) continue
      void useBlogStore.getState().refreshSiteBuiltAt()
      if (last.ok === false) return { ok: false, error: last.error?.trim() || 'the build failed' }
      return { ok: true }
    }
    return { ok: false }
  },

  createDraft: async ({ title, project, area }): Promise<CreateDraftResult> => {
    const trimmed = title.trim()
    if (!trimmed) return { ok: false, error: 'Title is required' }

    // Delegate to the hub — single implementation for frontmatter seeding
    // (incl. inheriting tags from the project's most recent post). The hub
    // writes straight to the vault dir on disk, which both adapters see.
    let result: CreateDraftResult
    try {
      result = await hubFetch<CreateDraftResult>('/blog/draft', {
        method: 'POST',
        body: JSON.stringify({ title: trimmed, project, area }),
        timeoutMs: 12000,
      })
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    if (!result.ok || !result.path) return result

    // Lazy import to avoid circular dependencies between stores.
    const { useNotesStore } = await import('./notes')
    const { useUiStore } = await import('./ui')
    // Spaces has its own Docs editor — a draft created there opens in place;
    // everywhere else jumps to the Notes pane as before.
    if (useUiStore.getState().activePane !== 'spaces') useUiStore.getState().setActivePane('notes')
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
        // Spaces has its own Docs editor — a project created there opens in
        // place; everywhere else jumps to the Notes pane as before.
        if (useUiStore.getState().activePane !== 'spaces') useUiStore.getState().setActivePane('notes')
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

