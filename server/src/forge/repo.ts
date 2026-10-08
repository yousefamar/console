// Repo placement on forge.
//
// The desktop stays the source of truth for the main branch: forks merge back
// into it there, and unpushed local commits are normal (Console is trunk-based
// and does not always push). So forge is seeded BY PUSH from the desktop, never
// by cloning GitHub — which also means forge needs no GitHub credentials.
//
// Layout mirrors the desktop so autowt behaves identically and the agent's
// instructions need no edit:
//   /srv/git/<repo>.git    bare mirror (push target; nobody works here)
//   /srv/code/<repo>       primary checkout, main
//   /srv/code/<repo>-worktrees/<branch>   where `autowt switch` lands
//
// The dangerous direction is the way back. A fork merges into main ON FORGE,
// and the desktop must fast-forward to pick it up. If the desktop has moved
// too (a `#local` card committed meanwhile) we REFUSE and say so: silently
// stranding a card's work on a cloud box, or silently resolving someone's
// merge, are both worse than a loud failure.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { ForgeConfig } from './config.js'
import { forgeExec } from './ssh.js'

const execFileP = promisify(execFile)

async function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 })
    return { ok: true, stdout, stderr }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' }
  }
}

export function repoNameFor(localRepoPath: string): string {
  return basename(localRepoPath.replace(/\/+$/, ''))
}

/** The branch the desktop considers main for this repo — read from the repo
 *  rather than assumed: Console is `main`, the vault is `master`. */
export async function localMainBranch(localRepoPath: string): Promise<string> {
  const head = await git(['symbolic-ref', '--short', 'HEAD'], localRepoPath)
  if (head.ok && head.stdout.trim()) return head.stdout.trim()
  for (const b of ['main', 'master']) {
    const r = await git(['rev-parse', '--verify', b], localRepoPath)
    if (r.ok) return b
  }
  return 'main'
}

export interface SyncResult {
  ok: boolean
  reason: string
  branch?: string
}

/** Create the bare mirror + primary checkout on forge and push the desktop's
 *  main into them. Idempotent; safe before every dispatch. */
export async function ensureRepoOnForge(cfg: ForgeConfig, localRepoPath: string, log: (m: string) => void = () => {}): Promise<SyncResult> {
  const name = repoNameFor(localRepoPath)
  const bare = `${cfg.bareDir}/${name}.git`
  const code = `${cfg.codeDir}/${name}`
  const branch = await localMainBranch(localRepoPath)

  const init = await forgeExec(cfg, `set -e
    [ -d ${bare} ] || git init --quiet --bare ${bare}
    git -C ${bare} symbolic-ref HEAD refs/heads/${branch} 2>/dev/null || true`)
  if (init.code !== 0) return { ok: false, reason: `could not create ${bare} on forge: ${init.stderr.trim()}` }

  // Point the desktop at it. `ssh://forge/...` resolves through ~/.ssh/config,
  // so the SSM ProxyCommand applies to git too.
  const url = `ssh://${cfg.host}${bare}`
  const existing = await git(['remote', 'get-url', 'forge'], localRepoPath)
  if (!existing.ok) {
    const add = await git(['remote', 'add', 'forge', url], localRepoPath)
    if (!add.ok) return { ok: false, reason: `git remote add forge failed: ${add.stderr.trim()}` }
  } else if (existing.stdout.trim() !== url) {
    await git(['remote', 'set-url', 'forge', url], localRepoPath)
  }

  const push = await git(['push', 'forge', `${branch}:refs/heads/${branch}`], localRepoPath)
  if (!push.ok) {
    // Non-fast-forward here means forge is AHEAD — a previous card's merge has
    // not been folded back yet. Fold back first; never force.
    return { ok: false, reason: `push to forge rejected (forge may be ahead — fold back first): ${push.stderr.trim()}`, branch }
  }

  await pushBaseBranches(cfg, localRepoPath, branch, log)

  const checkout = await ensurePrimaryCheckout(cfg, { bare, code, branch }, log)
  if (!checkout.ok) return { ok: false, reason: checkout.reason, branch }

  await mirrorDesktopPath(cfg, localRepoPath, log)
  log(`[forge] ${name}: ${checkout.reason}`)
  return { ok: true, reason: checkout.reason, branch }
}

