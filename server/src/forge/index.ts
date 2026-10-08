// forge façade: the one entry point the rest of the hub talks to.
//
// Everything here is written so that FAILURE MEANS LOCAL. No call in this file
// throws into a dispatch path; each returns a verdict the caller downgrades on.
// A sleeping or broken cloud box must never be able to wedge the board.

import { existsSync, realpathSync } from 'node:fs'
import { resolveCheckout } from '../git-status.js'
import { join } from 'node:path'
import { forgeConfig, forgeAvailable, resolvePlacement, boardRemote, type ForgeConfig, type Placement } from './config.js'
import { ensureForgeReady, stopIfIdle, instanceState, ssmPingStatus } from './instance.js'
import { ensureMaster, forwardDevPort, cancelDevPort, forgeExec, remoteCommandArgv, spawnRemote, HUB_PORT } from './ssh.js'
import { ensureSessionMounts, memoryDirFor, isMounted } from './mounts.js'
import { ensureRepoOnForge, foldBackFromForge, ensureConCli, repoNameFor } from './repo.js'
import { syncAgentEnv, syncCliToken } from './agent-env.js'
import { syncTranscript } from './transcripts.js'

export * from './config.js'
export { ensureForgeReady, stopIfIdle, instanceState, ssmPingStatus } from './instance.js'
export { forgeExec, remoteCommandArgv, spawnRemote, forwardDevPort, cancelDevPort, ensureMaster, HUB_PORT, sshEnv as forgeSshEnv } from './ssh.js'
export { foldBackFromForge, ensureRepoOnForge } from './repo.js'
export { syncTranscript, pushTranscript, transcriptPath } from './transcripts.js'
export { moveSessionToForge, worktreesForSession, abandonPendingMoves } from './move.js'
export type { MoveTarget, MoveResult } from './move.js'
export { memoryDirFor } from './mounts.js'

/** Dev-server ports handed to remote sessions. Starts above the desktop's own
 *  5173/5174 so a forwarded port never collides with the local Vite or the
 *  verify SPA — and because each remote fork gets its OWN number, the
 *  long-standing "two forks fight over 5173" failure disappears. */
const DEV_PORT_BASE = 5180
const DEV_PORT_TOP = 5219

const allocatedPorts = new Map<string, number>()
let lastUseAt = Date.now()

export function noteForgeUse(): void {
  lastUseAt = Date.now()
}

export function allocateDevPort(sessionId: string): number | null {
  const existing = allocatedPorts.get(sessionId)
  if (existing) return existing
  const taken = new Set(allocatedPorts.values())
  for (let p = DEV_PORT_BASE; p <= DEV_PORT_TOP; p++) {
    if (!taken.has(p)) {
      allocatedPorts.set(sessionId, p)
      return p
    }
  }
  return null
}

export function releaseDevPort(sessionId: string): number | null {
  const p = allocatedPorts.get(sessionId) ?? null
  allocatedPorts.delete(sessionId)
  return p
}

export function devPortFor(sessionId: string): number | null {
  return allocatedPorts.get(sessionId) ?? null
}

// ---------------------------------------------------------------- readiness
//
// The dispatch callback is SYNCHRONOUS and the card is already stamped by the
// time it runs, so "wait for the box, then dispatch" is not available — a
// deferred dispatch would never be retried. Hence this: readiness is prepared
// AHEAD of dispatch (hub boot, every board change on a forge-enabled board,
// `con forge up`, and after each dispatch for the next one), and the dispatch
// path only ever makes a cheap synchronous check.
//
// The documented consequence: if a card is dispatched while the box is still
// cold, that ONE fork runs locally and says so on the card. It is the right
// trade — the alternative is a board that stalls on a sleeping cloud box.

const preparedCwds = new Map<string, { at: number; devPortFree: boolean }>()
const inFlight = new Map<string, Promise<PrepareResult>>()
/** How long a prepared cwd is trusted without re-checking. Mounts and the repo
 *  sync are both idempotent, so this only bounds how stale the repo copy can
 *  be before the next dispatch refreshes it. */
const PREPARED_TTL_MS = 5 * 60_000

export function isCwdPrepared(cwd: string): boolean {
  const e = preparedCwds.get(cwd)
  return !!e && Date.now() - e.at < PREPARED_TTL_MS
}

