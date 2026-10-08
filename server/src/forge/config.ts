// forge — the remote compute box that hosts offloaded agent forks.
//
// Why it exists: 9 forks shared one 8-core/23 GiB desktop whose worktrees all
// sat on a 7200 rpm disk at 95% full (44% iowait, 35% CPU idle, 5.5 GiB
// swapped, 6 Oct 2026). Moving work to the local SSD was tried first and did
// not help, so the compute leaves the box instead. Design + measurements:
// ~/sync/brain/root/projects/console/research/remote-compute-offload.md
//
// The illusion to preserve: everything except CPU/RAM/disk must feel local.
// Ports come back through SSH forwards, the hub stays the only authority, and
// an agent's instructions are unchanged — it still runs `autowt` itself, just
// in a shell that happens to live in eu-west-2.
//
// This file: configuration + the local-vs-remote routing decision. Nothing
// here performs I/O against the box.

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ForgeConfig {
  instanceId: string
  region: string
  /** ssh host alias (scripts/forge/ssh-setup.sh writes the matching block). */
  host: string
  sshKey: string
  remoteUser: string
  accessKeyId?: string
  secretAccessKey?: string
  /** Minutes with no remote session before the instance is stopped. */
  idleStopMinutes: number
  /** Where repos live on the box — the DESKTOP'S PATH, mirrored. A session's
   *  cwd is a vault project dir containing a `repo` symlink to
   *  /home/amar/proj/code/<slug>, and CLAUDE.md plus every agent habit names
   *  those paths, so forge reproduces them rather than translating. Worktrees
   *  land beside the checkout via autowt's `../{repo_name}-worktrees/{branch}`,
   *  exactly as here. */
  codeDir: string
  /** Bare push mirrors (nobody works in these), on the box's own disk. */
  bareDir: string
  /** Repos whose forks talk to GitHub, by checkout basename.
   *
   *  For these the box's `origin` must be GITHUB, not the local bare mirror.
   *  It is a policy, not something detectable: Console and Astera both have a
   *  GitHub `origin` on the desktop, but Console is trunk-based and its forks
   *  never push there, while every Astera fork pushes a card branch and merges
   *  a PR on GitHub. See `isGithubOriginRepo`. */
  githubOriginRepos: string[]
}

export const FORGE_CONFIG_FILE = process.env.FORGE_CRED_FILE || join(homedir(), '.config', 'console', 'forge.json')

let cached: { at: number; value: ForgeConfig | null } | null = null

/** Read ~/.config/console/forge.json. Absent (or unparseable) = the feature is
 *  simply off and every fork stays local — never an error, because a missing
 *  cloud box must not be able to wedge the board. */
export function forgeConfig(opts: { file?: string; ttlMs?: number } = {}): ForgeConfig | null {
  const file = opts.file ?? FORGE_CONFIG_FILE
  const ttl = opts.ttlMs ?? 10_000
  if (!opts.file && cached && Date.now() - cached.at < ttl) return cached.value
  let value: ForgeConfig | null = null
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ForgeConfig>
      if (raw.instanceId && raw.region) {
        value = {
          instanceId: raw.instanceId,
          region: raw.region,
          host: raw.host || 'forge',
          sshKey: raw.sshKey || join(homedir(), '.ssh', 'forge_ed25519'),
          remoteUser: raw.remoteUser || 'amar',
          accessKeyId: raw.accessKeyId,
          secretAccessKey: raw.secretAccessKey,
          idleStopMinutes: raw.idleStopMinutes ?? 20,
          codeDir: raw.codeDir || '/home/amar/proj/code',
          bareDir: raw.bareDir || '/srv/git',
          githubOriginRepos: Array.isArray(raw.githubOriginRepos) ? raw.githubOriginRepos : [],
        }
      }
    }
  } catch {
    value = null
  }
  if (!opts.file) cached = { at: Date.now(), value }
  return value
}

export function forgeAvailable(opts: { file?: string } = {}): boolean {
  return forgeConfig(opts) !== null
}

/** Does this repo's box checkout need GITHUB as `origin`?
 *
 *  Why this exists, and why it is not a global flip. forge seeds repos by push
 *  from the desktop into a local bare mirror, and the box's `origin` pointed at
 *  that mirror — correct while the premise held that "forge needs no GitHub
 *  credentials". For a repo whose forks land their own PRs it is badly wrong,
 *  and wrong SILENTLY: Astera's `land.sh` merges `origin/staging` and takes its
 *  gate base from it, so against a static mirror it gates a green build on a
 *  stale base, and its "did staging move under the gate?" re-check can never
 *  fire because the mirror never moves. Measured 8 Oct 2026: the mirror's
 *  staging was 25 commits and 9 merged PRs (~6h47m) behind GitHub's on a single
 *  working day, because the mirror only advances when a prepare pushes the
 *  DESKTOP's remote-tracking refs — its freshness is bounded by the desktop's
 *  last fetch, never by GitHub.
 *
 *  Console is the opposite shape and must keep the mirror: it is trunk-based,
 *  commits to `main` locally, does not always push, and its forks never talk to
 *  GitHub — so pointing its `origin` at GitHub would invent a dependency it
 *  does not have. Hence per-repo config rather than a default either way. */
export function isGithubOriginRepo(cfg: Pick<ForgeConfig, 'githubOriginRepos'>, repoName: string): boolean {
  return cfg.githubOriginRepos.includes(repoName)
}

/** Clear the config cache (tests, and after a re-provision rewrites the file). */
export function resetForgeConfigCache(): void {
  cached = null
}

// ------------------------------------------------------------------ routing

export type Placement = 'local' | 'forge'

/** Board frontmatter `remote: forge` — every ticket-fork on THIS board runs on
 *  forge unless its card says otherwise. Mirrors `fork_context: inherit`.
 *  Anything other than a known target reads as local (a typo must not silently
 *  ship work to a cloud box). */
export function boardRemote(content: string): Placement | null {
  const fence = content.match(/^---\n([\s\S]*?)\n---/)
  const m = (fence?.[1] ?? '').match(/^remote:\s*(\S+)\s*$/m)
  if (!m) return null
  return m[1] === 'forge' ? 'forge' : m[1] === 'local' ? 'local' : null
}

/** Where a card's fork should run.
 *
 *  Resolution order is card tag → board frontmatter → local, and **local is
 *  both the default and the fallback**: a forge that is unreachable, a repo
 *  that will not fast-forward, or a tunnel that is refused all land back here
 *  (the caller downgrades and says so on the card). The board must never wedge
 *  because a cloud box is asleep. */
export function resolvePlacement(opts: {
  /** `#forge` / `#local` card tag. */
  cardRemote?: Placement | null
  /** Board frontmatter. */
  boardRemote?: Placement | null
  /** False when there is no forge configured at all. */
  available?: boolean
}): { placement: Placement; reason: string } {
  const available = opts.available ?? forgeAvailable()
  const wanted = opts.cardRemote ?? opts.boardRemote ?? 'local'
  const source = opts.cardRemote ? 'card tag' : opts.boardRemote ? 'board frontmatter' : 'default'
  if (wanted === 'local') return { placement: 'local', reason: `${source}: local` }
  if (!available) return { placement: 'local', reason: 'forge requested but not configured' }
  return { placement: 'forge', reason: `${source}: forge` }
}
