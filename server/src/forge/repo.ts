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
import { basename } from 'node:path'
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

  const checkout = await forgeExec(cfg, `set -e
    if [ ! -d ${code}/.git ]; then
      git clone --quiet ${bare} ${code}
      git -C ${code} checkout --quiet ${branch} 2>/dev/null || git -C ${code} checkout --quiet -b ${branch}
    else
      git -C ${code} fetch --quiet origin
      git -C ${code} checkout --quiet ${branch}
      git -C ${code} merge --quiet --ff-only origin/${branch}
    fi
    git -C ${code} rev-parse --short HEAD`)
  if (checkout.code !== 0) return { ok: false, reason: `forge checkout of ${code} failed: ${checkout.stderr.trim()}`, branch }

  log(`[forge] ${name}: synced ${branch} → ${code} @ ${checkout.stdout.trim()}`)
  return { ok: true, reason: `synced ${branch} @ ${checkout.stdout.trim()}`, branch }
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