export function forgetPreparedCwd(cwd: string): void {
  preparedCwds.delete(cwd)
}

/** Prepare (or refresh) a cwd for remote sessions. Deduplicated: concurrent
 *  callers share one run, so a board that changes five times in a second wakes
 *  the box once. Fire-and-forget safe — never rejects. */
export async function prewarmCwd(cwd: string, log: (m: string) => void = () => {}): Promise<PrepareResult> {
  const running = inFlight.get(cwd)
  if (running) return running
  const run = (async () => {
    const r = await prepareRemoteSession({ sessionId: `prewarm:${cwd}`, cwd, log })
    if (r.ok) {
      preparedCwds.set(cwd, { at: Date.now(), devPortFree: true })
      // The prewarm's own port allocation is not a session's — hand it back.
      releaseDevPort(`prewarm:${cwd}`)
    } else {
      preparedCwds.delete(cwd)
    }
    return r
  })().catch((err: unknown) => ({ ok: false as const, reason: `prewarm threw: ${String(err)}` }))
  inFlight.set(cwd, run)
  try {
    return await run
  } finally {
    inFlight.delete(cwd)
  }
}

export interface PrepareResult {
  ok: boolean
  reason: string
  /** The port a remote session should run its dev server on, already forwarded
   *  back to the same port on the desktop. */
  devPort?: number
  cfg?: ForgeConfig
}

/** The code repo behind a session cwd.
 *
 *  Uses the hub's own resolveCheckout rather than looking for `<cwd>/repo`:
 *  the link is NOT always called `repo` — Astera's project dir links its
 *  checkout as `app` (→ ~/proj/code/astera-app), and a `repo`-only lookup
 *  silently returned null for it, which would have put an Astera fork on forge
 *  with no checkout at all. resolveCheckout tries `.git`, then `repo`, then any
 *  symlink in the dir containing a `.git`.
 *
 *  Returns null when the cwd has no code repo (a docs-only project dir), which
 *  is a legitimate case — such a fork needs no repo synced. */
export async function repoForCwd(cwd: string): Promise<string | null> {
  const dir = await resolveCheckout(cwd)
  if (dir === cwd && !existsSync(join(cwd, '.git'))) return null
  try { return realpathSync(dir) } catch { return null }
}

/** Everything that must be true before a remote `claude` is spawned for `cwd`.
 *
 *  Ordered so the cheap local checks fail first and the box is only woken once
 *  we know we want it. Each step's failure is reported verbatim to the caller,
 *  which puts it on the card — "it ran locally" must always come with why. */
export async function prepareRemoteSession(opts: {
  sessionId: string
  cwd: string
  log?: (m: string) => void
}): Promise<PrepareResult> {
  const log = opts.log ?? (() => {})
  const cfg = forgeConfig()
  if (!cfg) return { ok: false, reason: 'no forge configured (~/.config/console/forge.json)' }

  if (!(await ensureForgeReady(cfg, log))) {
    // Say WHICH kind of unreachable. A running box whose SSM agent has not
    // registered refuses ssh identically to one that is still booting, and the
    // two want opposite responses: re-fire the card, or wait.
    const [state, ping] = await Promise.all([instanceState(cfg), ssmPingStatus(cfg)])
    const detail = state === 'running' && ping !== 'Online'
      ? `the box is RUNNING but its SSM agent has not registered (ping: ${ping}) — this is a box fault, not a card fault; re-fire the card`
      : `instance state ${state}, SSM ping ${ping}`
    return { ok: false, reason: `forge did not become reachable — ${detail}`, cfg }
  }
  noteForgeUse()

  const env = await syncAgentEnv(cfg, log)
  if (!env.ok) return { ok: false, reason: env.reason, cfg }

  const tok = await syncCliToken(cfg)
  if (!tok.ok) return { ok: false, reason: tok.reason, cfg }

  const mounts = await ensureSessionMounts(cfg, { cwd: opts.cwd, memoryDir: memoryDirFor(opts.cwd) }, log)
  if (!mounts.ok) return { ok: false, reason: mounts.reason, cfg }

  const repo = await repoForCwd(opts.cwd)
  if (repo) {
    const synced = await ensureRepoOnForge(cfg, repo, log)
    if (!synced.ok) return { ok: false, reason: synced.reason, cfg }
    // The CLI comes from the Console checkout; a non-Console project still
    // needs `con`, so ensure it whenever Console happens to be synced.
    if (repoNameFor(repo) === 'console') {
      const cli = await ensureConCli(cfg)
      if (!cli.ok) log(`[forge] ${cli.reason}`)
    }
  }

  const devPort = allocateDevPort(opts.sessionId)
  if (devPort) {
    const forwarded = await forwardDevPort(cfg, devPort)
    if (!forwarded) log(`[forge] could not forward dev port ${devPort} — the agent can still work, its dev server just will not reach localhost`)
  }

  return { ok: true, reason: 'forge ready', devPort: devPort ?? undefined, cfg }
}

