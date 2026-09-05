// Stale `claude` process reaper.
//
// INCIDENT 2026-09-04 ~19:05: a hub restart resumed every session while the
// previous hub's `claude` children were still alive. pm2 restarts the tree
// with SIGINT — which the CLI treats as "interrupt the turn", not "exit" — and
// the old hub's shutdown() SIGTERMed its children then process.exit()ed in the
// same tick, so anything that didn't die instantly reparented to init with a
// dead stdio pipe and a LIVE tool loop. Each fork then had two processes
// executing the same "Continue" in the same worktree; one twin rewrote files
// under the other.
//
// Three defences, all here:
//   • reapStaleProcesses()  — before the restore loop spawns anything, find
//     the dead generation's children and SIGTERM → grace → SIGKILL them.
//   • StaleProcessSweeper   — a timer belt: any stale twin older than a minute
//     gets SIGTERM on first sighting, SIGKILL on the next.
//   • shutdown (index.ts)   — SIGTERM children, wait ≤1 s, SIGKILL survivors
//     BEFORE exiting, so nothing reparents alive (Session.terminateForShutdown).
//
// How a stale twin is recognised (classifyStale — pure, unit-tested):
//   1. It is a hub-spawned claude: argv names `claude` and carries the hub's
//      stdio signature `--input-format stream-json`. An interactive
//      `claude --resume <csid>` Yousef runs in a terminal has no such flag and
//      is never touched.
//   2. It is NOT our child (ppid !== process.pid) — our own live children,
//      including one mid-hibernation-kill, are ours to manage.
//   3. Either its env carries `CONSOLE_HUB_PID` (every spawn since this module
//      landed) naming a pid that isn't us — a previous hub generation — or,
//      for processes spawned before the marker existed, its `--resume <csid>`
//      names a session we own. NB a fork's process resumes its PARENT's csid
//      (`--resume <parent> --fork-session`), which is also ours.
//
// Linux-only by design (reads /proc); the hub runs nowhere else.

import { readdirSync, readFileSync } from 'node:fs'

export interface ProcInfo {
  pid: number
  ppid: number
  args: string[]
  /** null when /proc/<pid>/environ was unreadable (other uid, gone). */
  env: Record<string, string> | null
  /** Wall-clock age; from /proc/<pid>/stat starttime. */
  ageMs: number
}

export const HUB_PID_ENV = 'CONSOLE_HUB_PID'

export type StaleReason = 'hub-marker' | 'resume-match'

export interface ClassifyOpts {
  ownPid: number
  /** Every claudeSessionId the hub owns (manifest + live, incl. fork parents). */
  ownedCsids: ReadonlySet<string>
}

function basename(p: string): string {
  return p.replace(/^.*\//, '')
}

/** argv names the claude CLI: `claude …` or `node …/claude …` (shebang case). */
export function isClaudeArgv(args: string[]): boolean {
  return args.slice(0, 2).some((a) => basename(a) === 'claude')
}

/** The hub's stdio transport flag — interactive terminal sessions never set it. */
export function hasHubSignature(args: string[]): boolean {
  const i = args.indexOf('--input-format')
  return i >= 0 && args[i + 1] === 'stream-json'
}

export function resumeTarget(args: string[]): string | null {
  const i = args.indexOf('--resume')
  return i >= 0 && args[i + 1] ? args[i + 1]! : null
}

/** Why `p` is a stale hub child, or null if it is not one. */
export function classifyStale(p: ProcInfo, opts: ClassifyOpts): StaleReason | null {
  if (p.pid === opts.ownPid || p.ppid === opts.ownPid) return null
  if (!isClaudeArgv(p.args) || !hasHubSignature(p.args)) return null
  const marker = p.env?.[HUB_PID_ENV]
  if (marker !== undefined) return marker !== String(opts.ownPid) ? 'hub-marker' : null
  const csid = resumeTarget(p.args)
  return csid && opts.ownedCsids.has(csid) ? 'resume-match' : null
}

export function findStaleProcesses(procs: ProcInfo[], opts: ClassifyOpts): Array<{ proc: ProcInfo; reason: StaleReason }> {
  const out: Array<{ proc: ProcInfo; reason: StaleReason }> = []
  for (const proc of procs) {
    const reason = classifyStale(proc, opts)
    if (reason) out.push({ proc, reason })
  }
  return out
}

// ---------------------------------------------------------------------------
// /proc reader
// ---------------------------------------------------------------------------

const CLK_TCK = 100

function readUptimeMs(): number {
  try {
    return Math.round(parseFloat(readFileSync('/proc/uptime', 'utf8').split(' ')[0]!) * 1000)
  } catch {
    return 0
  }
}

function readProc(pid: number, uptimeMs: number): ProcInfo | null {
  let stat: string
  let cmdline: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    return null
  }
  // comm may contain spaces/parens — split after the LAST ')'.
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const ppid = parseInt(rest[1]!, 10)
  const startTicks = parseInt(rest[19]!, 10)
  const ageMs = Number.isFinite(startTicks) ? Math.max(0, uptimeMs - (startTicks / CLK_TCK) * 1000) : 0
  const args = cmdline.split('\0').filter((a, i, arr) => !(i === arr.length - 1 && a === ''))
  let env: Record<string, string> | null = null
  try {
    env = {}
    for (const kv of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const eq = kv.indexOf('=')
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1)
    }
  } catch {
    env = null
  }
  return { pid, ppid: Number.isFinite(ppid) ? ppid : 0, args, env, ageMs }
}

