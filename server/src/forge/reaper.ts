// Stale `claude` processes on forge — the box's half of agents/process-reaper.ts.
//
// The local reaper reads /proc on this machine, so a remote agent was invisible
// to all three of its defences. INCIDENT 2026-10-09 ~02:20: two hub restarts, a
// login switch and a backend switch inside twelve minutes each started a new
// remote process per forge session and stopped none, because every stop is a
// signal to the local ssh client (see the watchdog in ssh.ts). The box held 3-5
// live copies of each session; stale ones re-sent messages, wrote duplicate card
// notes and one landed a PR. Astera general stopped 38 by hand.
//
// Two defences here, mirroring the local ones (the third is the watchdog):
//   • boot reap  — before the restore loop respawns anything, end every agent
//     on the box that a previous hub generation started.
//   • sweep belt — the same on a timer, plus copies of one session started by
//     THIS hub that a newer copy has superseded (the watchdog's safety net).
//
// The judgement is the local reaper's, on a listing fetched over ssh: an agent
// is hub-spawned if its argv is the claude CLI with the stream-json signature,
// and every one of those carries `CONSOLE_HUB_PID` because the hub ferries its
// session env across. An UNMARKED process on the box is never judged — unlike
// the desktop there is no pre-marker population there, so unmarked means
// somebody started it by hand.

import { hasHubSignature, isClaudeArgv, HUB_PID_ENV, type ProcInfo } from '../agents/process-reaper.js'
import type { ForgeConfig } from './config.js'
import { forgeExec, FORGE_TREE_FNS, FORGE_KILL_GRACE_S, type ExecResult } from './ssh.js'

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

const CSID_ENV = 'CONSOLE_CLAUDE_SESSION_ID'
const AGENT_KEY_ENV = 'CONSOLE_AGENT_KEY'

/** bash: one record per claude-looking process. argv travels base64'd because
 *  it is NUL-separated and may hold anything; only the three env keys the
 *  judgement needs leave the box. `END` proves the listing was not cut short. */
export const FORGE_LIST_SCRIPT = [
  'for d in /proc/[0-9]*; do',
  '  pid=${d#/proc/}',
  '  a0=; a1=',
  '  { IFS= read -r -d "" a0; IFS= read -r -d "" a1; } 2>/dev/null < "$d/cmdline"',
  '  [[ ${a0##*/} == claude || ${a1##*/} == claude ]] || continue',
  '  st=$(ps -o ppid= -o etimes= -p "$pid" 2>/dev/null) || continue',
  '  echo "P $pid $st"',
  '  echo "A $(base64 -w0 "$d/cmdline" 2>/dev/null)"',
  '  while IFS= read -r -d "" kv; do',
  `    case "$kv" in ${HUB_PID_ENV}=*|${CSID_ENV}=*|${AGENT_KEY_ENV}=*) echo "E $kv";; esac`,
  '  done 2>/dev/null < "$d/environ"',
  'done',
  'echo END',
].join('\n')

/** bash: `forge-reap <grace> <pid>:<marker>…`. Each target is re-checked against
 *  the marker it was judged by — the pid may have exited or been reused since
 *  the listing — then its tree is ended. Targets run in parallel so forty of
 *  them cost one grace period, not forty. */
export const FORGE_REAP_SCRIPT = [
  FORGE_TREE_FNS,
  'grace="$1"; shift',
  'for t in "$@"; do',
  '  (',
  '    pid=${t%%:*}; marker=${t#*:}; d=/proc/$pid',
  `    cur=$(tr "\\0" "\\n" 2>/dev/null < "$d/environ" | sed -n "s/^${HUB_PID_ENV}=//p" | head -1)`,
  '    if [[ ! -d $d || $cur != "$marker" ]]; then echo "R $pid gone 0"; exit 0; fi',
  '    n=$(forge_descendants "$pid" 0 | wc -l)',
  '    if forge_kill_tree "$pid" 0 "$grace"; then echo "R $pid term $n"; else echo "R $pid kill $n"; fi',
  '  ) &',
  'done',
  'wait',
].join('\n')

/** Parse FORGE_LIST_SCRIPT output. `complete` is false when `END` never came —
 *  a cut-short listing can only make the reaper do LESS, but say so. */
export function parseForgeProcs(stdout: string): { procs: ProcInfo[]; complete: boolean } {
  const procs: ProcInfo[] = []
  let cur: ProcInfo | null = null
  let complete = false
  for (const line of stdout.split('\n')) {
    if (line === 'END') { complete = true; continue }
    const tag = line.slice(0, 2)
    const rest = line.slice(2)
    if (tag === 'P ') {
      const [pid, ppid, etimes] = rest.trim().split(/\s+/).map((n) => parseInt(n, 10))
      cur = null
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      cur = { pid: pid!, ppid: ppid!, args: [], env: {}, ageMs: Number.isFinite(etimes) ? etimes! * 1000 : 0 }
      procs.push(cur)
    } else if (tag === 'A ' && cur) {
      const args = Buffer.from(rest.trim(), 'base64').toString('utf8').split('\0')
      if (args.length && args[args.length - 1] === '') args.pop()
      cur.args = args
    } else if (tag === 'E ' && cur) {
      const eq = rest.indexOf('=')
      if (eq > 0) cur.env![rest.slice(0, eq)] = rest.slice(eq + 1)
    }
  }
  return { procs, complete }
}

export type ForgeStaleReason = 'hub-marker' | 'superseded'

/** Which remote agents are stale. Pure.
 *
 *  `hub-marker`: started by a hub that is not this one.
 *  `superseded`: started by this hub, but a NEWER copy of the same session is
 *  running too. Only judged when `supersededMinAgeMs` is given, and only once
 *  the newest copy is itself that old — a respawn in progress has both alive
 *  for the few seconds the watchdog takes, and that is not a twin. */
