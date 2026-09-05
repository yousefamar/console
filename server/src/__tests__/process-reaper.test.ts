import { describe, it, expect, vi } from 'vitest'
import {
  classifyStale,
  findStaleProcesses,
  isClaudeArgv,
  hasHubSignature,
  resumeTarget,
  csidRefs,
  servedCsid,
  describeCsid,
  reapStaleProcesses,
  StaleProcessSweeper,
  HUB_PID_ENV,
  type ProcInfo,
} from '../agents/process-reaper.js'

const HUB = 5000
const OWN = new Set(['aaaaaaaa-1111', 'bbbbbbbb-2222'])
const HUB_ARGS = ['claude', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose']

function proc(over: Partial<ProcInfo> & { args?: string[] }): ProcInfo {
  return { pid: 100, ppid: 1, args: HUB_ARGS, env: null, ageMs: 600_000, ...over }
}

describe('argv helpers', () => {
  it('recognises the claude CLI directly and via a node shebang', () => {
    expect(isClaudeArgv(['claude', '--resume', 'x'])).toBe(true)
    expect(isClaudeArgv(['/usr/bin/node', '/home/u/.local/bin/claude', '-p'])).toBe(true)
    expect(isClaudeArgv(['/usr/bin/zsh', '-c', 'claude --resume x'])).toBe(false)
    expect(isClaudeArgv(['vite', '--port', '5174'])).toBe(false)
  })
  it('hub signature = --input-format stream-json; resume target follows --resume', () => {
    expect(hasHubSignature(HUB_ARGS)).toBe(true)
    expect(hasHubSignature(['claude', '--resume', 'x'])).toBe(false)
    expect(resumeTarget([...HUB_ARGS, '--resume', 'aaaaaaaa-1111', '--fork-session'])).toBe('aaaaaaaa-1111')
    expect(resumeTarget(HUB_ARGS)).toBeNull()
  })
  it('csid refs / served csid handle both fork argv shapes', () => {
    const plain = [...HUB_ARGS, '--resume', 'aaaaaaaa-1111']
    const legacyFork = [...HUB_ARGS, '--resume', 'aaaaaaaa-1111', '--fork-session']
    const pinnedFork = [...HUB_ARGS, '--resume', 'aaaaaaaa-1111', '--fork-session', '--session-id', 'ffffffff-7777']
    expect(csidRefs(plain)).toEqual(['aaaaaaaa-1111'])
    expect(csidRefs(legacyFork)).toEqual(['aaaaaaaa-1111'])
    expect(csidRefs(pinnedFork)).toEqual(['ffffffff-7777', 'aaaaaaaa-1111'])
    // A plain resume serves that csid; a legacy fork serves an id argv never names; a pinned fork serves its pin.
    expect(servedCsid(plain)).toBe('aaaaaaaa-1111')
    expect(servedCsid(legacyFork)).toBeNull()
    expect(servedCsid(pinnedFork)).toBe('ffffffff-7777')
    expect(describeCsid(legacyFork)).toBe('aaaaaaaa-1111+fork')
    expect(describeCsid(pinnedFork)).toBe('ffffffff-7777')
    expect(describeCsid(HUB_ARGS)).toBeNull()
  })
})

describe('classifyStale', () => {
  const opts = { ownPid: HUB, ownedCsids: OWN }

  it('never flags ourselves or our own children', () => {
    expect(classifyStale(proc({ pid: HUB, env: { [HUB_PID_ENV]: '1' } }), opts)).toBeNull()
    expect(classifyStale(proc({ ppid: HUB, env: { [HUB_PID_ENV]: '1' } }), opts)).toBeNull()
    expect(classifyStale(proc({ ppid: HUB, args: [...HUB_ARGS, '--resume', 'aaaaaaaa-1111'] }), opts)).toBeNull()
  })

  it('flags a previous hub generation by its env marker, whatever its args', () => {
    expect(classifyStale(proc({ env: { [HUB_PID_ENV]: '4242' } }), opts)).toBe('hub-marker')
    // A fresh spawn (no --resume) from the dead hub is still caught.
    expect(classifyStale(proc({ env: { [HUB_PID_ENV]: '4242' }, args: [...HUB_ARGS, '-p'] }), opts)).toBe('hub-marker')
  })

  it('a marker naming US is not stale even when reparented (e.g. subreaper quirks)', () => {
    expect(classifyStale(proc({ ppid: 1, env: { [HUB_PID_ENV]: String(HUB) } }), opts)).toBeNull()
  })

  it('pre-marker processes: stale iff --resume names a csid we own', () => {
    expect(classifyStale(proc({ args: [...HUB_ARGS, '--resume', 'aaaaaaaa-1111'] }), opts)).toBe('resume-match')
    // A fork resumes its PARENT csid with --fork-session — the parent is ours too.
    expect(classifyStale(proc({ args: [...HUB_ARGS, '--resume', 'bbbbbbbb-2222', '--fork-session'] }), opts)).toBe('resume-match')
    expect(classifyStale(proc({ args: [...HUB_ARGS, '--resume', 'zzzzzzzz-9999'] }), opts)).toBeNull()
    expect(classifyStale(proc({ args: [...HUB_ARGS] }), opts)).toBeNull()
  })

  it('a pinned fork (--session-id) matches on its OWN id even when its parent is no longer ours', () => {
    const orphanOfDeletedParent = [...HUB_ARGS, '--resume', 'zzzzzzzz-9999', '--fork-session', '--session-id', 'bbbbbbbb-2222']
    expect(classifyStale(proc({ args: orphanOfDeletedParent }), opts)).toBe('resume-match')
    // …and a pinned fork of an owned parent whose own id we somehow don't know still matches via the parent.
    expect(classifyStale(proc({ args: [...HUB_ARGS, '--resume', 'aaaaaaaa-1111', '--fork-session', '--session-id', 'ffffffff-7777'] }), opts)).toBe('resume-match')
  })

  it('a LIVE fork of the hub is never a candidate, whatever its --resume names (ppid guard)', () => {
    // Today every ticket-fork's argv is `--resume <parent> --fork-session`; resuming the
    // parent must not reap its live forks — they are the hub's own children.
    expect(classifyStale(proc({ ppid: HUB, args: [...HUB_ARGS, '--resume', 'aaaaaaaa-1111', '--fork-session'] }), opts)).toBeNull()
  })

  it("Yousef's interactive `claude --resume <ours>` in a terminal is left alone (no hub signature)", () => {
    expect(classifyStale(proc({ args: ['claude', '--resume', 'aaaaaaaa-1111'] }), opts)).toBeNull()
    expect(classifyStale(proc({ args: ['claude', '--resume', 'aaaaaaaa-1111'], env: { [HUB_PID_ENV]: '4242' } }), opts)).toBeNull()
  })

  it('non-claude processes that merely inherited the marker are ignored', () => {
    expect(classifyStale(proc({ args: ['node', 'vite', '--port', '5174'], env: { [HUB_PID_ENV]: '4242' } }), opts)).toBeNull()
    expect(classifyStale(proc({ args: ['/usr/bin/zsh', '-c', 'x'], env: { [HUB_PID_ENV]: '4242' } }), opts)).toBeNull()
  })

  it('findStaleProcesses keeps only the stale ones with their reason', () => {
    const list = [
      proc({ pid: 1, ppid: HUB }),
      proc({ pid: 2, env: { [HUB_PID_ENV]: '4242' } }),
      proc({ pid: 3, args: [...HUB_ARGS, '--resume', 'aaaaaaaa-1111'] }),
      proc({ pid: 4, args: ['claude', '--resume', 'aaaaaaaa-1111'] }),
    ]
    expect(findStaleProcesses(list, opts).map((s) => [s.proc.pid, s.reason])).toEqual([[2, 'hub-marker'], [3, 'resume-match']])
  })
})

describe('reapStaleProcesses', () => {
  it('reports what it would reap from an injected list (nothing to signal for dead pids)', async () => {
    // pids that cannot exist → process.kill throws → waitForExit sees them gone at once.
    const list = () => [
      proc({ pid: 2 ** 22 - 1, args: [...HUB_ARGS, '--resume', 'aaaaaaaa-1111'] }),
      proc({ pid: 2 ** 22 - 2, env: { [HUB_PID_ENV]: '4242' } }),
      proc({ pid: 2 ** 22 - 3, ppid: HUB }),
    ]
    const res = await reapStaleProcesses({ ownPid: HUB, ownedCsids: OWN, list, graceMs: 50 })
    expect(res.reaped.map((r) => [r.reason, r.csid, r.killed])).toEqual([
      ['resume-match', 'aaaaaaaa-1111', false],
      ['hub-marker', null, false],
    ])
  })

  it('is a no-op with no stale processes', async () => {
    const res = await reapStaleProcesses({ ownPid: HUB, ownedCsids: OWN, list: () => [proc({ ppid: HUB })] })
    expect(res.reaped).toEqual([])
  })
})

describe('StaleProcessSweeper', () => {
  it('SIGTERMs on first sighting, SIGKILLs on the next, forgets pids that vanish', () => {
    const kills: Array<[number, string]> = []
    let list = [proc({ pid: 7, args: [...HUB_ARGS, '--resume', 'aaaaaaaa-1111'] })]
    const sweeper = new StaleProcessSweeper({
      ownPid: HUB,
      ownedCsids: () => OWN,
      log: () => {},
      list: () => list,
      kill: (pid, sig) => { kills.push([pid, sig]); return true },
    })
    expect(sweeper.sweep().map((a) => a.sig)).toEqual(['SIGTERM'])
    expect(sweeper.sweep().map((a) => a.sig)).toEqual(['SIGKILL'])
    list = []
    expect(sweeper.sweep()).toEqual([])
    // The pid recycled onto a fresh stale twin starts over at SIGTERM.
    list = [proc({ pid: 7, args: [...HUB_ARGS, '--resume', 'aaaaaaaa-1111'] })]
    expect(sweeper.sweep().map((a) => a.sig)).toEqual(['SIGTERM'])
    expect(kills).toEqual([[7, 'SIGTERM'], [7, 'SIGKILL'], [7, 'SIGTERM']])
  })

  it('age-gates: a stale twin younger than minAgeMs is left for the boot reap', () => {
    const kill = vi.fn(() => true)
    const sweeper = new StaleProcessSweeper({
      ownPid: HUB,
      ownedCsids: () => OWN,
      log: () => {},
      list: () => [proc({ pid: 8, ageMs: 10_000, env: { [HUB_PID_ENV]: '4242' } })],
      kill,
    })
    expect(sweeper.sweep()).toEqual([])
    expect(kill).not.toHaveBeenCalled()
  })

  it('reads owned csids live so sessions created after boot are covered', () => {
    const owned = new Set<string>()
    const kill = vi.fn(() => true)
    const sweeper = new StaleProcessSweeper({
      ownPid: HUB,
      ownedCsids: () => owned,
      log: () => {},
      list: () => [proc({ pid: 9, args: [...HUB_ARGS, '--resume', 'cccccccc-3333'] })],
      kill,
    })
    expect(sweeper.sweep()).toEqual([])
    owned.add('cccccccc-3333')
    expect(sweeper.sweep().map((a) => a.reason)).toEqual(['resume-match'])
  })
})
