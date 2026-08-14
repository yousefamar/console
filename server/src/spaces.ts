// Spaces — the project-first nav model. A space is either:
//   • a PROJECT: any folder under projects/ (derived from the filesystem,
//     no opt-in — "anything in the project folder is a project"), plus flat
//     projects/<slug>.md reference pages;
//   • an AREA: an entry in the vault's _data/areas.json registry (areas are
//     tags, not folders — they have writing + agents, never boards).
// Boards live ONLY in projects (projects/<slug>/board.md or any kanban file
// in the project folder).

import type { NoteStore } from './notes.js'
import { parseFrontmatter } from './blog.js'
import { loadAreaRegistry } from './areas.js'
import { isKanbanBoard } from './kanban/board.js'

const PROJECTS_DIR = 'projects'

export interface SpaceSummary {
  kind: 'project' | 'area'
  slug: string
  title: string
  /** projects: the index note (projects/<slug>/index.md or projects/<slug>.md), if any. */
  notePath: string | null
  /** projects: the kanban board file, if any. Areas never have one. */
  boardPath: string | null
  status: 'active' | 'dormant' | 'complete' | null
  /** File count under the project folder (0 for flat/areas). */
  fileCount: number
}

export async function listSpaces(store: NoteStore): Promise<SpaceSummary[]> {
  const all = await store.list()
  const out: SpaceSummary[] = []

  // Projects: every first-path-segment under projects/ (folder or flat .md).
  const bySlug = new Map<string, { files: typeof all; flat: boolean }>()
  for (const f of all) {
    if (!f.path.startsWith(`${PROJECTS_DIR}/`)) continue
    if (f.name.includes('sync-conflict')) continue
    const rest = f.path.slice(PROJECTS_DIR.length + 1)
    const slash = rest.indexOf('/')
    const slug = slash === -1 ? rest.replace(/\.md$/, '').replace(/\.svg$/, '') : rest.slice(0, slash)
    if (!slug) continue
    const cur = bySlug.get(slug) ?? { files: [], flat: slash === -1 }
    cur.files.push(f)
    if (slash !== -1) cur.flat = false
    bySlug.set(slug, cur)
  }

  for (const [slug, { files, flat }] of bySlug) {
    const notePath =
      files.find((f) => f.path === `${PROJECTS_DIR}/${slug}/index.md`)?.path ??
      files.find((f) => f.path === `${PROJECTS_DIR}/${slug}.md`)?.path ?? null
    let title = slug
    let status: SpaceSummary['status'] = null
    if (notePath) {
      try {
        const { fm } = parseFrontmatter(await store.read(notePath))
        if (fm.title) title = fm.title
        if (fm.status === 'active' || fm.status === 'dormant' || fm.status === 'complete') status = fm.status
      } catch { /* unreadable index — slug fallback */ }
    }
    // Board: prefer board.md / kanban.md by name; else first kanban-flagged file.
    let boardPath =
      files.find((f) => f.path === `${PROJECTS_DIR}/${slug}/board.md`)?.path ??
      files.find((f) => f.path === `${PROJECTS_DIR}/${slug}/kanban.md`)?.path ?? null
    if (!boardPath) {
      for (const f of files) {
        if (!f.path.endsWith('.md') || f.path === notePath) continue
        try {
          if (isKanbanBoard(await store.read(f.path))) { boardPath = f.path; break }
        } catch { /* skip */ }
      }
    }
    out.push({ kind: 'project', slug, title, notePath, boardPath, status, fileCount: flat ? 1 : files.length })
  }

  const registry = await loadAreaRegistry(store)
  for (const area of registry.areas) {
    out.push({
      kind: 'area',
      slug: area.slug,
      title: area.title,
      notePath: null,
      boardPath: null,
      status: null,
      fileCount: 0,
    })
  }

  return out.sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === 'area' ? -1 : 1))
}
