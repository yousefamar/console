// ============================================================================
// Live background-process detection for Claude sessions.
//
// Process structure of a running `claude` subprocess (observed):
//   claude
//   ├── uv → blender-mcp            (MCP servers — persistent, NOT user tasks)
//   └── zsh                          (shell wrapper per Bash tool call)
//       ├── <bg task>                (run_in_background — outlives the turn)
//       └── <foreground command>     (transient, only while a turn runs)
//
// Counting shell children of claude is useless (≥1 whenever any command runs);
// the real tasks are *grandchildren* under the shell wrappers. At idle, those
// grandchildren ARE the lingering background tasks. During an active turn a
// foreground command also shows up transiently — acceptable, since the session
// is flagged running anyway.
//
// A 3s interval keeps one shared `ps -eo pid,ppid,comm` snapshot fresh. The
// old design refreshed lazily AFTER serving the stale snapshot, so with the
// sidebar's 10s poll the badge lagged 10-20s behind reality and could serve a
// pre-launch view; and a failed ps call wiped the snapshot to empty (count 0
// for every session until the next refresh). Interval + keep-last-good fixes
// both flap paths.
// ============================================================================

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

interface Proc { pid: number; ppid: number; comm: string }
interface Snapshot { takenAt: number; byPid: Map<number, Proc>; childrenOf: Map<number, number[]> }

const REFRESH_MS = 3_000
const SHELL_COMMS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])

let snapshot: Snapshot | null = null
let inflight: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | null = null

function normComm(comm: string): string {
  return comm.replace(/^.*\//, '').replace(/^-/, '')
}

async function refresh(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const { stdout } = await execFileP('ps', ['-eo', 'pid=,ppid=,comm='], { timeout: 2000 })
      const byPid = new Map<number, Proc>()
      const childrenOf = new Map<number, number[]>()
      for (const line of stdout.split('\n')) {
        // comm can contain spaces ("npm exec chrome") — greedy tail, not \S+.
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
        if (!m) continue
        const pid = parseInt(m[1]!, 10)
        const ppid = parseInt(m[2]!, 10)
        const comm = normComm(m[3]!.trim())
        byPid.set(pid, { pid, ppid, comm })
        const arr = childrenOf.get(ppid) ?? []
        arr.push(pid)
        childrenOf.set(ppid, arr)
      }
      snapshot = { takenAt: Date.now(), byPid, childrenOf }
    } catch { /* ps hiccup — keep the last good snapshot rather than blanking */ }
  })()
  try { return await inflight } finally { inflight = null }
}

function ensureFresh(): void {
  if (!timer) {
    timer = setInterval(() => { void refresh() }, REFRESH_MS)
    timer.unref?.()
  }
  if (!snapshot) void refresh()
}

/** Count background processes running under a claude PID — the grandchildren
 *  beneath its shell wrappers. Non-blocking: serves the shared
 *  interval-refreshed snapshot (≤3s stale). */
export function getChildCountSync(claudePid: number | undefined): number {
  if (!claudePid) return 0
  ensureFresh()
  const snap = snapshot
  if (!snap) return 0
  let count = 0
  for (const childPid of snap.childrenOf.get(claudePid) ?? []) {
    const child = snap.byPid.get(childPid)
    if (!child || !SHELL_COMMS.has(child.comm)) continue // only shell wrappers
    count += (snap.childrenOf.get(childPid) ?? []).length
  }
  return count
}