/** Every visible process whose argv looks like the claude CLI. Cheap enough
 *  to run every minute: cmdline is read for all pids, environ only for claude. */
export function listClaudeProcesses(): ProcInfo[] {
  const uptimeMs = readUptimeMs()
  const out: ProcInfo[] = []
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return out
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const pid = parseInt(name, 10)
    let cmdline: string
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    } catch {
      continue
    }
    if (!isClaudeArgv(cmdline.split('\0'))) continue
    const info = readProc(pid, uptimeMs)
    if (info) out.push(info)
  }
  return out
}

// ---------------------------------------------------------------------------
// Killing
// ---------------------------------------------------------------------------

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig)
    return true
  } catch {
    return false
  }
}

/** Resolve with the pids still alive once every pid is gone or `graceMs` elapsed. */
export async function waitForExit(pids: number[], graceMs: number, pollMs = 50): Promise<number[]> {
  const deadline = Date.now() + graceMs
  let alive = pids.filter(isAlive)
  while (alive.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs))
    alive = alive.filter(isAlive)
  }
  return alive
}

/** SIGTERM `pids`, wait up to `graceMs`, SIGKILL whatever is left. Returns the
 *  pids that needed SIGKILL. */
export async function terminateAll(pids: number[], graceMs: number): Promise<number[]> {
  for (const pid of pids) signal(pid, 'SIGTERM')
  const survivors = await waitForExit(pids, graceMs)
  for (const pid of survivors) signal(pid, 'SIGKILL')
  return survivors
}

export interface ReapResult {
  reaped: Array<{ pid: number; reason: StaleReason; resume: string | null; killed: boolean }>
}

/** Boot-time reap: find the dead generation's children and end them BEFORE
 *  anything is resumed. Awaited by the restore loop so no twin is spawned
 *  while its predecessor still holds the transcript. */
export async function reapStaleProcesses(opts: ClassifyOpts & { graceMs?: number; list?: () => ProcInfo[] }): Promise<ReapResult> {
  const stale = findStaleProcesses((opts.list ?? listClaudeProcesses)(), opts)
  if (!stale.length) return { reaped: [] }
  const killed = new Set(await terminateAll(stale.map((s) => s.proc.pid), opts.graceMs ?? 2_000))
  return {
    reaped: stale.map((s) => ({ pid: s.proc.pid, reason: s.reason, resume: resumeTarget(s.proc.args), killed: killed.has(s.proc.pid) })),
  }
}

/** Periodic belt: stale twins older than `minAgeMs` get SIGTERM on first
 *  sighting and SIGKILL if still there next tick. Age-gated so a process the
 *  boot reap is mid-way through terminating isn't double-handled. */
export class StaleProcessSweeper {
  private timer: ReturnType<typeof setInterval> | null = null
  private termed = new Set<number>()

  constructor(private opts: {
    ownPid: number
    ownedCsids: () => ReadonlySet<string>
    log: (msg: string) => void
    intervalMs?: number
    minAgeMs?: number
    list?: () => ProcInfo[]
    kill?: (pid: number, sig: NodeJS.Signals) => boolean
  }) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sweep(), this.opts.intervalMs ?? 60_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass; returns what it signalled (for tests + logs). */
  sweep(): Array<{ pid: number; sig: NodeJS.Signals; reason: StaleReason }> {
    const minAge = this.opts.minAgeMs ?? 60_000
    const kill = this.opts.kill ?? signal
    const stale = findStaleProcesses((this.opts.list ?? listClaudeProcesses)(), { ownPid: this.opts.ownPid, ownedCsids: this.opts.ownedCsids() })
    const acted: Array<{ pid: number; sig: NodeJS.Signals; reason: StaleReason }> = []
    const seen = new Set<number>()
    for (const { proc, reason } of stale) {
      if (proc.ageMs < minAge) continue
      seen.add(proc.pid)
      const sig: NodeJS.Signals = this.termed.has(proc.pid) ? 'SIGKILL' : 'SIGTERM'
      if (kill(proc.pid, sig)) {
        acted.push({ pid: proc.pid, sig, reason })
        this.opts.log(`[reaper] ${sig} stale claude pid ${proc.pid} (${reason}${resumeTarget(proc.args) ? `, resume ${resumeTarget(proc.args)!.slice(0, 8)}` : ''}, ppid ${proc.ppid}, age ${Math.round(proc.ageMs / 1000)}s)`)
      }
      this.termed.add(proc.pid)
    }
    // Forget pids that are gone (or no longer stale) so a recycled pid isn't SIGKILLed on sight.
    for (const pid of this.termed) if (!seen.has(pid)) this.termed.delete(pid)
    return acted
  }
}