/** What a prepare should do to forge's PRIMARY checkout, given what is there.
 *
 *  It must not move HEAD. A prepare is idempotent housekeeping that runs before
 *  every remote dispatch, and it used to `checkout <desktop's default branch>`
 *  unconditionally — so for any repo whose work does not happen on that branch
 *  it would yank the checkout out from under whatever was using it. Astera is
 *  exactly that shape: the desktop's astera-app sits on `main` because main is
 *  production, while every fork bases on `staging`. A prepare would have put
 *  /opt/code/astera-app back on main underneath a running fork, which keeps
 *  building happily and lands against the wrong base — a quieter and worse
 *  failure than the missing-branch one it replaced (raised by Astera general,
 *  8 Oct 2026, before it could bite).
 *
 *  So: clone when absent, fast-forward only when the checkout is already on that
 *  branch AND clean, and otherwise leave it entirely alone. Fetching refs is
 *  always safe and is what worktree creation actually depends on. */
export type PrimaryCheckoutAction = 'clone' | 'fast-forward' | 'leave'

export function decidePrimaryCheckout(
  state: { exists: boolean; branch: string; dirty: boolean },
  targetBranch: string,
): { action: PrimaryCheckoutAction; why: string } {
  if (!state.exists) return { action: 'clone', why: `cloned on ${targetBranch}` }
  if (state.branch !== targetBranch) {
    return { action: 'leave', why: `left on ${state.branch} (refs fetched; a prepare never moves HEAD)` }
  }
  if (state.dirty) return { action: 'leave', why: `left on ${state.branch} with uncommitted changes (refs fetched)` }
  return { action: 'fast-forward', why: `fast-forwarded ${targetBranch}` }
}

async function ensurePrimaryCheckout(
  cfg: ForgeConfig,
  paths: { bare: string; code: string; branch: string },
  log: (m: string) => void,
): Promise<{ ok: boolean; reason: string }> {
  const { bare, code, branch } = paths
  const probe = await forgeExec(cfg, `
    if [ -d ${code}/.git ]; then
      git -C ${code} fetch --quiet origin || true
      echo "exists=1"
      echo "branch=$(git -C ${code} rev-parse --abbrev-ref HEAD 2>/dev/null)"
      echo "dirty=$(git -C ${code} status --porcelain 2>/dev/null | head -1 | wc -l)"
    else
      echo "exists=0"
    fi`, { timeoutMs: 180_000 })
  if (probe.code !== 0) return { ok: false, reason: `could not inspect ${code} on forge: ${probe.stderr.trim()}` }

  const kv = new Map(probe.stdout.split('\n').map((l) => l.trim().split('=') as [string, string]))
  const { action, why } = decidePrimaryCheckout({
    exists: kv.get('exists') === '1',
    branch: kv.get('branch') ?? '',
    dirty: kv.get('dirty') === '1',
  }, branch)

  if (action === 'leave') {
    log(`[forge] ${code}: ${why}`)
    return { ok: true, reason: why }
  }

  const script = action === 'clone'
    ? `set -e
       git clone --quiet ${bare} ${code}
       git -C ${code} checkout --quiet ${branch} 2>/dev/null || git -C ${code} checkout --quiet -b ${branch}
       git -C ${code} rev-parse --short HEAD`
    // Not fatal if it refuses: a divergence here means a fold-back is pending,
    // which is a thing to say rather than a reason to fail every dispatch. The
    // worktrees cards actually build in do not depend on this HEAD.
    : `git -C ${code} merge --quiet --ff-only origin/${branch} 2>&1 || echo "NOT-FF"
       git -C ${code} rev-parse --short HEAD`
  const run = await forgeExec(cfg, script, { timeoutMs: 300_000 })
  if (run.code !== 0) return { ok: false, reason: `forge checkout of ${code} failed: ${run.stderr.trim()}` }
  if (run.stdout.includes('NOT-FF')) {
    const head = run.stdout.trim().split('\n').pop() ?? ''
    return { ok: true, reason: `${branch} on forge has DIVERGED from the mirror and was left at ${head} — fold back before relying on it` }
  }
  return { ok: true, reason: `${why} @ ${run.stdout.trim().split('\n').pop()}` }
}

