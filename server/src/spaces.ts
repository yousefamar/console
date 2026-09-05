// Spaces — the project-first nav model. A space is either:
//   • a PROJECT: any folder under projects/ (derived from the filesystem,
//     no opt-in — "anything in the project folder is a project"), plus flat
//     projects/<slug>.md reference pages;
//   • an AREA: an entry in the vault's _data/areas.json registry (areas are
//     tags, not folders — they have writing + agents, never boards).
// Boards live ONLY in projects (projects/<slug>/board.md or any kanban file
// in the project folder).

import { join } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import type { NoteStore } from './notes.js'
import { parseFrontmatter } from './blog.js'
import { loadAreaRegistry } from './areas.js'
import { isKanbanBoard, parseBoard, boardDefaultOwner } from './kanban/board.js'
import { DONE_COLUMN_RE, REVIEW_COLUMN_RE } from './kanban/dispatch.js'

const PROJECTS_DIR = 'projects'

/** Default cwd for a session bound to a space (Yousef's spec, ^spry-seal): a
 *  project session lives in its VAULT project dir — index.md / board.md /
 *  roadmap.md, code reachable via the `repo` symlink — a flat project
 *  (projects/<slug>.md, no folder) in projects/, an area session at the vault
 *  root. Null when the session has no binding (caller falls back to its own
 *  default). `--resume` is keyed by cwd and Session.cwd is readonly, so this
 *  only ever applies at create time; forks inherit their source's cwd. */
export function spaceCwd(vaultPath: string, binding: { project?: string | null; areas?: readonly string[] | null }): string | null {
  if (binding.project) {
    const dir = join(vaultPath, PROJECTS_DIR, binding.project)
    try { if (statSync(dir).isDirectory()) return dir } catch { /* flat project */ }
    return join(vaultPath, PROJECTS_DIR)
  }
  if (binding.areas?.length) return vaultPath
  return null
}

/** Resolved target of a project's `repo` symlink (the code checkout), or null. */
export function projectRepo(vaultPath: string, slug: string): string | null {
  try {
    const target = realpathSync(join(vaultPath, PROJECTS_DIR, slug, 'repo'))
    return statSync(target).isDirectory() ? target : null
  } catch { return null }
}

/** One card sitting in an Under-Review column — enough for a client to
 *  address it on the /board/:project API without loading the board. */
export interface ReviewCard {
  /** Dispatch stamp; null for a never-dispatched card (address by text). */
  blockId: string | null
  text: string
  agentKey: string | null
}

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
  /** The review cards themselves — so an approve affordance outside the
   *  Spaces pane (the Inbox's agent rows) can move one to Done by ^id. */
  reviewCards: ReviewCard[]
  /** Title of the board's Done-like column (first match), null when the
   *  board has none — the approve target for `POST /board/:project/move`. */
  doneColumn: string | null
  /** agentKeys assigned to ANY card on the board (all columns, dedup'd).
   *  A fork whose key owns a card is reachable via the card, so the rail
   *  suppresses its badge/alert rows (^lean-ibis) — attention excepted. */
  cardAgentKeys: string[]
  /** Board frontmatter `default_owner:` — the agent unassigned cards auto-
   *  assign to (null = none set; the "-general" convention applies). */
  defaultOwner: string | null
  /** Where a session bound to this space runs by default — see spaceCwd().
   *  Clients compare each bound session's cwd against it to flag strays. */
  cwd: string
  /** Target of the project's `repo` symlink (code checkout), null if none. */
  repo: string | null
  /** Cards in a dispatch column that the concurrency cap is holding back —
   *  unstamped and unassigned-by-us, so nothing on the card itself explains
   *  why it is idle. The rail shows "queued (N)" on the dispatch column. */
  queuedCount: number
}

export interface ListSpacesOpts {
  /** How many of this board's cards the dispatcher has queued
   *  (BoardWatcher.queuedCards, grouped by board path). In-memory watcher
   *  state — absent (tests, boot before the watcher exists) → 0. */
  queuedFor?: (boardPath: string) => number
}

export async function listSpaces(store: NoteStore, opts: ListSpacesOpts = {}): Promise<SpaceSummary[]> {
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
    const reviewCards: ReviewCard[] = []
    let doneColumn: string | null = null
    const cardAgentKeys = new Set<string>()
    let defaultOwner: string | null = null
    if (boardContent) {
      defaultOwner = boardDefaultOwner(boardContent)
      try {
        for (const col of parseBoard(boardContent).columns) {
          if (doneColumn === null && DONE_COLUMN_RE.test(col.title)) doneColumn = col.title
          const isReview = REVIEW_COLUMN_RE.test(col.title)
          for (const card of col.cards) {
            if (card.agentKey) cardAgentKeys.add(card.agentKey)
            if (!isReview) continue
            reviewCount++
            if (card.agentKey) reviewAgentKeys.push(card.agentKey)
            reviewCards.push({ blockId: card.blockId ?? null, text: card.text, agentKey: card.agentKey ?? null })
          }
        }
      } catch { /* unparseable board — counts stay 0 */ }
    }
    out.push({
      kind: 'project', slug, title, notePath, boardPath, status, fileCount: flat ? 1 : files.length,
      reviewCount, reviewAgentKeys, reviewCards, doneColumn, cardAgentKeys: [...cardAgentKeys], defaultOwner,
      cwd: spaceCwd(store.vaultPath, { project: slug })!,
      repo: projectRepo(store.vaultPath, slug),
      queuedCount: boardPath ? opts.queuedFor?.(boardPath) ?? 0 : 0,
    })
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
      reviewCards: [],
      doneColumn: null,
      cardAgentKeys: [],
      defaultOwner: null,
      cwd: store.vaultPath,
      repo: null,
      queuedCount: 0,
    })
  }

  return out.sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === 'area' ? -1 : 1))
}
