// ============================================================================
// Live background-process detection for Claude sessions.
//
// Process structure of a running `claude` subprocess (observed):
//   claude
//   ├── uv → blender-mcp            (MCP servers — persistent, NOT user tasks)
//   └── zsh                          (the ONE persistent shell Claude keeps per
//       ├── <bg task>                 session for Bash tool calls)
//       └── <foreground command>      (transient, only while a turn runs)
//
// So: the persistent shell is always a direct child → counting shell children
// of claude is always ≥1 (useless). Real background tasks are *grandchildren*
// under that persistent shell. At idle, those grandchildren ARE the lingering
// background tasks. During an active turn a foreground command also shows up
// transiently — acceptable, since the session is flagged running anyway.
//
// One `ps -eo pid,ppid,comm` snapshot per ~3s builds the tree; callers ask for
// the background count of a given claude PID.
// ============================================================================

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

interface Proc { pid: number; ppid: number; comm: string }
interface Snapshot { takenAt: number; byPid: Map<number, Proc>; childrenOf: Map<number, number[]> }

const TTL_MS = 3_000
const SHELL_COMMS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])

let snapshot: Snapshot | null = null
let inflight: Promise<Snapshot> | null = null

function normComm(comm: string): string {
  return comm.replace(/^.*\//, '').replace(/^-/, '')
}

async function refresh(): Promise<Snapshot> {
  if (inflight) return inflight
  inflight = (async () => {
    const byPid = new Map<number, Proc>()
    const childrenOf = new Map<number, number[]>()
    try {
      const { stdout } = await execFileP('ps', ['-eo', 'pid=,ppid=,comm='], { timeout: 2000 })
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/)
        if (!m) continue
        const pid = parseInt(m[1]!, 10)
        const ppid = parseInt(m[2]!, 10)
        const comm = normComm(m[3]!)
        byPid.set(pid, { pid, ppid, comm })
        const arr = childrenOf.get(ppid) ?? []
        arr.push(pid)
        childrenOf.set(ppid, arr)
      }
    } catch { /* ps unavailable — empty snapshot */ }
    snapshot = { takenAt: Date.now(), byPid, childrenOf }
    return snapshot
  })()
  try { return await inflight } finally { inflight = null }
}

/**
 * Count background processes running under a claude PID — the grandchildren
 * beneath its persistent shell(s). Non-blocking: serves the cached snapshot and
 * kicks off an async refresh when stale.
 */
export function getChildCountSync(claudePid: number | undefined): number {
  if (!claudePid) return 0
  if (!snapshot || Date.now() - snapshot.takenAt > TTL_MS) void refresh()
  const snap = snapshot
  if (!snap) return 0
  let count = 0
  for (const childPid of snap.childrenOf.get(claudePid) ?? []) {
    const child = snap.byPid.get(childPid)
    if (!child || !SHELL_COMMS.has(child.comm)) continue // only the persistent shell(s)
    // Its children (grandchildren of claude) are the actual commands.
    count += (snap.childrenOf.get(childPid) ?? []).length
  }
  return count
}
