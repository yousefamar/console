// Blog tooling backed by the Eleventy/Obsidian vault at ~/sync/brain/root.
//
// Three concerns:
// - List drafts in scratch/blog-drafts/
// - List active projects + the most recent log entry per project
// - Publish a draft: move to log/<YYYY-MM-DD-HH-mm-ss>.md, stamp frontmatter,
//   then GET https://yousefamar.com/rebuild

import { NoteStore } from './notes.js'

const DRAFTS_DIR = 'scratch/blog-drafts'
const LOG_DIR = 'log'
const PROJECTS_DIR = 'projects'
const REBUILD_URL = 'https://yousefamar.com/rebuild'

// ---------------------------------------------------------------------------
// Frontmatter parsing — small purpose-built parser.
// Handles the keys we care about (title, date, post, public, project, status,
// tags) in the YAML block form Yousef actually uses in this vault.
// ---------------------------------------------------------------------------

export interface Frontmatter {
  title?: string
  date?: string
  post?: boolean
  public?: boolean
  listed?: boolean
  log?: boolean
  project?: string
  status?: string
  tags?: string[]
}

export function parseFrontmatter(content: string): { fm: Frontmatter; body: string; raw: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { fm: {}, body: content, raw: '' }
  const raw = m[1]!
  const body = m[2] ?? ''
  const fm: Frontmatter = {}
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (!kv) continue
    const [, key, valRaw] = kv
    const val = valRaw!.trim()
    if (key === 'tags') {
      // Three forms in the wild:
      //   tags: foo            (scalar — single tag or comma/space-separated list)
      //   tags: [foo, bar]     (inline array)
      //   tags:\n  - foo\n     (block list)
      if (val.startsWith('[') && val.endsWith(']')) {
        fm.tags = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      } else if (val === '' || val === '[]') {
        const tags: string[] = []
        for (let j = i + 1; j < lines.length; j++) {
          const item = lines[j]!.match(/^\s*-\s+(.+?)\s*$/)
          if (!item) break
          tags.push(item[1]!.replace(/^["']|["']$/g, ''))
        }
        if (tags.length) fm.tags = tags
      } else {
        // Scalar — tolerate comma- or whitespace-separated lists too
        const parts = (val.includes(',') ? val.split(',') : val.split(/\s+/))
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean)
        if (parts.length) fm.tags = parts
      }
      continue
    }
    if (val === '') continue
    if (val === 'true') (fm as any)[key!] = true
    else if (val === 'false') (fm as any)[key!] = false
    else (fm as any)[key!] = val.replace(/^["']|["']$/g, '')
  }
  return { fm, body, raw }
}

/** Stamp keys into frontmatter, replacing existing lines or appending. Returns full file content. */
export function stampFrontmatter(content: string, updates: Record<string, string | boolean>): string {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  let raw = m ? m[1]! : ''
  const body = m ? (m[2] ?? '') : content
  const lines = raw.length ? raw.split('\n') : []

  for (const [k, v] of Object.entries(updates)) {
    const newLine = `${k}: ${v}`
    const idx = lines.findIndex((l) => l.match(new RegExp(`^${k}:`)))
    if (idx >= 0) {
      lines[idx] = newLine
    } else {
      lines.push(newLine)
    }
  }
  raw = lines.join('\n')
  return `---\n${raw}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface DraftSummary {
  path: string
  title: string
  mtime: number
}

export interface CreateDraftResult {
  ok: boolean
  path?: string
  alreadyExists?: boolean
  error?: string
}

export async function createDraft(
  store: NoteStore,
  { title, project }: { title: string; project?: string },
): Promise<CreateDraftResult> {
  const cleanTitle = title.trim()
  if (!cleanTitle) return { ok: false, error: 'Title required' }
  const titleSlug = slugifyTitle(cleanTitle)
  const filenameSlug = project ? `${slugifyTitle(project)}-${titleSlug}` : titleSlug
  const path = `${DRAFTS_DIR}/${filenameSlug}.md`

  const all = await store.list()
  if (all.some((f) => f.path === path)) {
    return { ok: true, path, alreadyExists: true }
  }

  // No `date:` here — date is the date of PUBLISHING, stamped by publishDraft.
  // A draft-time date would be misleading and could leak stale if the draft is
  // ever published by a path that doesn't re-stamp (e.g. manual move).
  const fm: string[] = [
    `title: ${cleanTitle}`,
    'public: false',
    'post: true',
  ]
  if (project) {
    fm.push(`project: ${project}`)
    // Seed tags from the project's most recent post — the best predictor of
    // how this project gets tagged (e.g. garden posts carry [projects, life]).
    // `projects` is always included: it feeds Eleventy's collections.projects,
    // without which the post never appears in the project's devlog.
    let tags = ['projects']
    try {
      const prev = await listProjectPosts(store, project)
      const latest = prev[0]
      if (latest?.tags.length) {
        tags = [...new Set(['projects', ...latest.tags])]
      }
    } catch {}
    fm.push('tags:', ...tags.map((t) => `  - ${t}`))
  } else {
    fm.push('tags: ')
  }
  const content = `---\n${fm.join('\n')}\n---\n\n`

  try {
    await store.write(path, content)
    return { ok: true, path }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function listDrafts(store: NoteStore): Promise<DraftSummary[]> {
  const all = await store.list()
  const drafts = all.filter((f) => f.dir === DRAFTS_DIR)
  const summaries: DraftSummary[] = []
  for (const f of drafts) {
    let title = f.name.replace(/\.md$/, '')
    try {
      const content = await store.read(f.path)
      const { fm, body } = parseFrontmatter(content)
      if (fm.title) title = fm.title
      else {
        const h1 = body.match(/^#\s+(.+)$/m)
        if (h1) title = h1[1]!.trim()
      }
    } catch {}
    summaries.push({ path: f.path, title, mtime: f.mtime })
  }
  summaries.sort((a, b) => b.mtime - a.mtime)
  return summaries
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  slug: string
  title: string
  path: string
  status: 'active' | 'dormant' | 'complete'
  lastPostMtime: number | null
  lastPostPath: string | null
}

export async function listProjects(store: NoteStore): Promise<ProjectSummary[]> {
  const all = await store.list()

  // Find project files: projects/<slug>/index.md OR projects/<slug>.md.
  // Skip Syncthing conflict copies.
  const projectFiles = all.filter((f) => {
    if (!f.path.startsWith(`${PROJECTS_DIR}/`)) return false
    if (f.name.includes('sync-conflict')) return false
    const rest = f.path.slice(PROJECTS_DIR.length + 1)
    if (rest.includes('/')) {
      // projects/<slug>/index.md
      return rest.endsWith('/index.md')
    }
    // projects/<slug>.md
    return rest.endsWith('.md')
  })

  // Compute last-post-per-project from log/*.md
  const logFiles = all.filter((f) => f.dir === LOG_DIR)
  const lastBySlug = new Map<string, { mtime: number; path: string }>()
  for (const f of logFiles) {
    try {
      const content = await store.read(f.path)
      const { fm } = parseFrontmatter(content)
      if (!fm.project) continue
      const cur = lastBySlug.get(fm.project)
      if (!cur || f.mtime > cur.mtime) {
        lastBySlug.set(fm.project, { mtime: f.mtime, path: f.path })
      }
    } catch {}
  }

  const out: ProjectSummary[] = []
  for (const f of projectFiles) {
    const rest = f.path.slice(PROJECTS_DIR.length + 1)
    const slug = rest.endsWith('/index.md') ? rest.slice(0, -'/index.md'.length) : rest.slice(0, -'.md'.length)
    let title = slug
    let status: ProjectSummary['status'] = 'active'
    let isTracked = false
    try {
      const content = await store.read(f.path)
      const { fm } = parseFrontmatter(content)
      if (fm.title) title = fm.title
      if (fm.status === 'dormant' || fm.status === 'complete') status = fm.status
      isTracked = fm.log === true
    } catch {}
    // Only include projects explicitly tracked (`log: true` in frontmatter).
    // Flat project notes without that flag are reference pages, not nag-worthy
    // active projects.
    if (!isTracked) continue
    const last = lastBySlug.get(slug)
    out.push({
      slug,
      title,
      path: f.path,
      status,
      lastPostMtime: last?.mtime ?? null,
      lastPostPath: last?.path ?? null,
    })
  }
  // Active first, sorted by oldest-touched-first (most nag-worthy first)
  out.sort((a, b) => {
    if (a.status !== b.status) {
      const order = { active: 0, dormant: 1, complete: 2 } as const
      return order[a.status] - order[b.status]
    }
    return (a.lastPostMtime ?? 0) - (b.lastPostMtime ?? 0)
  })
  return out
}

// ---------------------------------------------------------------------------
// Per-project posts (chronological feed for the project panel)
// ---------------------------------------------------------------------------

export interface ProjectPost {
  path: string
  title: string
  date: string | null
  mtime: number
  tags: string[]
}

export async function listProjectPosts(store: NoteStore, slug: string): Promise<ProjectPost[]> {
  const all = await store.list()
  const logFiles = all.filter((f) => f.dir === LOG_DIR)
  const out: ProjectPost[] = []
  for (const f of logFiles) {
    try {
      const content = await store.read(f.path)
      const { fm, body } = parseFrontmatter(content)
      if (fm.project !== slug) continue
      let title = fm.title ?? f.name.replace(/\.md$/, '')
      if (!fm.title) {
        const h1 = body.match(/^#\s+(.+)$/m)
        if (h1) title = h1[1]!.trim()
      }
      out.push({ path: f.path, title, date: fm.date ?? null, mtime: f.mtime, tags: fm.tags ?? [] })
    } catch {}
  }
  // Newest first — date frontmatter is the canonical order, fall back to mtime
  out.sort((a, b) => {
    const ad = a.date ? Date.parse(a.date.replace(' ', 'T')) : a.mtime
    const bd = b.date ? Date.parse(b.date.replace(' ', 'T')) : b.mtime
    return bd - ad
  })
  return out
}

// ---------------------------------------------------------------------------
// Recent published posts (across all projects)
// ---------------------------------------------------------------------------

export interface PublishedPost {
  path: string
  title: string
  date: string | null
  mtime: number
  project: string | null
  tags: string[]
}

export async function listRecentPosts(store: NoteStore, limit = 20): Promise<PublishedPost[]> {
  const capped = Math.min(Math.max(1, limit), 100)
  const all = await store.list()
  const logFiles = all.filter((f) => f.dir === LOG_DIR)
  const out: PublishedPost[] = []
  for (const f of logFiles) {
    try {
      const content = await store.read(f.path)
      const { fm, body } = parseFrontmatter(content)
      let title = fm.title ?? f.name.replace(/\.md$/, '')
      if (!fm.title) {
        const h1 = body.match(/^#\s+(.+)$/m)
        if (h1) title = h1[1]!.trim()
      }
      out.push({
        path: f.path,
        title,
        date: fm.date ?? null,
        mtime: f.mtime,
        project: fm.project ?? null,
        tags: fm.tags ?? [],
      })
    } catch {}
  }
  out.sort((a, b) => {
    const ad = a.date ? Date.parse(a.date.replace(' ', 'T')) : a.mtime
    const bd = b.date ? Date.parse(b.date.replace(' ', 'T')) : b.mtime
    return bd - ad
  })
  return out.slice(0, capped)
}

// ---------------------------------------------------------------------------
// Dictation formatting — LLM cleanup that must not alter wording.
// Runs through the `claude` CLI (one-shot -p) so it rides the existing
// Claude subscription — no ANTHROPIC_API_KEY needed. Model = CLI default
// (the best available; currently Fable 5).
// ---------------------------------------------------------------------------

export async function formatDictation(text: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!text.trim()) return { ok: false, error: 'Empty text' }

  const prompt = `The following text was dictated by voice and transcribed. Format it for publication:
- Add punctuation and capitalisation.
- Break it into paragraphs where natural.
- Fix obvious transcription artefacts (duplicated words, filler like "um"/"uh", spoken punctuation like "comma" or "new paragraph" become actual punctuation/breaks).
- Use Markdown formatting where the speaker clearly implied structure (e.g. lists).
- DO NOT change the wording, vocabulary, tone, or content. Do not paraphrase. Do not add or remove ideas.

Respond with ONLY the formatted text, no preamble.

<dictation>
${text}
</dictation>`

  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    const child = execFile(
      'claude',
      ['-p', prompt, '--output-format', 'text'],
      { timeout: 90_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env } },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: `claude CLI failed: ${stderr?.slice(0, 200) || err.message}` })
          return
        }
        const formatted = stdout.trim()
        if (!formatted) {
          resolve({ ok: false, error: 'Empty response from model' })
          return
        }
        resolve({ ok: true, text: formatted })
      },
    )
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
  })
}

// ---------------------------------------------------------------------------
// Project status update
// ---------------------------------------------------------------------------

function projectFilePath(slug: string, all: { path: string; name: string; dir: string }[]): string | null {
  // Prefer projects/<slug>/index.md, fall back to flat projects/<slug>.md
  const indexed = all.find((f) => f.path === `${PROJECTS_DIR}/${slug}/index.md`)
  if (indexed) return indexed.path
  const flat = all.find((f) => f.path === `${PROJECTS_DIR}/${slug}.md`)
  if (flat) return flat.path
  return null
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'untitled'
}

export interface CreateProjectResult {
  ok: boolean
  path?: string
  slug?: string
  error?: string
}

export async function createProject(
  store: NoteStore,
  { title, slug }: { title: string; slug?: string },
): Promise<CreateProjectResult> {
  const cleanTitle = title.trim()
  if (!cleanTitle) return { ok: false, error: 'Title required' }
  const finalSlug = (slug ?? slugifyTitle(cleanTitle)).trim()
  if (!finalSlug) return { ok: false, error: 'Slug required' }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(finalSlug)) {
    return { ok: false, error: 'Slug must be lowercase letters, digits, and hyphens' }
  }

  // Check for collisions against any existing project file/dir
  const all = await store.list()
  const flatPath = `${PROJECTS_DIR}/${finalSlug}.md`
  const indexPath = `${PROJECTS_DIR}/${finalSlug}/index.md`
  if (all.some((f) => f.path === flatPath || f.path === indexPath)) {
    return { ok: false, error: `Project '${finalSlug}' already exists` }
  }

  // New projects are directory-based: projects/<slug>/index.md.
  // This matches the migrated convention so each project can host attachments,
  // sub-notes, etc. alongside its index without a separate top-level file.
  const body = `---\ntitle: ${cleanTitle}\nlog: true\nstatus: active\n---\n\n# ${cleanTitle}\n\n`
  try {
    await store.write(indexPath, body)
    return { ok: true, path: indexPath, slug: finalSlug }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function setProjectStatus(
  store: NoteStore,
  slug: string,
  status: 'active' | 'dormant' | 'complete' | null,
): Promise<{ ok: boolean; status?: string | null; error?: string }> {
  const all = await store.list()
  const path = projectFilePath(slug, all)
  if (!path) return { ok: false, error: `Project ${slug} not found` }
  let content: string
  try { content = await store.read(path) } catch (e) { return { ok: false, error: (e as Error).message } }

  let updated: string
  if (status === null) {
    // Strip the line entirely
    updated = content.replace(/^status:\s*[^\n]*\n/m, '')
  } else {
    updated = stampFrontmatter(content, { status })
  }
  try {
    await store.write(path, updated)
    return { ok: true, status }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Tags — for autocomplete
// ---------------------------------------------------------------------------

export async function listAllTags(store: NoteStore): Promise<string[]> {
  const all = await store.list()
  const logFiles = all.filter((f) => f.dir === LOG_DIR)
  const counts = new Map<string, number>()
  for (const f of logFiles) {
    try {
      const content = await store.read(f.path)
      const { fm } = parseFrontmatter(content)
      if (!fm.tags) continue
      for (const t of fm.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    } catch {}
  }
  // Most-used first
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
}

// ---------------------------------------------------------------------------
// Publish — move draft into log/, stamp frontmatter, rebuild
// ---------------------------------------------------------------------------

function nowTimestamp(): string {
  // YYYY-MM-DD-HH-mm-ss in local time, matching Yousef's existing convention
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

function nowFrontmatterDate(): string {
  // YYYY-MM-DD HH:mm:ss matching Templater post.md output
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export interface PublishResult {
  ok: boolean
  newPath?: string
  rebuildOk?: boolean
  rebuildBody?: string
  error?: string
}

export async function publishDraft(store: NoteStore, fromPath: string): Promise<PublishResult> {
  if (!fromPath.startsWith(`${DRAFTS_DIR}/`)) {
    return { ok: false, error: `Path is not in ${DRAFTS_DIR}/` }
  }
  let content: string
  try {
    content = await store.read(fromPath)
  } catch (e) {
    return { ok: false, error: `Could not read ${fromPath}: ${(e as Error).message}` }
  }
  const { fm } = parseFrontmatter(content)
  if (!fm.title || !fm.title.trim()) {
    return { ok: false, error: 'Draft is missing a title in frontmatter' }
  }

  const stamped = stampFrontmatter(content, {
    date: nowFrontmatterDate(),
    public: true,
    post: true,
  })
  const newPath = `${LOG_DIR}/${nowTimestamp()}.md`

  try {
    await store.write(newPath, stamped)
    await store.delete(fromPath)
  } catch (e) {
    return { ok: false, error: `File move failed: ${(e as Error).message}` }
  }

  const { rebuildOk, rebuildBody } = await triggerRebuild()
  return { ok: true, newPath, rebuildOk, rebuildBody }
}

/** GET the Eleventy rebuild endpoint. Never throws — surfaces status so a
 *  publish/re-publish doesn't fail just because syncthing hasn't caught up. */
async function triggerRebuild(): Promise<{ rebuildOk: boolean; rebuildBody?: string }> {
  let rebuildOk = false
  let rebuildBody: string | undefined
  try {
    const res = await fetch(REBUILD_URL, { signal: AbortSignal.timeout(15000) })
    rebuildBody = await res.text()
    if (res.ok) {
      try {
        rebuildOk = (JSON.parse(rebuildBody) as { success?: boolean }).success === true
      } catch { rebuildOk = false }
    }
  } catch (e) {
    rebuildBody = `rebuild fetch failed: ${(e as Error).message}`
  }
  return { rebuildOk, rebuildBody }
}

/**
 * Re-publish an already-published post (`log/<name>.md`): persist happens
 * client-side via the normal save; this just re-triggers the Eleventy build
 * so edits go live. Does NOT move the file or change its date (publish date
 * is immutable). `newPath` echoes the unchanged path for a uniform result.
 */
export async function republishPost(store: NoteStore, path: string): Promise<PublishResult> {
  if (!/^log\/[^/]+\.md$/.test(path)) {
    return { ok: false, error: `Not a published post: ${path}` }
  }
  try {
    await store.read(path) // confirm it exists
  } catch (e) {
    return { ok: false, error: `Could not read ${path}: ${(e as Error).message}` }
  }
  const { rebuildOk, rebuildBody } = await triggerRebuild()
  return { ok: true, newPath: path, rebuildOk, rebuildBody }
}
