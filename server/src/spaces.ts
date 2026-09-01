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
import { isKanbanBoard, parseBoard, boardDefaultOwner } from './kanban/board.js'
import { REVIEW_COLUMN_RE } from './kanban/dispatch.js'

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
  /** Cards sitting in an Under-Review-like column on the board (0 = none /
   *  no board). Rail shows it on the kanban glyph — the review queue count. */
  reviewCount: number
  /** agentKeys of the review cards' assignees — lets the client move a
   *  session's "unread" from the Bot badge to the kanban badge when the
   *  unread is really a review hand-back the agent owns. */
  reviewAgentKeys: string[]
  /** agentKeys assigned to ANY card on the board (all columns, dedup'd).
   *  A fork whose key owns a card is reachable via the card, so the rail
   *  suppresses its badge/alert rows (^lean-ibis) — attention excepted. */
  cardAgentKeys: string[]
  /** Board frontmatter `default_owner:` — the agent unassigned cards auto-
   *  assign to (null = none set; the "-general" convention applies). */
  defaultOwner: string | null
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
    let boardContent: string | null = null
    if (boardPath) {
      try { boardContent = await store.read(boardPath) } catch { /* unreadable */ }
    } else {
      for (const f of files) {
        if (!f.path.endsWith('.md') || f.path === notePath) continue
        try {
          const content = await store.read(f.path)
          if (isKanbanBoard(content)) { boardPath = f.path; boardContent = content; break }
        } catch { /* skip */ }
      }
    }
    let reviewCount = 0
    const reviewAgentKeys: string[] = []
    const cardAgentKeys = new Set<string>()
    let defaultOwner: string | null = null
    if (boardContent) {
      defaultOwner = boardDefaultOwner(boardContent)
      try {
        for (const col of parseBoard(boardContent).columns) {
          const isReview = REVIEW_COLUMN_RE.test(col.title)
          for (const card of col.cards) {
            if (card.agentKey) cardAgentKeys.add(card.agentKey)
            if (!isReview) continue
            reviewCount++
            if (card.agentKey) reviewAgentKeys.push(card.agentKey)
          }
        }
      } catch { /* unparseable board — counts stay 0 */ }
    }
    out.push({ kind: 'project', slug, title, notePath, boardPath, status, fileCount: flat ? 1 : files.length, reviewCount, reviewAgentKeys, cardAgentKeys: [...cardAgentKeys], defaultOwner })
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
      reviewCount: 0,
      reviewAgentKeys: [],
      cardAgentKeys: [],
      defaultOwner: null,
    })
  }

  return out.sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === 'area' ? -1 : 1))
}