/** The integration branches a fork might work FROM, beyond this repo's own
 *  default.
 *
 *  The bare mirror used to hold exactly one head, because one branch is all the
 *  desktop pushed — fatal for any project whose work does not happen on it.
 *  Astera's forks branch from `origin/staging` and land onto it, so on forge
 *  `git fetch origin main staging` died on an `origin` with no staging, the
 *  nightly audit could not even resolve its own subject commit, and the card
 *  got nowhere (^spry-boar, 8 Oct 2026). Pushing the desktop's
 *  remote-tracking refs for these names as heads makes forge's `origin` look
 *  like GitHub's, which is what every fork's instructions already assume.
 *
 *  A fixed candidate list rather than every `origin/*`: card branches are the
 *  fork's own to create, and a repo like Astera has hundreds of them on the
 *  remote. Per-branch failure is logged and tolerated — the default branch
 *  above is the load-bearing push; these are what make a base resolvable. */
const BASE_BRANCH_CANDIDATES = ['main', 'master', 'staging', 'develop', 'production']

async function pushBaseBranches(cfg: ForgeConfig, localRepoPath: string, already: string, log: (m: string) => void): Promise<void> {
  const refs = await git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'], localRepoPath)
  if (!refs.ok) return
  const present = new Set(refs.stdout.split('\n').map((s) => s.trim().replace(/^origin\//, '')).filter(Boolean))
  const wanted = BASE_BRANCH_CANDIDATES.filter((b) => b !== already && present.has(b))
  if (!wanted.length) return
  const pushed: string[] = []
  for (const b of wanted) {
    const r = await git(['push', 'forge', `refs/remotes/origin/${b}:refs/heads/${b}`], localRepoPath)
    if (r.ok) pushed.push(b)
    else log(`[forge] ${repoNameFor(localRepoPath)}: could not mirror ${b} (forge may be ahead on it): ${r.stderr.trim().split('\n')[0]}`)
  }
  if (pushed.length) log(`[forge] ${repoNameFor(localRepoPath)}: base branches mirrored — ${pushed.join(', ')}`)
}

/** Make the checkout answer to its DESKTOP path on forge as well.
 *
 *  Path parity is the whole premise of the box (see bootstrap.sh), but it only
 *  held for repos under ~/proj/code. Astera's checkout is /opt/code/astera-app,
 *  and the vault project dir's `app` symlink — carried to forge verbatim by the
 *  sshfs mount, as a symlink's target is just a string — names that absolute
 *  path. So a remote Astera fork followed `app` into a directory that did not
 *  exist. Symlinking the desktop's own path to the mirror fixes every spelling
 *  at once, for the worktrees dir too. No-op when the paths already agree. */
async function mirrorDesktopPath(cfg: ForgeConfig, localRepoPath: string, log: (m: string) => void): Promise<void> {
  const name = repoNameFor(localRepoPath)
  const parent = dirname(localRepoPath)
  if (parent === cfg.codeDir) return
  const r = await forgeExec(cfg, `set -e
    sudo mkdir -p '${parent}'
    sudo ln -sfnT '${cfg.codeDir}/${name}' '${parent}/${name}'
    mkdir -p '${cfg.codeDir}/${name}-worktrees'
    sudo ln -sfnT '${cfg.codeDir}/${name}-worktrees' '${parent}/${name}-worktrees'`)
  if (r.code !== 0) log(`[forge] could not mirror ${parent}/${name} onto ${cfg.codeDir}/${name}: ${r.stderr.trim()}`)
}

/** `git worktree list --porcelain` → paths and branches. A detached worktree
 *  has no `branch` line and is skipped: there is no branch to push. */
export function parseWorktreeList(porcelain: string, primaryPath: string): Array<{ path: string; branch: string }> {
  const out: Array<{ path: string; branch: string }> = []
  let path = ''
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9).trim()
    else if (line.startsWith('branch ') && path) {
      out.push({ path, branch: line.slice(7).trim().replace(/^refs\/heads\//, '') })
      path = ''
    }
  }
  const primary = primaryPath.replace(/\/+$/, '')
  // The primary checkout is a "worktree" to git; callers want the siblings.
  return out.filter((w) => w.path.replace(/\/+$/, '') !== primary)
}

/** The desktop's worktrees for a repo, as git itself reports them. */
export async function localWorktrees(localRepoPath: string): Promise<Array<{ path: string; branch: string }>> {
  const r = await git(['worktree', 'list', '--porcelain'], localRepoPath)
  if (!r.ok) return []
  return parseWorktreeList(r.stdout, localRepoPath)
}

/** Build the same worktree on forge, at the same absolute path, carrying the
 *  branch AND whatever is uncommitted in it.
 *
 *  Uncommitted work is the reason this exists: a card fork in the middle of a
 *  change has most of its state in the working tree, and a move that dropped it
 *  would be a move nobody would use. The branch goes by git (so history and the
 *  index are real), the dirt goes by rsync on top.
 *
 *  Not synced: `.git` (forge's worktree has its own), and the build artefacts a
 *  fork regenerates anyway. A file deleted locally but not committed SURVIVES
 *  on forge — rsync runs without `--delete` on purpose, because the remote tree
 *  also holds forge's own untracked output and deleting by guess is worse. */
export async function ensureWorktreeOnForge(
  cfg: ForgeConfig,
  localRepoPath: string,
  worktree: { path: string; branch: string },
  log: (m: string) => void = () => {},
): Promise<SyncResult> {
  const name = repoNameFor(localRepoPath)
  const code = `${cfg.codeDir}/${name}`
  const wt = worktree.path.replace(/\/+$/, '')
  const br = worktree.branch
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

  // Plain push, never forced: a rejection means forge's copy of this branch has
  // commits the desktop does not, i.e. an earlier stint on the box whose work
  // has not come home. Overwriting that is exactly the data loss the fold-back
  // rules exist to prevent, so say so and refuse the move.
  const push = await git(['push', 'forge', `${br}:refs/heads/${br}`], localRepoPath)
  if (!push.ok) {
    return { ok: false, branch: br, reason: `pushing ${br} to forge was rejected — forge may already hold commits on it from an earlier stint; reconcile by hand before moving: ${push.stderr.trim()}` }
  }

  // -B resets forge's branch to what the desktop just pushed. Safe in this
  // direction only: the desktop is the source of truth until the fork lands.
  const add = await forgeExec(cfg, `set -e
    git -C ${q(code)} fetch --quiet origin
    if [ -d ${q(wt)}/.git ] || [ -f ${q(wt)}/.git ]; then
      git -C ${q(wt)} checkout --quiet -B ${q(br)} ${q(`origin/${br}`)}
    else
      mkdir -p ${q(dirname(wt))}
      git -C ${q(code)} worktree add --quiet -B ${q(br)} ${q(wt)} ${q(`origin/${br}`)}
    fi
    git -C ${q(wt)} rev-parse --short HEAD`, { timeoutMs: 180_000 })
  if (add.code !== 0) return { ok: false, reason: `forge worktree ${wt} failed: ${add.stderr.trim()}`, branch: br }

  const extra = [`${homedir()}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin']
  const merged = [...new Set([...extra, ...(process.env.PATH ?? '').split(':')])].filter(Boolean)
  const excludes = ['.git', 'node_modules', '.next', '.turbo', 'dist', 'build', 'target', '.venv', 'playwright-report', 'test-results', '.pnpm-store']
  try {
    await execFileP('rsync', [
      '-az', '-e', 'ssh -o BatchMode=yes',
      ...excludes.flatMap((e) => ['--exclude', e]),
      `${wt}/`, `${cfg.host}:${wt}/`,
    ], { env: { ...process.env, PATH: merged.join(':') }, timeout: 900_000, maxBuffer: 16 * 1024 * 1024 })
  } catch (err) {
    return { ok: false, reason: `uncommitted changes in ${wt} did not reach forge: ${((err as Error).message ?? '').split('\n')[0]}`, branch: br }
  }
  log(`[forge] ${name}: worktree ${wt} on ${br} @ ${add.stdout.trim()}, working changes included`)
  return { ok: true, reason: `worktree ${wt} @ ${add.stdout.trim()}`, branch: br }
}

/** Pull a remote fork's merged work back onto the desktop's main.
 *
 *  Fast-forward only, by design. A divergence means the desktop's main moved
 *  while forge's did too; the hub is not allowed to guess which wins, so it
 *  reports and leaves both intact. */
export async function foldBackFromForge(cfg: ForgeConfig, localRepoPath: string, log: (m: string) => void = () => {}): Promise<SyncResult> {
  const name = repoNameFor(localRepoPath)
  const code = `${cfg.codeDir}/${name}`
  const branch = await localMainBranch(localRepoPath)

  // Push forge's primary checkout into the bare mirror the desktop fetches.
  const up = await forgeExec(cfg, `set -e
    git -C ${code} checkout --quiet ${branch}
    git -C ${code} push --quiet origin ${branch}:refs/heads/${branch}
    git -C ${code} rev-parse HEAD`)
  if (up.code !== 0) return { ok: false, reason: `forge could not publish ${branch}: ${up.stderr.trim()}`, branch }

  const fetch = await git(['fetch', 'forge', branch], localRepoPath)
  if (!fetch.ok) return { ok: false, reason: `fetch from forge failed: ${fetch.stderr.trim()}`, branch }

  const remoteHead = up.stdout.trim()
  const already = await git(['merge-base', '--is-ancestor', remoteHead, 'HEAD'], localRepoPath)
  if (already.ok) {
    log(`[forge] ${name}: desktop already contains ${remoteHead.slice(0, 8)}`)
    return { ok: true, reason: 'desktop already up to date', branch }
  }

  const dirty = await git(['status', '--porcelain'], localRepoPath)
  if (dirty.ok && dirty.stdout.trim()) {
    return { ok: false, reason: `desktop ${branch} has uncommitted changes — fold back by hand: git -C ${localRepoPath} merge --ff-only forge/${branch}`, branch }
  }

  const ff = await git(['merge', '--ff-only', `forge/${branch}`], localRepoPath)
  if (!ff.ok) {
    return {
      ok: false,
      branch,
      reason: `desktop ${branch} and forge ${branch} have DIVERGED — refusing to merge automatically. Resolve by hand: git -C ${localRepoPath} merge forge/${branch}`,
    }
  }
  log(`[forge] ${name}: folded forge/${branch} back onto the desktop`)
  return { ok: true, reason: `fast-forwarded to ${remoteHead.slice(0, 8)}`, branch }
}

/** Install the `con` CLI on forge from the synced checkout, so a remote fork's
 *  board/notes/attach commands behave exactly as on the desktop. */
export async function ensureConCli(cfg: ForgeConfig, consoleRepoName = 'console'): Promise<SyncResult> {
  const cli = `${cfg.codeDir}/${consoleRepoName}/cli`
  const r = await forgeExec(cfg, `set -e
    cd ${cli}
    [ -d node_modules ] || npm install --silent --no-audit --no-fund
    command -v con >/dev/null || sudo npm link --silent
    con --version 2>/dev/null || true`, { timeoutMs: 600_000 })
  return r.code === 0
    ? { ok: true, reason: `con installed on forge (${r.stdout.trim() || 'ok'})` }
    : { ok: false, reason: `con install failed: ${r.stderr.trim()}` }
}
