// The vault, as seen from forge.
//
// forge holds NO copy of the vault. It sshfs-mounts the pieces it needs back
// off the desktop, at the SAME absolute paths, through the reverse SSH forward
// the hub already maintains (DESKTOP_SSH_PORT). Two consequences, both wanted:
//
//  - Nothing to replicate and nothing to reconcile. The desktop stays the only
//    writer of board.md (remote forks mutate it through `con` → the hub), so
//    the sync-conflict class that a Syncthing peer would introduce never
//    exists, and no vault content lives on a cloud disk at rest.
//  - 18 ms per metadata op is irrelevant here, because the consumers are an
//    agent reading CLAUDE.md and writing the odd research doc. That same
//    latency is why the WORKING SET (worktrees, node_modules, build output)
//    must never be mounted — see research/remote-compute-offload.md §2.
//
// Transcripts deliberately stay on forge's own disk and are rsynced back
// (transcripts.ts): a FUSE mount dropping mid-turn would corrupt the one file
// that makes a session resumable.

import { lstatSync, realpathSync, existsSync } from 'node:fs'
import type { ForgeConfig } from './config.js'
import { forgeExec, DESKTOP_SSH_PORT } from './ssh.js'

/** sshfs options: reconnect across a tunnel blip, and cache attributes briefly
 *  so an agent's repeated stat of CLAUDE.md is not 18 ms every time. */
const SSHFS_OPTS = [
  `port=${DESKTOP_SSH_PORT}`,
  'reconnect',
  'ServerAliveInterval=15',
  'ServerAliveCountMax=3',
  'StrictHostKeyChecking=no',
  'UserKnownHostsFile=/dev/null',
  'IdentityFile=/home/amar/.ssh/desktop_ed25519',
  'cache_timeout=20',
  'attr_timeout=20',
  'dir_cache=yes',
].join(',')

export interface MountResult { ok: boolean; reason: string; mounted: string[] }

/** Mount one desktop path at the identical path on forge. Idempotent. */
async function mountOne(cfg: ForgeConfig, path: string): Promise<{ ok: boolean; reason: string }> {
  const r = await forgeExec(cfg, `set -e
    if mountpoint -q ${JSON.stringify(path)}; then echo already; exit 0; fi
    mkdir -p ${JSON.stringify(path)}
    sshfs -o ${SSHFS_OPTS} amar@127.0.0.1:${JSON.stringify(path)} ${JSON.stringify(path)}
    mountpoint -q ${JSON.stringify(path)} && echo mounted`, { timeoutMs: 60_000 })
  if (r.code !== 0) return { ok: false, reason: r.stderr.trim() || `sshfs ${path} failed` }
  return { ok: true, reason: r.stdout.trim() || 'mounted' }
}

export async function isMounted(cfg: ForgeConfig, path: string): Promise<boolean> {
  const r = await forgeExec(cfg, `mountpoint -q ${JSON.stringify(path)} && echo yes || echo no`, { timeoutMs: 30_000 })
  return r.stdout.trim() === 'yes'
}

/** Everything a remote session needs to see of the desktop: its cwd (the vault
 *  project dir, carrying CLAUDE.md and the `repo` symlink) and its auto-memory
 *  dir. A cwd the box already has in a clone (`cwdFrom: 'clone'`) is not mounted. Returns ok:false so the caller can downgrade the fork to local — a
 *  session whose cwd is missing would fail in a far more confusing way. */