export function findForgeStale(procs: ProcInfo[], opts: { ownPid: number; supersededMinAgeMs?: number }): Array<{ proc: ProcInfo; reason: ForgeStaleReason }> {
  const out: Array<{ proc: ProcInfo; reason: ForgeStaleReason }> = []
  const ours = new Map<string, ProcInfo[]>()
  for (const proc of procs) {
    if (!isClaudeArgv(proc.args) || !hasHubSignature(proc.args)) continue
    const marker = proc.env?.[HUB_PID_ENV]
    if (!marker) continue
    if (marker !== String(opts.ownPid)) { out.push({ proc, reason: 'hub-marker' }); continue }
    const csid = proc.env?.[CSID_ENV]
    if (!csid) continue
    const group = ours.get(csid)
    if (group) group.push(proc)
    else ours.set(csid, [proc])
  }
  if (opts.supersededMinAgeMs !== undefined) {
    for (const group of ours.values()) {
      if (group.length < 2) continue
      // Youngest first; equal ages fall back to the higher pid as the newer one.
      group.sort((a, b) => a.ageMs - b.ageMs || b.pid - a.pid)
      if (group[0]!.ageMs < opts.supersededMinAgeMs) continue
      for (const proc of group.slice(1)) out.push({ proc, reason: 'superseded' })
    }
  }
  return out
}

export interface ForgeReaped {
  pid: number
  reason: ForgeStaleReason
  csid: string | null
  agentKey: string | null
  ageS: number
  /** Live descendants that went with it (tool calls, test runners, dev servers). */
  children: number
  /** `term` = ended on SIGTERM, `kill` = needed SIGKILL, `gone` = already exited. */
  outcome: 'term' | 'kill' | 'gone'
}

export interface ForgeReapResult { ok: boolean; reason?: string; live: number; reaped: ForgeReaped[] }

type Exec = (cfg: ForgeConfig, command: string, opts?: { timeoutMs?: number }) => Promise<ExecResult>

/** List the box's agents, judge them, end the stale ones' trees. Never throws:
 *  an unreachable box is `ok: false` and nothing else. */
export async function reapForgeStale(cfg: ForgeConfig, opts: {
  ownPid: number
  supersededMinAgeMs?: number
  /** List and judge only: `reaped` then holds the CANDIDATES, and their
   *  `outcome`/`children` are placeholders, not something that happened. */
  dryRun?: boolean
  exec?: Exec
}): Promise<ForgeReapResult> {
  const exec = opts.exec ?? forgeExec
  const listed = await exec(cfg, `bash -c ${shq(FORGE_LIST_SCRIPT)} forge-list`, { timeoutMs: 25_000 })
  if (listed.code !== 0) return { ok: false, reason: `listing failed: ${listed.stderr.trim().split('\n').pop() ?? `exit ${listed.code}`}`, live: 0, reaped: [] }
  const { procs, complete } = parseForgeProcs(listed.stdout)
  const stale = findForgeStale(procs, opts)
  const live = procs.filter((p) => isClaudeArgv(p.args) && hasHubSignature(p.args)).length - stale.length
  const describe = (s: { proc: ProcInfo; reason: ForgeStaleReason }, outcome: ForgeReaped['outcome'], children: number): ForgeReaped => ({
    pid: s.proc.pid, reason: s.reason, outcome, children,
    csid: s.proc.env?.[CSID_ENV] ?? null, agentKey: s.proc.env?.[AGENT_KEY_ENV] ?? null, ageS: Math.round(s.proc.ageMs / 1000),
  })
  const note = complete ? undefined : 'listing was cut short — judged only what arrived'
  if (!stale.length || opts.dryRun) return { ok: true, reason: note, live, reaped: stale.map((s) => describe(s, 'gone', 0)) }

  const targets = stale.map((s) => `${s.proc.pid}:${s.proc.env![HUB_PID_ENV]}`)
  const killed = await exec(cfg, `bash -c ${shq(FORGE_REAP_SCRIPT)} forge-reap ${FORGE_KILL_GRACE_S} ${targets.join(' ')}`, { timeoutMs: 60_000 })
  const outcomes = new Map<number, { outcome: ForgeReaped['outcome']; children: number }>()
  for (const line of killed.stdout.split('\n')) {
    const m = /^R (\d+) (term|kill|gone) (\d+)$/.exec(line.trim())
    if (m) outcomes.set(parseInt(m[1]!, 10), { outcome: m[2] as ForgeReaped['outcome'], children: parseInt(m[3]!, 10) })
  }
  const reaped = stale.filter((s) => outcomes.has(s.proc.pid)).map((s) => describe(s, outcomes.get(s.proc.pid)!.outcome, outcomes.get(s.proc.pid)!.children))
  const missing = stale.length - reaped.length
  return {
    ok: missing === 0,
    reason: missing ? `${missing} of ${stale.length} stale agent(s) got no verdict from the box: ${killed.stderr.trim().split('\n').pop() ?? `exit ${killed.code}`}` : note,
    live, reaped,
  }
}

/** One log line per reaped agent, in the local reaper's voice. */
export function describeForgeReaped(r: ForgeReaped): string {
  const who = [r.agentKey, r.csid ? `csid ${r.csid.slice(0, 8)}` : null].filter(Boolean).join(', ')
  const how = r.outcome === 'gone' ? 'had already exited' : r.outcome === 'kill' ? 'needed SIGKILL' : 'ended on SIGTERM'
  return `stale claude pid ${r.pid} on forge (${r.reason}${who ? `, ${who}` : ''}, age ${r.ageS}s, ${r.children} child process(es)) ${how}`
}