/** Tear down a remote session's per-session resources. Mounts are left in
 *  place deliberately: they are per-cwd, cheap, and shared by sibling forks. */
export async function releaseRemoteSession(sessionId: string, log: (m: string) => void = () => {}): Promise<void> {
  const cfg = forgeConfig()
  const port = releaseDevPort(sessionId)
  if (cfg && port) {
    await cancelDevPort(cfg, port)
    log(`[forge] released dev port ${port}`)
  }
}

/** A remote GitRunner for kanban/winddown.ts — the wind-down logic is already
 *  parameterised over how it runs git, so pointing it at forge needs no change
 *  to its decision-making at all. */
export function remoteGitRunner(cfg: ForgeConfig) {
  return async (args: string[], cwd: string): Promise<{ stdout: string; ok: boolean }> => {
    const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
    const r = await forgeExec(cfg, `git -C '${cwd.replace(/'/g, `'\\''`)}' ${quoted}`)
    return { stdout: r.stdout, ok: r.code === 0 }
  }
}

/** Remote existsSync, for wind-down's `<cwd>/repo` probe. */
export function remoteExists(cfg: ForgeConfig) {
  return async (path: string): Promise<boolean> => {
    const r = await forgeExec(cfg, `test -e '${path.replace(/'/g, `'\\''`)}' && echo yes || echo no`, { timeoutMs: 30_000 })
    return r.stdout.trim() === 'yes'
  }
}

/** The SYNCHRONOUS decision the dispatch path makes.
 *
 *  Wanting forge is not enough — the box has to be prepared for this cwd
 *  already (see the readiness note above). When it is not, the answer is
 *  `defer`: the caller creates the session WITHOUT a process, prewarms, and
 *  spawns on forge when the box is up (Session.startDeferred). Local stays the
 *  fallback, but only for a forge that genuinely FAILED — not for one that was
 *  merely asleep, which used to send every first card of the day local ("this
 *  once", five times a day: ^warm-hare, ^warm-kiwi, ^busy-goat, ^loud-pony,
 *  ^zany-fox on 7 Oct 2026, all of them waking the box for nothing). */
export function decidePlacement(opts: {
  cwd: string
  cardRemote?: Placement | null
  boardRemote?: Placement | null
  /** Tests only — production reads ~/.config/console/forge.json. */
  available?: boolean
}): { placement: Placement; reason: string; defer?: boolean } {
  const wanted = resolvePlacement({ cardRemote: opts.cardRemote, boardRemote: opts.boardRemote, available: opts.available })
  if (wanted.placement === 'local') return wanted
  if (!isCwdPrepared(opts.cwd)) {
    return { placement: 'forge', reason: 'forge requested and the box is cold — holding the spawn until it is ready', defer: true }
  }
  return wanted
}

export { forgeAvailable, resolvePlacement, boardRemote, isMounted, stopIfIdleWrapper as stopForgeIfIdle }
export type { Placement }

async function stopIfIdleWrapper(liveRemoteSessions: number, log: (m: string) => void = () => {}, opts: { force?: boolean } = {}): Promise<boolean> {
  const cfg = forgeConfig()
  if (!cfg) return false
  // `force` is the manual `con agent forge down`: skip the idle window, but
  // still honour the live-session check in stopIfIdle.
  return stopIfIdle(cfg, liveRemoteSessions, opts.force ? 0 : lastUseAt, log)
}

/** Every cwd the hub currently believes is warm (status view). */
export function preparedCwdList(): string[] {
  return [...preparedCwds.keys()].filter((c) => isCwdPrepared(c))
}

export { FORGE_CONFIG_FILE as forgeConfigFile } from './config.js'
