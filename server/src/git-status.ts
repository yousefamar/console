// Non-blocking git status for the session status bar (branch / dirty / +-).
//
// Session.getInfo() used to shell out SYNCHRONOUSLY — up to four `execSync git`
// calls per session, cached 10 s — and the SPA asks for every session's info
// every 10 s. That made each list_sessions sweep freeze the hub's event loop
// for (sessions × git calls × per-call latency): measured 2.5–4 s in every
// 10 s window at load 13 with 32 sessions, and on 2026-09-04 (43 sessions,
// disk saturated by fork start-ups, each call hitting its 2–3 s timeout) the
// sweep outran its own cadence — the hub was frozen for minutes, which is what
// agents saw as "board CLI blocks >2 min while the hub is forking" (^plum-bee).
//
// Same shape as process-tree.ts: the sync accessor serves a snapshot and
// schedules an async refresh when stale. One snapshot per DISTINCT checkout —
// a dozen console sessions share one — so a sweep costs a handful of
// non-blocking execFile calls instead of a hundred blocking ones.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface GitStatus {
  branch?: string
  dirty?: boolean
  stats?: { added: number; deleted: number }
}

interface Entry { at: number; value: GitStatus; inflight: Promise<void> | null }

const REFRESH_MS = 10_000
const entries = new Map<string, Entry>()

/** Snapshot for the checkout at `cwd` — empty until the first refresh lands.
 *  Never blocks: a stale entry kicks off one background refresh. */
export function gitStatusSync(cwd: string): GitStatus {
  let e = entries.get(cwd)
  if (!e) {
    e = { at: 0, value: {}, inflight: null }
    entries.set(cwd, e)
  }
  if (!e.inflight && Date.now() - e.at >= REFRESH_MS) e.inflight = refresh(cwd, e)
  return e.value
}

/** Drop the snapshot for a checkout (tests; a session that moved cwd). */
export function forgetGitStatus(cwd: string): void {
  entries.delete(cwd)
}

async function git(cwd: string, args: string[], timeout: number): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, timeout, encoding: 'utf-8' })
  return stdout.trim()
}

function sumNumstat(out: string): { added: number; deleted: number } {
  let added = 0, deleted = 0
  for (const line of out.split('\n')) {
    const [a, d] = line.split('\t')
    if (a && d && a !== '-') { added += parseInt(a, 10); deleted += parseInt(d, 10) }
  }
  return { added, deleted }
}

async function refresh(cwd: string, e: Entry): Promise<void> {
  try {
    const [branch, status] = await Promise.all([
      git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 2000),
      git(cwd, ['status', '--porcelain'], 2000),
    ])
    const dirty = status.length > 0
    let stats: GitStatus['stats']
    if (dirty) {
      const [staged, unstaged] = await Promise.all([
        git(cwd, ['diff', '--cached', '--numstat'], 3000),
        git(cwd, ['diff', '--numstat'], 3000),
      ])
      const s = sumNumstat(staged), u = sumNumstat(unstaged)
      // Untracked files count as one added line each.
      const untracked = status.split('\n').filter((l) => l.startsWith('?? ')).length
      stats = { added: s.added + u.added + untracked, deleted: s.deleted + u.deleted }
    }
    e.value = { branch: branch || undefined, dirty, stats }
  } catch {
    e.value = {}
  } finally {
    e.at = Date.now()
    e.inflight = null
  }
}
