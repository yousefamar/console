import { describe, it, expect, vi, beforeEach } from 'vitest'

// git-status.ts promisifies execFile; feed it canned git output and count
// the calls so the "one refresh per checkout, never blocking" contract is
// what the test pins.
const calls: Array<{ cwd: string; args: string[] }> = []
let gate: Promise<void> = Promise.resolve()
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, args: string[], opts: { cwd: string }, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
    calls.push({ cwd: opts.cwd, args })
    void gate.then(() => {
      if (opts.cwd === '/nope') return cb(new Error('not a git repo'))
      const out: Record<string, string> = {
        'rev-parse': 'main\n',
        status: ' M a.ts\n?? new.ts\n',
        diff: args.includes('--cached') ? '1\t0\tstaged.ts\n' : '3\t2\ta.ts\n-\t-\tbin.png\n',
      }
      cb(null, { stdout: out[args[0]!] ?? '', stderr: '' })
    })
  },
}))

const { gitStatusSync, forgetGitStatus } = await import('../git-status.js')

const settle = () => new Promise((r) => setTimeout(r, 5))

beforeEach(() => { calls.length = 0; gate = Promise.resolve(); forgetGitStatus('/repo'); forgetGitStatus('/nope') })

describe('gitStatusSync', () => {
  it('returns an empty snapshot immediately and fills it in the background', async () => {
    expect(gitStatusSync('/repo')).toEqual({})
    await settle()
    expect(gitStatusSync('/repo')).toEqual({ branch: 'main', dirty: true, stats: { added: 1 + 3 + 1, deleted: 2 } })
    // rev-parse + status, then the two numstats — four async calls, no more.
    expect(calls.map((c) => c.args[0])).toEqual(['rev-parse', 'status', 'diff', 'diff'])
  })

  it('coalesces every caller on the same checkout into ONE in-flight refresh', async () => {
    let release!: () => void
    gate = new Promise((r) => { release = r })
    for (let i = 0; i < 12; i++) gitStatusSync('/repo')   // a dozen sessions, one cwd
    expect(calls).toHaveLength(2)                          // one refresh: rev-parse + status
    release()
    await settle()
    expect(calls).toHaveLength(4)
    expect(gitStatusSync('/repo').branch).toBe('main')
    expect(calls).toHaveLength(4)                          // fresh snapshot → no new refresh
  })

  it('a checkout git rejects yields an empty snapshot, not a throw', async () => {
    expect(gitStatusSync('/nope')).toEqual({})
    await settle()
    expect(gitStatusSync('/nope')).toEqual({})
    expect(calls.filter((c) => c.cwd === '/nope')).toHaveLength(2)   // failed refresh is not retried until stale
  })
})
