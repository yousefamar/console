// con blog — drafts, projects, and publish for the personal blog at
// yousefamar.com/memo. Vault lives at ~/sync/brain/root and Eleventy reads
// posts from log/<timestamp>.md. Drafts go to scratch/blog-drafts/.
// Publishing moves the file into log/<timestamp>.md, stamps frontmatter,
// then hits https://yousefamar.com/rebuild to trigger an Eleventy build.

import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

interface DraftSummary { path: string; title: string; mtime: number }
interface ProjectSummary {
  slug: string
  title: string
  path: string
  status: 'active' | 'dormant' | 'complete'
  lastPostMtime: number | null
  lastPostPath: string | null
}
interface ProjectPost { path: string; title: string; date: string | null; mtime: number }
interface CreateDraftResult { ok: boolean; path?: string; alreadyExists?: boolean; error?: string }
interface CreateProjectResult { ok: boolean; path?: string; slug?: string; error?: string }
interface PublishResult {
  ok: boolean
  newPath?: string
  rebuildOk?: boolean
  rebuildBody?: string
  error?: string
}

export async function blog(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'drafts': return draftsCmd(args, flags)
    case 'draft': return draftCmd(args, flags)
    case 'publish': return publishCmd(args, flags)
    case 'republish': return republishCmd(args, flags)
    case 'projects': return projectsCmd(args, flags)
    case 'tags': return tagsCmd(flags)
    case 'posts': return postsCmd(args, flags)
    case 'status': return statusCmd(args, flags)
    default:
      exitWithError(
        'USAGE',
        `Unknown blog command: ${verb ?? ''}. Try: drafts, draft, publish, republish, projects, posts, tags, status.`,
        flags,
      )
  }
}

// --- drafts ----------------------------------------------------------------

async function draftsCmd(args: string[], flags: GlobalFlags): Promise<void> {
  // `con blog drafts` lists; `con blog drafts add ...` is also accepted as a friendlier alias for `draft`.
  if (args[0] === 'add' || args[0] === 'new') {
    await createDraft(args.slice(1), flags)
    return
  }
  const drafts = await hubFetch<DraftSummary[]>('/blog/drafts')
  output(drafts, flags)
}

async function draftCmd(args: string[], flags: GlobalFlags): Promise<void> {
  await createDraft(args, flags)
}

async function createDraft(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const positional = args.find((a) => !a.startsWith('--'))
  const title = positional ?? opts.title
  if (!title) {
    exitWithError('USAGE', "Usage: con blog draft \"<title>\" [--project <slug>]", flags)
    return
  }
  const body: { title: string; project?: string } = { title }
  if (opts.project) body.project = opts.project
  const r = await hubFetch<CreateDraftResult>('/blog/draft', {
    method: 'POST',
    body,
  })
  if (!r.ok) { exitWithError('SERVER', r.error ?? 'unknown error', flags); return }
  output(r, flags)
}

// --- publish ---------------------------------------------------------------

async function publishCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const path = args[0] ?? parseFlags(args).path
  if (!path) {
    exitWithError('USAGE', 'Usage: con blog publish <vault-relative-path>', flags)
    return
  }
  const r = await hubFetch<PublishResult>('/blog/publish', {
    method: 'POST',
    body: { path },
  })
  if (!r.ok) { exitWithError('SERVER', r.error ?? 'unknown error', flags); return }
  output(r, flags)
}

async function republishCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const path = args[0] ?? parseFlags(args).path
  if (!path) {
    exitWithError('USAGE', 'Usage: con blog republish <log/…​.md>', flags)
    return
  }
  const r = await hubFetch<PublishResult>('/blog/republish', {
    method: 'POST',
    body: { path },
  })
  if (!r.ok) { exitWithError('SERVER', r.error ?? 'unknown error', flags); return }
  output(r, flags)
}

// --- projects --------------------------------------------------------------

async function projectsCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  if (sub === 'add' || sub === 'new') {
    await createProject(args.slice(1), flags)
    return
  }
  if (sub === 'status' || sub === 'set-status') {
    await projectStatus(args.slice(1), flags)
    return
  }
  // list (default)
  const opts = parseFlags(args)
  let projects = await hubFetch<ProjectSummary[]>('/blog/projects')
  if (opts.status) {
    projects = projects.filter((p) => p.status === opts.status)
  }
  output(projects, flags)
}

async function createProject(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const positional = args.find((a) => !a.startsWith('--'))
  const title = positional ?? opts.title
  if (!title) {
    exitWithError('USAGE', 'Usage: con blog projects add "<title>" [--slug <slug>]', flags)
    return
  }
  const body: { title: string; slug?: string } = { title }
  if (opts.slug) body.slug = opts.slug
  const r = await hubFetch<CreateProjectResult>('/blog/project', {
    method: 'POST',
    body,
  })
  if (!r.ok) { exitWithError('SERVER', r.error ?? 'unknown error', flags); return }
  output(r, flags)
}

async function projectStatus(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const positionals = args.filter((a) => !a.startsWith('--'))
  const slug = positionals[0] ?? opts.slug
  const status = positionals[1] ?? opts.status
  if (!slug || !status) {
    exitWithError('USAGE', 'Usage: con blog projects status <slug> <active|dormant|complete>', flags)
    return
  }
  const r = await hubFetch<{ ok: boolean; status?: string | null; error?: string }>(
    `/blog/project/${encodeURIComponent(slug)}`,
    { method: 'PATCH', body: { status } },
  )
  output(r, flags)
}

// --- meta ------------------------------------------------------------------

async function postsCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const slug = args[0] ?? parseFlags(args).slug
  if (!slug) { exitWithError('USAGE', 'Usage: con blog posts <project-slug>', flags); return }
  const posts = await hubFetch<ProjectPost[]>(`/blog/project/${encodeURIComponent(String(slug))}/posts`)
  output(posts, flags)
}

async function tagsCmd(flags: GlobalFlags): Promise<void> {
  const tags = await hubFetch<string[]>('/blog/tags')
  output(tags, flags)
}

async function statusCmd(_args: string[], flags: GlobalFlags): Promise<void> {
  const [drafts, projects, tags] = await Promise.all([
    hubFetch<DraftSummary[]>('/blog/drafts'),
    hubFetch<ProjectSummary[]>('/blog/projects'),
    hubFetch<string[]>('/blog/tags'),
  ])
  output({
    drafts: drafts.length,
    projects: {
      total: projects.length,
      active: projects.filter((p) => p.status === 'active').length,
      dormant: projects.filter((p) => p.status === 'dormant').length,
      complete: projects.filter((p) => p.status === 'complete').length,
    },
    tags: tags.length,
  }, flags)
}
