import { describe, it, expect } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { remoteCommandArgv, execFailure, type ExecResult } from '../forge/ssh.js'
import { parseForgeProcs, findForgeStale, reapForgeStale, describeForgeReaped, trailingDue, FORGE_LIST_SCRIPT, FORGE_REAP_SCRIPT } from '../forge/reaper.js'
import { HUB_PID_ENV, type ProcInfo } from '../agents/process-reaper.js'
import type { ForgeConfig } from '../forge/config.js'

const cfg = { host: 'forge' } as ForgeConfig
const HUB = 534525
const HUB_ARGS = ['claude', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose']

function proc(over: Partial<ProcInfo> & { marker?: number | null; csid?: string }): ProcInfo {
  const env: Record<string, string> = {}
  if (over.marker !== null) env[HUB_PID_ENV] = String(over.marker ?? HUB)
  if (over.csid) env.CONSOLE_CLAUDE_SESSION_ID = over.csid
  return { pid: 100, ppid: 1258, args: HUB_ARGS, ageMs: 600_000, ...over, env: over.env ?? env }
}

// ---------------------------------------------------------------------------
// The watchdog — run through a real bash, because the claim is about processes.
// ---------------------------------------------------------------------------

/** The remote command string, run in a local bash (the box's shell is bash too). */
function runLocal(opts: { command: string; args: string[] }) {
  const inner = remoteCommandArgv(cfg, { cwd: '/tmp', ...opts, dieWithConnection: true }).at(-1)!
  return spawn('bash', ['-c', inner.replace('. /etc/profile.d/forge.sh >/dev/null 2>&1 ;', '')], { stdio: ['pipe', 'pipe', 'pipe'] })
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
function pidsMatching(pattern: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) await sleep(40)
  return cond()
}

describe('a forge agent dies with its connection', () => {
  it('is opt-in, so a one-shot command whose stdin is closed up front is not stopped at birth', () => {
    const plain = remoteCommandArgv(cfg, { cwd: '/x', command: 'printenv', args: ['A'] }).at(-1)!
    expect(plain).not.toContain('forge-watchdog')
    expect(plain.endsWith("exec env 'printenv' 'A'")).toBe(true)
    expect(remoteCommandArgv(cfg, { cwd: '/x', command: 'claude', dieWithConnection: true }).at(-1)!).toContain('forge-watchdog')
  })

  it('relays stdin verbatim and returns the agent\'s own exit code', async () => {
    const p = runLocal({ command: 'bash', args: ['-c', 'read -r a; echo "got:$a"; read -r b; echo "got:$b"; exit 7'] })
    let out = ''
    p.stdout!.on('data', (d) => (out += d))
    p.stdin!.write('{"type":"user","text":"it\'s  two spaces"}\n')
    p.stdin!.write('second\n')
    const code = await new Promise((r) => p.on('exit', r))
    p.stdin!.end()
    expect(out).toBe('got:{"type":"user","text":"it\'s  two spaces"}\ngot:second\n')
    expect(code).toBe(7)
  })

  it('ends the agent AND what it is running when the connection closes mid-turn', async () => {
    // The bug: every hub-side stop is a signal to the local ssh client, which
    // only closes the channel. An agent mid-turn ignored that EOF and kept
    // working with nobody attached, next to the copy the hub respawned.
    const tag = `wdtest-tree-${process.pid}`
    const p = runLocal({ command: 'bash', args: ['-c', `bash -c 'exec -a ${tag}-grandchild sleep 300' & exec -a ${tag}-child sleep 300 & wait`] })
    // Anchored: the agent's own argv quotes the tag inside its script text.
    expect(await until(() => pidsMatching(`^${tag}-`).length === 2, 3000)).toBe(true)
    const tree = [p.pid!, ...pidsMatching(`^${tag}-`)]
    p.stdin!.end()
    expect(await until(() => !tree.some(alive), 4000)).toBe(true)
  })

  it('SIGKILLs an agent that ignores SIGTERM, after the grace', async () => {
    const p = runLocal({ command: 'bash', args: ['-c', 'trap "" TERM; while :; do sleep 0.2; done'] })
    await sleep(400)
    const t0 = Date.now()
    p.stdin!.end()
    expect(await until(() => !alive(p.pid!), 9000)).toBe(true)
    expect(Date.now() - t0).toBeGreaterThan(4000)
  }, 15_000)

  it('spares a process the agent daemonised earlier', async () => {
    // A dev server left up for review must survive its agent being hibernated
    // or respawned; only what the agent is running NOW goes with it.
    const tag = `wdtest-daemon-${process.pid}`
    const p = runLocal({ command: 'bash', args: ['-c', `(setsid bash -c 'exec -a ${tag} sleep 300' >/dev/null 2>&1 &) ; sleep 300`] })
    expect(await until(() => pidsMatching(`^${tag} `).length === 1, 3000)).toBe(true)
    const daemon = pidsMatching(`^${tag} `)[0]!
    p.stdin!.end()
    expect(await until(() => !alive(p.pid!), 4000)).toBe(true)
    expect(alive(daemon)).toBe(true)
    process.kill(daemon, 'SIGKILL')
  })

  it('stays out of the way when the agent exits by itself', async () => {
    const p = runLocal({ command: 'bash', args: ['-c', 'echo bye; exit 3'] })
    let out = ''
    p.stdout!.on('data', (d) => (out += d))
    const code = await new Promise((r) => p.on('exit', r))   // stdin still open
    p.stdin!.end()
    expect([out, code]).toEqual(['bye\n', 3])
  })

  it('leaves ONE process carrying the agent\'s command line', async () => {
    // Anything that counts agents with `pgrep -f` — this reaper, Astera's —
    // must not see the watchdog as a second copy of the session.
    const tag = `wdtest-argv-${process.pid}`
    const p = runLocal({ command: 'bash', args: ['-c', 'sleep 300; true', tag] })
    expect(await until(() => pidsMatching(tag).length >= 1, 3000)).toBe(true)
    await sleep(200)
    expect(pidsMatching(tag)).toEqual([p.pid])
    p.stdin!.end()
    await until(() => !alive(p.pid!), 4000)
  })
})

// ---------------------------------------------------------------------------
// The reaper's judgement
// ---------------------------------------------------------------------------

describe('findForgeStale', () => {
  it('ends an agent a previous hub started', () => {
    const stale = findForgeStale([proc({ pid: 295073, ppid: 1, marker: 3522710, csid: 'c3ba7775' })], { ownPid: HUB })
    expect(stale.map((s) => [s.proc.pid, s.reason])).toEqual([[295073, 'hub-marker']])
  })

  it('never touches this hub\'s own agents, one per session', () => {
    const procs = [proc({ pid: 1, csid: 'a' }), proc({ pid: 2, csid: 'b' }), proc({ pid: 3, csid: 'c' })]
    expect(findForgeStale(procs, { ownPid: HUB, supersededMinAgeMs: 0 })).toEqual([])
  })

  it('never judges an UNMARKED process — on the box that means someone started it by hand', () => {
    expect(findForgeStale([proc({ marker: null, csid: 'a' })], { ownPid: HUB, supersededMinAgeMs: 0 })).toEqual([])
  })

  it('ignores anything that is not a hub-spawned claude, whatever its env says', () => {
    const procs = [
      proc({ marker: 1, args: ['claude', '--resume', 'x'] }),                    // interactive, in a terminal
      proc({ marker: 1, args: ['node', 'next', 'dev', '--port', '5217'] }),      // a dev server that inherited the env
      proc({ marker: 1, args: ['bash', '-c', 'claude --input-format stream-json'] }),
    ]
    expect(findForgeStale(procs, { ownPid: HUB })).toEqual([])
  })

  it('ends the OLDER copies of a session this hub started twice, keeping the newest', () => {
    const procs = [
      proc({ pid: 10, csid: 'gray-moth', ageMs: 1_100_000 }),
      proc({ pid: 11, csid: 'gray-moth', ageMs: 400_000 }),
      proc({ pid: 12, csid: 'gray-moth', ageMs: 120_000 }),
      proc({ pid: 20, csid: 'lime-elk', ageMs: 300_000 }),
    ]
    const stale = findForgeStale(procs, { ownPid: HUB, supersededMinAgeMs: 90_000 })
    expect(stale.map((s) => [s.proc.pid, s.reason]).sort()).toEqual([[10, 'superseded'], [11, 'superseded']])
  })

  it('does not call a respawn in progress a twin', () => {
    // Both copies are alive for the seconds the watchdog takes to end the old one.
    const procs = [proc({ pid: 10, csid: 's', ageMs: 400_000 }), proc({ pid: 11, csid: 's', ageMs: 3_000 })]
    expect(findForgeStale(procs, { ownPid: HUB, supersededMinAgeMs: 90_000 })).toEqual([])
  })

  it('only looks for superseded copies when asked — the boot reap has no use for it', () => {
    const procs = [proc({ pid: 10, csid: 's', ageMs: 400_000 }), proc({ pid: 11, csid: 's', ageMs: 200_000 })]
    expect(findForgeStale(procs, { ownPid: HUB })).toEqual([])
  })

  it('the pass that follows a respawn does not wait for the sweep\'s 90 s', () => {
    // 22:03 on 9 Oct 2026: replacements 20 s old, the agents they replaced
    // still working. The sweep's rule leaves them; the post-respawn rule does not.
    const procs = [proc({ pid: 10, csid: 's', ageMs: 1_601_000 }), proc({ pid: 11, csid: 's', ageMs: 20_000 })]
    expect(findForgeStale(procs, { ownPid: HUB, supersededMinAgeMs: 90_000 })).toEqual([])
    expect(findForgeStale(procs, { ownPid: HUB, supersededMinAgeMs: 10_000 }).map((s) => s.proc.pid)).toEqual([10])
    // Still not while the watchdog's own 5 s grace is running.
    const handover = [proc({ pid: 10, csid: 's', ageMs: 400_000 }), proc({ pid: 11, csid: 's', ageMs: 4_000 })]
    expect(findForgeStale(handover, { ownPid: HUB, supersededMinAgeMs: 10_000 })).toEqual([])
  })
})

describe('trailingDue — when the post-respawn pass runs', () => {
  it('20 s after the last spawn of a burst', () => {
    expect(trailingDue(1_000, 1_000, 20_000, 60_000)).toBe(21_000)
    expect(trailingDue(9_000, 1_000, 20_000, 60_000)).toBe(29_000)
  })

  it('but never more than 60 s after the first, however long the spawns keep coming', () => {
    expect(trailingDue(55_000, 1_000, 20_000, 60_000)).toBe(61_000)
    expect(trailingDue(61_000, 1_000, 20_000, 60_000)).toBe(61_000)
  })
})

// ---------------------------------------------------------------------------
// The listing, end to end through the real scripts
// ---------------------------------------------------------------------------

describe('the listing', () => {
  it('round-trips argv and the three env keys', () => {
    const cmdline = Buffer.from(['claude', '--input-format', 'stream-json', '--name', 'Gray hawk (fork)', ''].join('\0')).toString('base64')
    const { procs, complete } = parseForgeProcs([
      'P 493978    1258   871',
      `A ${cmdline}`,
      `E ${HUB_PID_ENV}=534525`,
      'E CONSOLE_CLAUDE_SESSION_ID=5f5353ed-aaaa',
      'E CONSOLE_AGENT_KEY=astera-general-gray-hawk-fork',
      'END',
      '',
    ].join('\n'))
    expect(complete).toBe(true)
    expect(procs).toEqual([{
      pid: 493978, ppid: 1258, ageMs: 871_000,
      args: ['claude', '--input-format', 'stream-json', '--name', 'Gray hawk (fork)'],
      env: { [HUB_PID_ENV]: '534525', CONSOLE_CLAUDE_SESSION_ID: '5f5353ed-aaaa', CONSOLE_AGENT_KEY: 'astera-general-gray-hawk-fork' },
    }])
  })

  it('says so when the listing was cut short', () => {
    expect(parseForgeProcs('P 1 1 1\nA Y2xhdWRl\n').complete).toBe(false)
  })

  it('finds a real hub-shaped process on this machine and reports the marker it carries', async () => {
    // The script is bash run on the box; run it here against a real process so
    // a quoting slip in it fails a test instead of an incident.
    const tag = `listtest-${process.pid}`
    const child = spawn('bash', ['-c', `exec -a claude bash -c 'sleep 30; true' ${tag} --input-format stream-json`], {
      stdio: 'ignore', env: { ...process.env, [HUB_PID_ENV]: '4242', CONSOLE_CLAUDE_SESSION_ID: tag, CONSOLE_AGENT_KEY: 'k' },
    })
    try {
      await sleep(300)
      const out = execFileSync('bash', ['-c', FORGE_LIST_SCRIPT, 'forge-list'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      const { procs, complete } = parseForgeProcs(out)
      expect(complete).toBe(true)
      const mine = procs.find((p) => p.pid === child.pid)
      expect(mine?.args).toEqual(['claude', '-c', 'sleep 30; true', tag, '--input-format', 'stream-json'])
      expect(mine?.env).toEqual({ [HUB_PID_ENV]: '4242', CONSOLE_CLAUDE_SESSION_ID: tag, CONSOLE_AGENT_KEY: 'k' })
      expect(findForgeStale(procs.filter((p) => p.pid === child.pid), { ownPid: 1 }).map((s) => s.reason)).toEqual(['hub-marker'])
    } finally {
      child.kill('SIGKILL')
    }
  })
})

describe('reapForgeStale', () => {
  const listing = (rows: Array<{ pid: number; marker: number; csid: string; age: number }>) =>
    rows.flatMap((r) => [
      `P ${r.pid} 1258 ${r.age}`,
      `A ${Buffer.from(HUB_ARGS.join('\0') + '\0').toString('base64')}`,
      `E ${HUB_PID_ENV}=${r.marker}`,
      `E CONSOLE_CLAUDE_SESSION_ID=${r.csid}`,
    ]).concat('END').join('\n')

  function fakeBox(list: string, verdicts: string) {
    const calls: string[] = []
    const exec = async (_c: ForgeConfig, command: string): Promise<ExecResult> => {
      calls.push(command)
      return { code: 0, stderr: '', stdout: command.includes('forge-reap') ? verdicts : list }
    }
    return { calls, exec }
  }

  it('sends ONLY the stale pids, each with the marker it was judged by', async () => {
    const box = fakeBox(listing([
      { pid: 100, marker: HUB, csid: 'live-1', age: 900 },
      { pid: 295073, marker: 3522710, csid: 'c3ba7775', age: 3583 },
      { pid: 101, marker: HUB, csid: 'live-2', age: 900 },
    ]), 'R 295073 term 19\n')
    const r = await reapForgeStale(cfg, { ownPid: HUB, exec: box.exec })
    expect(r).toMatchObject({ ok: true, live: 2 })
    expect(r.reaped).toEqual([{ pid: 295073, reason: 'hub-marker', csid: 'c3ba7775', agentKey: null, ageS: 3583, children: 19, outcome: 'term' }])
    // The kill call names the one target and nothing else: a pid that is not
    // on this line cannot be signalled, whatever the script does.
    expect(box.calls[1]!.endsWith(' forge-reap 5 295073:3522710')).toBe(true)
    expect(describeForgeReaped(r.reaped[0]!)).toBe('stale claude pid 295073 on forge (hub-marker, csid c3ba7775, age 3583s, 19 child process(es)) ended on SIGTERM')
  })

  it('makes no second call when nothing is stale', async () => {
    const box = fakeBox(listing([{ pid: 100, marker: HUB, csid: 'a', age: 10 }]), '')
    expect(await reapForgeStale(cfg, { ownPid: HUB, exec: box.exec })).toEqual({ ok: true, reason: undefined, live: 1, reaped: [] })
    expect(box.calls).toHaveLength(1)
  })

  it('a dry run judges and stops', async () => {
    const box = fakeBox(listing([{ pid: 7, marker: 1, csid: 'x', age: 10 }]), '')
    const r = await reapForgeStale(cfg, { ownPid: HUB, dryRun: true, exec: box.exec })
    expect(r.reaped.map((x) => x.pid)).toEqual([7])
    expect(box.calls).toHaveLength(1)
  })

  it('an unreachable box is a verdict, not a throw', async () => {
    const r = await reapForgeStale(cfg, { ownPid: HUB, exec: async () => ({ code: 255, stdout: '', stderr: 'ssh: connect to host forge: timed out' }) })
    expect(r).toEqual({ ok: false, reason: 'listing failed: ssh: connect to host forge: timed out', live: 0, reaped: [] })
  })

  it('a listing that never answered says so — the reason is never blank', async () => {
    // What execFile hands back when its timeout kills ssh: code null, no stderr.
    const timedOut = execFailure({ code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: '' }, 45_000)
    expect(timedOut).toEqual({ code: 1, stdout: '', stderr: 'no answer within 45 s (ssh ended by SIGTERM)' })
    const r = await reapForgeStale(cfg, { ownPid: HUB, exec: async () => timedOut })
    expect(r.reason).toBe('listing failed: no answer within 45 s (ssh ended by SIGTERM)')
    // And a refusal with nothing on stderr still names its exit code.
    const silent = await reapForgeStale(cfg, { ownPid: HUB, exec: async () => ({ code: 255, stdout: '', stderr: '' }) })
    expect(silent.reason).toBe('listing failed: exit 255, nothing on stderr')
  })

  it('execFailure keeps what ssh said, and only speaks for it when it said nothing', () => {
    expect(execFailure({ code: 255, stderr: 'mux_client_request_session: Session open refused by peer\n' }, 1000).stderr).toBe('mux_client_request_session: Session open refused by peer')
    expect(execFailure({ code: 255, killed: true, signal: 'SIGTERM', stderr: 'Connection timed out\n' }, 25_000).stderr).toBe('Connection timed out\nno answer within 25 s (ssh ended by SIGTERM)')
    // A plain failure with empty stderr stays empty: callers word that themselves.
    expect(execFailure({ code: 1, stderr: '', message: 'Command failed: ssh -o BatchMode=yes forge <a very long script>' }, 1000)).toEqual({ code: 1, stdout: '', stderr: '' })
    expect(execFailure({ code: 'ENOENT', message: 'spawn ssh ENOENT' }, 1000)).toEqual({ code: 1, stdout: '', stderr: 'spawn ssh ENOENT' })
  })

  it('reports a stale agent the box gave no verdict on, instead of calling it done', async () => {
    const box = fakeBox(listing([{ pid: 7, marker: 1, csid: 'x', age: 10 }, { pid: 8, marker: 1, csid: 'y', age: 10 }]), 'R 7 kill 2\n')
    const r = await reapForgeStale(cfg, { ownPid: HUB, exec: box.exec })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/1 of 2 stale agent\(s\) got no verdict/)
    expect(r.reaped.map((x) => [x.pid, x.outcome])).toEqual([[7, 'kill']])
  })

  it('the kill script ends a real tree and refuses a pid whose marker has changed', async () => {
    const tag = `reaptest-${process.pid}`
    const mk = (marker: string) => spawn('bash', ['-c', `exec -a claude bash -c 'exec -a ${tag}-child sleep 60 & wait' x --input-format stream-json`], {
      stdio: 'ignore', env: { ...process.env, [HUB_PID_ENV]: marker },
    })
    const stale = mk('4242')
    const reused = mk('5555')     // stands in for a pid that now belongs to something else
    try {
      expect(await until(() => pidsMatching(`^${tag}-child`).length === 2, 3000)).toBe(true)
      const kids = pidsMatching(`^${tag}-child`)
      const out = execFileSync('bash', ['-c', FORGE_REAP_SCRIPT, 'forge-reap', '2', `${stale.pid}:4242`, `${reused.pid}:4242`], { encoding: 'utf8' })
      const lines = out.trim().split('\n').sort()
      expect(lines).toEqual([`R ${reused.pid} gone 0`, `R ${stale.pid} term 1`].sort())
      expect(alive(reused.pid!)).toBe(true)
      expect(kids.filter(alive)).toHaveLength(1)
    } finally {
      stale.kill('SIGKILL'); reused.kill('SIGKILL')
      for (const k of pidsMatching(`^${tag}-child`)) try { process.kill(k, 'SIGKILL') } catch { /* gone */ }
    }
  })
})
