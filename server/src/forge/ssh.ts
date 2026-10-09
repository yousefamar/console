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
    return execFailure(err as ExecError, opts.timeoutMs ?? 120_000)
  }
}

type ExecError = { code?: number | string | null; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string; message?: string }

/** Turn an execFile rejection into an ExecResult that always says WHY.
 *
 *  A command the timeout killed rejects with `code: null`, `killed: true` and
 *  whatever stderr it had printed — usually nothing — so "it never answered"
 *  used to come back as exit 1 with an empty reason (the forge sweep logged
 *  `listing failed: ` three times on 9 Oct 2026 and nobody could tell it from
 *  a refusal). Its own stderr still comes first when it has one. */
export function execFailure(e: ExecError, timeoutMs: number): ExecResult {
  const code = typeof e.code === 'number' ? e.code : 1
  const said = (e.stderr ?? '').trim()
  // A plain non-zero exit with nothing on stderr stays empty: callers word that
  // themselves ("sshfs <path> failed"). `e.message` repeats the whole command
  // line, so it is only used when ssh could not be started at all (ENOENT).
  const why = e.killed || e.signal
    ? `no answer within ${Math.round(timeoutMs / 1000)} s (ssh ended by ${e.signal ?? 'the timeout'})`
    : !said && typeof e.code === 'string' ? (e.message ?? e.code) : ''
  return { code, stdout: e.stdout ?? '', stderr: [said, why].filter(Boolean).join('\n') }
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

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** bash, shared by the watchdog below and the reaper (forge/reaper.ts):
 *  `forge_descendants <root> [spare]` prints every live descendant of <root>
 *  by walking ppid, never through <spare>; `forge_kill_tree <root> [spare]
 *  [grace-seconds]` SIGTERMs the root and that tree together, waits, then
 *  SIGKILLs what is left (exit 1 if it had to).
 *
 *  The tree is enumerated BEFORE anything is signalled, because a child whose
 *  parent just died reparents to init and can no longer be found. And it is a
 *  ppid walk on purpose, not a process-group or environment match: it takes
 *  what the agent is running right now (its tool calls, their test runners) and
 *  spares what was deliberately daemonised earlier, such as a dev server left
 *  up for review — the same line a local `kill` draws. */
export const FORGE_TREE_FNS = [
  'forge_descendants() {',
  '  local root="$1" spare="${2:-0}" p pp q',
  '  local -A par=()',
  '  while read -r p pp; do par[$p]=$pp; done < <(ps -e -o pid= -o ppid=)',
  '  for p in "${!par[@]}"; do',
  '    q=$p',
  '    while [[ -n ${par[$q]:-} && $q != "$root" && $q != "$spare" && $q -gt 1 ]]; do q=${par[$q]}; done',
  '    [[ $q == "$root" && $p != "$root" ]] && echo "$p"',
  '  done',
  '  return 0',
  '}',
  // A zombie still answers `kill -0`. It has exited; only its parent has not
  // collected it yet, and waiting out the grace for one would turn every clean
  // SIGTERM into a reported SIGKILL.
  'forge_alive() {',
  '  local s',
  '  read -r s 2>/dev/null < "/proc/$1/stat" || return 1',
  '  [[ ${s##*) } != Z* ]]',
  '}',
  'forge_kill_tree() {',
  '  local root="$1" spare="${2:-0}" grace="${3:-5}" all alive p i',
  '  all="$root $(forge_descendants "$root" "$spare" | tr "\\n" " ")"',
  '  kill -TERM $all 2>/dev/null',
  '  for ((i = 0; i < grace * 10; i++)); do',
  '    alive=""',
  '    for p in $all; do forge_alive "$p" && alive="$alive $p"; done',
  '    [[ -z $alive ]] && return 0',
  '    sleep 0.1',
  '  done',
  '  kill -KILL $alive 2>/dev/null',
  '  return 1',
  '}',
].join('\n')

/** Seconds a remote agent's tree gets between SIGTERM and SIGKILL. */
export const FORGE_KILL_GRACE_S = 5

/** The process that makes a remote agent die with its connection.
 *
 *  Every way the hub stops an agent — interrupt, kill, hibernate, a model,
 *  login or backend respawn, its own shutdown — is a signal to `this.process`,
 *  and for a forge session that process is the local `ssh` client. Killing it
 *  only closes the channel: with no pty sshd signals nothing, so the remote
 *  `claude` just saw stdin reach EOF and, mid-turn, kept working with nobody
 *  attached. Each respawn then added a live twin (9 Oct 2026: two restarts and
 *  two switches in twelve minutes left 3-5 processes per session on the box,
 *  one of which landed a PR; Astera general stopped 38 by hand).
 *
 *  So stdin reaches the agent THROUGH this process. It relays until the
 *  channel closes, then ends the agent's tree. `$1` is the agent's pid — the
 *  wrapper below execs the agent in place, so the watchdog is its child. If it
 *  has been reparented by the time stdin closes, the agent exited by itself and
 *  there is nothing to stop.
 *
 *  It must not print: its stdout IS the agent's stdin. */
const FORGE_WATCHDOG = [
  'cat',
  'exec >/dev/null 2>&1',
  '[[ "$(ps -o ppid= -p $$ | tr -d " ")" == "$1" ]] || exit 0',
  FORGE_TREE_FNS,
  `forge_kill_tree "$1" "$$" ${FORGE_KILL_GRACE_S}`,
].join('\n')

/** Exec the agent with its stdin fed by the watchdog. The watchdog re-execs
 *  under a short argv (`… forge-watchdog <pid>`) so that nothing but the agent
 *  itself carries the agent's command line: anything that finds agents with
 *  `pgrep -f` — the reaper, Astera's own — must see ONE process per session. */
const FORGE_AGENT_WRAPPER = `exec "$@" < <(exec 2>/dev/null; exec bash -c ${shq(FORGE_WATCHDOG)} forge-watchdog "$$")`

/** The argv that runs a command on forge as if it were local, with env ferried
 *  explicitly. SSH does not forward env (SendEnv needs server-side AcceptEnv),
 *  so every variable the hub sets for a session is passed as an `env K=V`
 *  prefix. Quoting is done here, once.
 *
 *  stdin/stdout are clean pipes under `-T`, which is what makes a remote agent
 *  possible at all: the hub speaks stream-json over them and cannot tell the
 *  difference.
 *
 *  `dieWithConnection` is for a long-lived process the hub talks to over stdin
 *  (an agent). Never set it for a command whose stdin is closed up front: EOF
 *  is the signal, so that command would be stopped the moment it started. */
export function remoteCommandArgv(cfg: ForgeConfig, opts: {
  cwd: string
  env?: Record<string, string>
  command: string
  args?: string[]
  dieWithConnection?: boolean
}): string[] {
  const q = shq
  const envPairs = Object.entries(opts.env ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${q(String(v))}`)
  const run = [q(opts.command), ...(opts.args ?? []).map(q)]
  const inner = [
    'cd', q(opts.cwd), '&&',
    // Login-ish env: /etc/profile.d/forge.sh carries the shared warm caches
    // (npm/gradle/cargo/uv on local disk) and the Android SDK paths.
    '.', '/etc/profile.d/forge.sh', '>/dev/null', '2>&1', ';',
    'exec', 'env', ...envPairs,
    ...(opts.dieWithConnection ? ['bash', '-c', q(FORGE_AGENT_WRAPPER), 'forge-agent'] : []),
    ...run,
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
