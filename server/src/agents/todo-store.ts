// ============================================================================
// Claude CLI task list ("todos") — read from the CLI's own on-disk store.
//
// The CLI dropped `TodoWrite` (whole-list-per-call) in favour of deferred,
// incremental `TaskCreate` / `TaskUpdate` tools. Neither the stream-json events
// nor any control_request subtype ever carries the ASSEMBLED list — each call
// mutates exactly one task and results are plain strings ("Task #3 created…").
// So the only whole-list source is the CLI's own store:
//
//   ~/.claude/tasks/<claudeSessionId>/<id>.json   (+ a 0-byte .lock)
//   { id, subject, description, activeForm?, status, blocks[], blockedBy[] }
//
// Reading it rather than folding the call stream is deliberate: the stream
// reducer would be silently truncated by Session's 500-entry messageLog cap
// (early TaskCreates age out → a permanently incomplete list) and would have to
// scrape ids out of a result *string*. The files are whole-list, survive hub
// restarts, and outlive a hibernated subprocess.
//
// NOTE: distinct from the vault kanban boards (kanban/), which carry Console's own work assignment.
// ============================================================================

import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** A finished list is history. The CLI never clears ~/.claude/tasks/<csid>/ —
 *  for a session that lives for months it is the accumulated record of every
 *  plan ever made — so once every task is completed and the dir has sat
 *  untouched this long, the list is hidden from SessionInfo (both clients
 *  render off that). A new TaskCreate bumps the mtime and un-hides it. */
export const TODO_STALE_MS = 60 * 60_000

export function isStaleTodoList(todos: TodoItem[], updatedAt: number, now = Date.now()): boolean {
  return todos.length > 0
    && todos.every((t) => t.status === 'completed')
    && now - updatedAt >= TODO_STALE_MS
}

/** Newest mtime (ms epoch) across the session's task files; 0 when none. */
export function todosUpdatedAt(claudeSessionId: string): number {
  const dir = sessionDir(claudeSessionId)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let newest = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      newest = Math.max(newest, statSync(join(dir, name)).mtimeMs)
    } catch {
      // Removed between readdir and stat — nothing to count.
    }
  }
  return newest
}

export interface TodoItem {
  id: string
  subject: string
  description?: string
  /** Present-tense label the CLI shows while the task is in_progress. */
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Resolved per call, not captured at module load — tests point
 *  CONSOLE_CLAUDE_TASKS_DIR at a temp dir. */
function tasksRoot(): string {
  return process.env.CONSOLE_CLAUDE_TASKS_DIR || join(homedir(), '.claude', 'tasks')
}

function sessionDir(claudeSessionId: string): string {
  return join(tasksRoot(), claudeSessionId)
}

/** Numeric-aware id sort — filenames are "1".."13", so a lexical sort would
 *  put 10 before 2. */
function byId(a: TodoItem, b: TodoItem): number {
  const na = Number(a.id)
  const nb = Number(b.id)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a.id.localeCompare(b.id)
}

/** Read the whole task list for a claudeSessionId. Missing dir → []. Never
 *  throws: a half-written or malformed file is skipped, not fatal. */
export function readTodos(claudeSessionId: string): TodoItem[] {
  const dir = sessionDir(claudeSessionId)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: TodoItem[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue // skips .lock
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Partial<TodoItem>
      const status = raw.status
      if (!raw.subject || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) continue
      out.push({
        id: String(raw.id ?? name.replace(/\.json$/, '')),
        subject: raw.subject,
        ...(raw.description ? { description: raw.description } : {}),
        ...(raw.activeForm ? { activeForm: raw.activeForm } : {}),
        status,
      })
    } catch {
      // Mid-write file — the watcher will fire again when it settles.
    }
  }
  return out.sort(byId)
}

export function todosEqual(a: TodoItem[], b: TodoItem[]): boolean {
  if (a.length !== b.length) return false
  return a.every((t, i) => {
    const o = b[i]!
    return t.id === o.id && t.status === o.status && t.subject === o.subject
      && t.activeForm === o.activeForm && t.description === o.description
  })
}

/** Watch one session's task dir. Debounced + content-compared, so the CLI's
 *  own multi-file writes collapse into one callback and a no-op touch is
 *  silent. Returns a disposer; safe to call for a dir that doesn't exist yet
 *  (watches the parent until it appears). */
export function watchTodos(
  claudeSessionId: string,
  onChange: (todos: TodoItem[]) => void,
  log: (m: string) => void = () => {},
): () => void {
  const dir = sessionDir(claudeSessionId)
  let last = readTodos(claudeSessionId)
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null
  let rootWatcher: FSWatcher | null = null
  let disposed = false

  const fire = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (disposed) return
      const next = readTodos(claudeSessionId)
      if (todosEqual(last, next)) return
      last = next
      onChange(next)
    }, 150)
  }

  const attach = (): boolean => {
    if (!existsSync(dir)) return false
    try {
      watcher = watch(dir, { persistent: false }, () => fire())
      return true
    } catch (e) {
      log(`[todos] watch ${claudeSessionId} failed: ${(e as Error).message}`)
      return false
    }
  }

  if (!attach()) {
    // The dir only appears on the session's first TaskCreate. Watch the root
    // for its creation, then hand off.
    try {
      rootWatcher = watch(tasksRoot(), { persistent: false }, (_evt, filename) => {
        if (disposed || watcher) return
        if (filename && filename.toString() !== claudeSessionId) return
        if (attach()) {
          rootWatcher?.close()
          rootWatcher = null
          fire()
        }
      })
    } catch {
      // No ~/.claude/tasks at all (fresh machine) — nothing to watch.
    }
  }

  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
    watcher?.close()
    rootWatcher?.close()
  }
}
