import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NoteStore } from '../notes.js'
import { listDrafts, listProjects, listProjectPosts, listAllTags, publishDraft, setProjectStatus, createProject, createDraft } from '../blog.js'

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function handleBlogRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  noteStore: NoteStore,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (path === '/blog/drafts' && req.method === 'GET') {
    listDrafts(noteStore)
      .then((drafts) => json(res, 200, drafts))
      .catch((err) => json(res, 500, { error: (err as Error).message }))
    return true
  }

  if (path === '/blog/projects' && req.method === 'GET') {
    listProjects(noteStore)
      .then((projects) => json(res, 200, projects))
      .catch((err) => json(res, 500, { error: (err as Error).message }))
    return true
  }

  if (path === '/blog/tags' && req.method === 'GET') {
    listAllTags(noteStore)
      .then((tags) => json(res, 200, tags))
      .catch((err) => json(res, 500, { error: (err as Error).message }))
    return true
  }

  // /blog/project/:slug/posts → chronological list of posts tagged with this project
  const postsMatch = path.match(/^\/blog\/project\/([^/]+)\/posts$/)
  if (postsMatch && req.method === 'GET') {
    const slug = decodeURIComponent(postsMatch[1]!)
    listProjectPosts(noteStore, slug)
      .then((posts) => json(res, 200, posts))
      .catch((err) => json(res, 500, { error: (err as Error).message }))
    return true
  }

  // PATCH /blog/project/:slug → update status
  const projectMatch = path.match(/^\/blog\/project\/([^/]+)$/)
  if (projectMatch && req.method === 'PATCH') {
    const slug = decodeURIComponent(projectMatch[1]!)
    readBody(req).then(async (body) => {
      try {
        const { status } = JSON.parse(body) as { status?: 'active' | 'dormant' | 'complete' | null }
        if (status !== null && status !== 'active' && status !== 'dormant' && status !== 'complete') {
          return json(res, 400, { ok: false, error: 'status must be active|dormant|complete|null' })
        }
        const result = await setProjectStatus(noteStore, slug, status)
        json(res, result.ok ? 200 : 400, result)
      } catch (err) {
        json(res, 500, { ok: false, error: (err as Error).message })
      }
    }).catch((err) => json(res, 500, { ok: false, error: (err as Error).message }))
    return true
  }

  // POST /blog/project { title, slug? } → create a new project stub
  if (path === '/blog/project' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const { title, slug } = JSON.parse(body) as { title?: string; slug?: string }
        if (!title) return json(res, 400, { ok: false, error: 'Missing `title`' })
        const result = await createProject(noteStore, { title, slug })
        json(res, result.ok ? 200 : 400, result)
      } catch (err) {
        json(res, 500, { ok: false, error: (err as Error).message })
      }
    }).catch((err) => json(res, 500, { ok: false, error: (err as Error).message }))
    return true
  }

  // POST /blog/draft { title, project? } → create a new blog draft stub
  if (path === '/blog/draft' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const { title, project } = JSON.parse(body) as { title?: string; project?: string }
        if (!title) return json(res, 400, { ok: false, error: 'Missing `title`' })
        const result = await createDraft(noteStore, { title, project })
        json(res, result.ok ? 200 : 400, result)
      } catch (err) {
        json(res, 500, { ok: false, error: (err as Error).message })
      }
    }).catch((err) => json(res, 500, { ok: false, error: (err as Error).message }))
    return true
  }

  if (path === '/blog/publish' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const { path: fromPath } = JSON.parse(body) as { path?: string }
        if (!fromPath) return json(res, 400, { ok: false, error: 'Missing `path`' })
        const result = await publishDraft(noteStore, fromPath)
        json(res, result.ok ? 200 : 400, result)
      } catch (err) {
        json(res, 500, { ok: false, error: (err as Error).message })
      }
    }).catch((err) => json(res, 500, { ok: false, error: (err as Error).message }))
    return true
  }

  return false
}
