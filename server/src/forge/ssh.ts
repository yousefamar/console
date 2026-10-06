// forge transport: one multiplexed SSH connection per box, carried over SSM.
//
// There is no inbound port on forge at all — its security group has zero
// ingress rules and ~/.ssh/config routes the stream through
// `aws ssm start-session` (scripts/forge/ssm-proxy.sh). Everything else here is
// ordinary OpenSSH: `-L` brings a remote dev server back to the desktop's
// localhost, `-R` pushes the hub and the desktop's sshd out to forge, and
// `ssh -O forward` adds either to the LIVE master without reconnecting.

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import type { ForgeConfig } from './config.js'

const execFileP = promisify(execFile)

/** The hub's own HTTPS port, reverse-forwarded so a remote fork's `con` finds
 *  the hub at the same localhost:9877 it uses on the desktop — the CLI needs
 *  no config beyond its bearer token (cli/src/client.ts defaults here and
 *  already sets rejectUnauthorized:false for the self-signed cert). */
export const HUB_PORT = 9877
/** The desktop's sshd, reverse-forwarded so forge can sshfs-mount the vault
 *  project dir and the auto-memory dir back off the desktop. Keeps forge
 *  holding NO copy of the vault. */
export const DESKTOP_SSH_PORT = 2222

/** PATH for every ssh we spawn: the hub runs under pm2 with a minimal PATH and
 *  the ProxyCommand needs session-manager-plugin (~/.local/bin, installed
 *  without root) plus `aws`. */
export function sshEnv(): NodeJS.ProcessEnv {
  const extra = [`${homedir()}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin']
  const current = (process.env.PATH ?? '').split(':')
  const merged = [...new Set([...extra, ...current])].filter(Boolean)
  return { ...process.env, PATH: merged.join(':') }
}

export interface ExecResult { code: number; stdout: string; stderr: string }

/** Run a command on forge. Never throws on a non-zero exit — callers branch on
 *  `code`, because "forge said no" is a routine outcome that must downgrade to
 *  local rather than crash a dispatch. */
export async function forgeExec(cfg: ForgeConfig, command: string, opts: { timeoutMs?: number; input?: string } = {}): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileP('ssh', ['-o', 'BatchMode=yes', cfg.host, command], {
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: sshEnv(),
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' }
  }
}

/** Is the multiplexed master alive? */
export async function masterAlive(cfg: ForgeConfig): Promise<boolean> {
  const r = await execFileP('ssh', ['-O', 'check', cfg.host], { env: sshEnv(), timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  return r
}

/** Bring up the master connection with the two box-level reverse forwards.
 *  Idempotent: a live master is reused. Returns false when forge cannot be
 *  reached at all (caller routes the fork locally). */
export async function ensureMaster(cfg: ForgeConfig, log: (m: string) => void = () => {}): Promise<boolean> {
  if (await masterAlive(cfg)) return true
  log(`[forge] opening master connection to ${cfg.host} (${cfg.instanceId})`)
  const args = [
    '-M', '-N', '-f',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', `${HUB_PORT}:127.0.0.1:${HUB_PORT}`,
    '-R', `${DESKTOP_SSH_PORT}:127.0.0.1:22`,
    cfg.host,
  ]
  try {
    await execFileP('ssh', args, { env: sshEnv(), timeout: 120_000 })
  } catch (err) {
    log(`[forge] master connection failed: ${(err as Error).message}`)
    return false
  }
  const ok = await masterAlive(cfg)
  log(`[forge] master ${ok ? 'up' : 'did not come up'}`)
  return ok
}

export async function closeMaster(cfg: ForgeConfig): Promise<void> {
  await execFileP('ssh', ['-O', 'exit', cfg.host], { env: sshEnv(), timeout: 15_000 }).catch(() => {})
}

/** Add/remove a forward on the live master. `-L` = a forge port appears on the
 *  desktop's localhost (dev servers); `-R` = a desktop port appears on forge. */
export async function setForward(cfg: ForgeConfig, dir: 'L' | 'R', spec: string, action: 'forward' | 'cancel' = 'forward'): Promise<boolean> {
  return execFileP('ssh', ['-O', action, `-${dir}`, spec, cfg.host], { env: sshEnv(), timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
}

/** Bring a remote dev-server port back to the same port on the desktop, so
 *  `http://localhost:<port>` is the remote Vite — HMR websocket included. */
export async function forwardDevPort(cfg: ForgeConfig, port: number): Promise<boolean> {
  return setForward(cfg, 'L', `${port}:127.0.0.1:${port}`, 'forward')
}

export async function cancelDevPort(cfg: ForgeConfig, port: number): Promise<boolean> {
  return setForward(cfg, 'L', `${port}:127.0.0.1:${port}`, 'cancel')
}

/** The argv that runs a command on forge as if it were local, with env ferried
 *  explicitly. SSH does not forward env (SendEnv needs server-side AcceptEnv),
 *  so every variable the hub sets for a session is passed as an `env K=V`
 *  prefix. Quoting is done here, once.
 *
 *  stdin/stdout are clean pipes under `-T`, which is what makes a remote agent
 *  possible at all: the hub speaks stream-json over them and cannot tell the
 *  difference. */
export function remoteCommandArgv(cfg: ForgeConfig, opts: {
  cwd: string
  env?: Record<string, string>
  command: string
  args?: string[]
}): string[] {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const envPairs = Object.entries(opts.env ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${q(String(v))}`)
  const inner = [
    'cd', q(opts.cwd), '&&',
    // Login-ish env: /etc/profile.d/forge.sh carries the shared warm caches
    // (npm/gradle/cargo/uv on local disk) and the Android SDK paths.
    '.', '/etc/profile.d/forge.sh', '>/dev/null', '2>&1', ';',
    'exec', 'env', ...envPairs, q(opts.command), ...(opts.args ?? []).map(q),
  ].join(' ')
  return ['-T', '-o', 'BatchMode=yes', cfg.host, inner]
}

/** Spawn a long-lived remote process with piped stdio (the agent path). */
export function spawnRemote(cfg: ForgeConfig, opts: { cwd: string; env?: Record<string, string>; command: string; args?: string[] }) {
  return spawn('ssh', remoteCommandArgv(cfg, opts), { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnv() })
}

/** Copy a file up (used for the CLI bearer and small config). */
export async function forgePut(cfg: ForgeConfig, localPath: string, remotePath: string): Promise<boolean> {
  return execFileP('scp', ['-q', '-o', 'BatchMode=yes', localPath, `${cfg.host}:${remotePath}`], { env: sshEnv(), timeout: 120_000 })
    .then(() => true)
    .catch(() => false)
}

/** Pull a file down (used for transcript sync-back). */
export async function forgeGet(cfg: ForgeConfig, remotePath: string, localPath: string): Promise<boolean> {
  return execFileP('rsync', ['-az', '-e', 'ssh -o BatchMode=yes', `${cfg.host}:${remotePath}`, localPath], { env: sshEnv(), timeout: 300_000 })
    .then(() => true)
    .catch(() => false)
}