export async function ensureSessionMounts(cfg: ForgeConfig, opts: { cwd: string; memoryDir?: string | null; cwdFrom?: CwdSource }, log: (m: string) => void = () => {}): Promise<MountResult> {
  const mounted: string[] = []

  // The memory dir is frequently a SYMLINK on the desktop — `con agent cwd`
  // links a relocated session's memory to the dir that already owned it, so
  // e.g. the vault project dir's `memory` points at the repo project dir's.
  // sshfs cannot mount through that link, so resolve it, mount the REAL dir at
  // its own path, and reproduce the link on forge. The agent then sees exactly
  // the indirection it sees here.
  const paths: string[] = opts.cwdFrom === 'clone' ? [] : [opts.cwd]
  let memoryLink: { link: string; target: string } | null = null
  if (opts.memoryDir) {
    let target = opts.memoryDir
    try {
      if (lstatSync(opts.memoryDir).isSymbolicLink()) {
        target = realpathSync(opts.memoryDir)
        memoryLink = { link: opts.memoryDir, target }
      }
    } catch { /* not present locally — nothing to mount */ }
    if (existsSync(target)) paths.push(target)
  }

  for (const path of paths) {
    const r = await mountOne(cfg, path)
    if (!r.ok) return { ok: false, reason: `mount ${path}: ${r.reason}`, mounted }
    mounted.push(path)
    log(`[forge] mount ${path}: ${r.reason}`)
  }

  if (memoryLink) {
    const { link, target } = memoryLink
    const r = await forgeExec(cfg, `set -e
      mkdir -p ${JSON.stringify(link.replace(/\/[^/]+$/, ''))}
      [ -L ${JSON.stringify(link)} ] || ln -sfn ${JSON.stringify(target)} ${JSON.stringify(link)}`)
    if (r.code !== 0) return { ok: false, reason: `memory symlink on forge: ${r.stderr.trim()}`, mounted }
    log(`[forge] memory ${link} → ${target} (symlink mirrored)`)
  }

  return { ok: true, reason: `mounted ${mounted.length}`, mounted }
}

/** Where a session's cwd comes from on forge.
 *
 *  A vault project dir is MOUNTED: the box has no copy of the vault. A cwd that
 *  is a code repo, or sits inside one (Console mobile runs from
 *  ~/proj/code/console/android), is already there in the box's own CLONE — and
 *  mounting the desktop's directory over it shadows that part of the clone with
 *  a live tree from another commit. git then reports the difference as
 *  uncommitted changes, the primary checkout is "dirty" for ever, and a prepare
 *  never fast-forwards it again: by 9 Oct 2026 forge's Console checkout was 77
 *  commits behind its own mirror, and every write under android/ there landed in
 *  the desktop's working tree. The vault is a git repo too but is never cloned
 *  onto the box, so it always mounts. */
export type CwdSource = 'mount' | 'clone'

export const VAULT_DIR = '/home/amar/sync/brain'

export function cwdSource(cwd: string, repo: string | null, vault = VAULT_DIR): CwdSource {
  if (!repo) return 'mount'
  const r = repo.replace(/\/+$/, '')
  const c = cwd.replace(/\/+$/, '')
  if (r === vault.replace(/\/+$/, '')) return 'mount'
  return c === r || c.startsWith(`${r}/`) ? 'clone' : 'mount'
}

/** Take down a mount an earlier prepare put over the clone. Lazy when busy, so
 *  a process already standing in it keeps its view until it exits and nothing
 *  running is cut off. Reports whether one was there. */
export async function releaseMountOverClone(cfg: ForgeConfig, path: string): Promise<{ ok: boolean; reason: string }> {
  const q = JSON.stringify(path)
  const r = await forgeExec(cfg, `
    if ! mountpoint -q ${q}; then echo none; exit 0; fi
    fusermount -u ${q} 2>/dev/null || fusermount -uz ${q} || exit 1
    echo released`, { timeoutMs: 30_000 })
  if (r.code !== 0) return { ok: false, reason: r.stderr.trim() || `could not unmount ${path}` }
  return { ok: true, reason: r.stdout.trim() }
}

export async function unmount(cfg: ForgeConfig, path: string): Promise<boolean> {
  const r = await forgeExec(cfg, `fusermount -u ${JSON.stringify(path)} 2>/dev/null || true`, { timeoutMs: 30_000 })
  return r.code === 0
}

/** The auto-memory dir for a cwd: ~/.claude/projects/<encoded-cwd>/memory,
 *  where the encoding is the CLI's (every non-alphanumeric → '-'). The hub
 *  pins the same name per session via CLAUDE_CODE_PROJECT_DIR_NAME. */
export function memoryDirFor(cwd: string, home = '/home/amar'): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return `${home}/.claude/projects/${encoded}/memory`
}
