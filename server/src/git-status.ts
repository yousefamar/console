// Non-blocking git status for the session status bar (branch / dirty / +-),
// described for the checkout a session is really about (resolveCheckout).
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
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface GitStatus {
  branch?: string
  dirty?: boolean
  stats?: { added: number; deleted: number }
  /** The checkout actually described, when it is not `cwd` itself — a code
   *  repository found INSIDE a vault project dir (see resolveCheckout). */
  repo?: string
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
  // GIT_OPTIONAL_LOCKS=0 is not an optimisation — it is load-bearing. `git
  // status` (and `git diff`) opportunistically take `.git/index.lock` to write
  // back a refreshed stat cache, and this helper is a POLLER: the SPA asks for
  // every session's info every 10 s. On a seek-bound HDD at 94% those calls
  // exceed the timeouts below, node kills git mid-operation, and the lock
  // survives as a zero-byte orphan that fails every later commit in that repo
  // until something removes it. That is what blocked every fork's commits for
  // 6 h on 2026-10-06 (console, then demovid and reflection-tools) — found by
  // Homelab's host watcher, verified here by strace: plain `status --porcelain`
  // opens index.lock, with this env set it opens it zero times. Raising the
  // timeouts does NOT fix it, only makes the race rarer.
  const { stdout } = await execFileP('git', args, {
    cwd, timeout, encoding: 'utf-8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
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

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory() } catch { return false }
}

/** The checkout the status bar should describe for a session at `cwd`.
 *
 *  A space-bound session runs from its VAULT project dir, which sits inside
 *  the vault's own git repo — so the naive answer is the vault's branch and
 *  +/- (noise: `master`, one stray untracked file). When the project dir
 *  links the code checkout — `repo` by convention, or any other SYMLINKED
 *  child that is a repository (astera links its app as `app`) — that
 *  checkout is what Yousef wants to see (^spry-seal, ^teal-wolf).
 *
 *  Only links count, never real subdirectories: a repo nested inside the
 *  vault (`root/al`, the old Al checkout) is vault CONTENT, and the area
 *  session at the vault root must keep describing the vault. A cwd that is
 *  itself a repository root is never searched (a session inside a code repo
 *  describes that repo, not a submodule under it). Several candidates → the
 *  `repo` link wins, else the first by name. */
export async function resolveCheckout(cwd: string): Promise<string> {
  if (await exists(join(cwd, '.git'))) return cwd
  const repo = join(cwd, 'repo')
  if (await isDir(repo)) return repo
  let names: string[]
  try {
    const entries = await readdir(cwd, { withFileTypes: true })
    names = entries.filter((d) => d.isSymbolicLink() && !d.name.startsWith('.')).map((d) => d.name).sort()
  } catch {
    return cwd
  }
  for (const name of names) {
    const p = join(cwd, name)
    if (await exists(join(p, '.git'))) return p
  }
  return cwd
}

async function refresh(cwd: string, e: Entry): Promise<void> {
  try {
    const dir = await resolveCheckout(cwd)
    const [branch, status] = await Promise.all([
      git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], 2000),
      git(dir, ['status', '--porcelain'], 2000),
    ])
    const dirty = status.length > 0
    let stats: GitStatus['stats']
    if (dirty) {
      const [staged, unstaged] = await Promise.all([
        git(dir, ['diff', '--cached', '--numstat'], 3000),
        git(dir, ['diff', '--numstat'], 3000),
      ])
      const s = sumNumstat(staged), u = sumNumstat(unstaged)
      // Untracked files count as one added line each.
      const untracked = status.split('\n').filter((l) => l.startsWith('?? ')).length
      stats = { added: s.added + u.added + untracked, deleted: s.deleted + u.deleted }
    }
    e.value = { branch: branch || undefined, dirty, stats, repo: dir === cwd ? undefined : dir }
  } catch {
    e.value = {}
  } finally {
    e.at = Date.now()
    e.inflight = null
  }
}
