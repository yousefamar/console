import { describe, it, expect, vi, beforeEach } from 'vitest'

// git-status.ts promisifies execFile; feed it canned git output and count
// the calls so the "one refresh per checkout, never blocking" contract is
// what the test pins.
const calls: Array<{ cwd: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
let gate: Promise<void> = Promise.resolve()
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
    calls.push({ cwd: opts.cwd, args, env: opts.env })
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

// Checkout resolution reads the filesystem; model these dirs (`>name` = symlink).
//   /repo        — a repository root itself (has .git)
//   /vault/p     — vault project dir with a `repo` link to a checkout
//   /vault/q     — vault project dir whose checkout is linked as `app`
//   /vault/r     — vault project dir with no checkout inside (falls back)
//   /vault       — the vault root: a REAL nested repo (`al`) must not count
//   /nope        — not a dir git accepts
const tree: Record<string, string[]> = {
  '/repo': ['.git', 'src'],
  '/vault': ['al', 'projects', '>_data'],
  '/vault/al': ['.git'],
  '/vault/projects': [],
  '/vault/_data': [],
  '/vault/p': ['board.md', '>repo'],
  '/vault/p/repo': ['.git'],
  '/vault/q': ['agendas', '>app', 'node_modules', 'archive'],
  '/vault/q/app': ['.git'],
  '/vault/q/node_modules': ['.git'],   // never a candidate
  '/vault/r': ['research', 'sources'],
  '/vault/r/research': [],
  '/vault/r/sources': [],
}
vi.mock('node:fs/promises', () => ({
  readdir: async (p: string) => {
    const kids = tree[p]
    if (!kids) throw new Error('ENOENT')
    return kids.map((raw) => {
      const link = raw.startsWith('>'), name = link ? raw.slice(1) : raw
      return { name, isDirectory: () => !link && name !== 'board.md' && name !== '.git', isSymbolicLink: () => link }
    })
  },
  stat: async (p: string) => {
    const isDir = p in tree
    const parent = p.slice(0, p.lastIndexOf('/')), base = p.slice(p.lastIndexOf('/') + 1)
    const listed = tree[parent]?.some((raw) => raw === base || raw === '>' + base)
    if (!isDir && !listed) throw new Error('ENOENT')
    return { isDirectory: () => isDir }
  },
}))

const { gitStatusSync, forgetGitStatus, resolveCheckout } = await import('../git-status.js')

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
    await new Promise((r) => setImmediate(r))              // checkout resolution (fs) precedes the git calls
    expect(calls).toHaveLength(2)                          // one refresh: rev-parse + status
    release()
    await settle()
    expect(calls).toHaveLength(4)
    expect(gitStatusSync('/repo').branch).toBe('main')
    expect(calls).toHaveLength(4)                          // fresh snapshot → no new refresh
  })

  // 2026-10-06: this poller's killed `git status` calls left zero-byte
  // .git/index.lock orphans that failed every later commit in the repo for 6 h
  // (console, demovid, reflection-tools). git takes that lock to write back a
  // refreshed stat cache; GIT_OPTIONAL_LOCKS=0 tells it not to. EVERY call must
  // carry it — `git diff` refreshes the index too, not just `status`.
  it('never lets git take .git/index.lock — every call carries GIT_OPTIONAL_LOCKS=0', async () => {
    gitStatusSync('/repo')
    await settle()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.map((c) => c.args[0])).toContain('status')
    for (const c of calls) expect(c.env?.GIT_OPTIONAL_LOCKS).toBe('0')
    // and the rest of the environment is still inherited, not replaced
    expect(calls[0]!.env?.PATH).toBe(process.env.PATH)
  })

  it('describes the checkout INSIDE a vault project dir, not the vault', async () => {
    forgetGitStatus('/vault/q')
    gitStatusSync('/vault/q')
    await settle()
    expect(gitStatusSync('/vault/q').repo).toBe('/vault/q/app')
    expect(calls.every((c) => c.cwd === '/vault/q/app')).toBe(true)   // every git call ran in the checkout
    expect(gitStatusSync('/repo').repo).toBeUndefined()               // a repo root describes itself
  })

  it('a checkout git rejects yields an empty snapshot, not a throw', async () => {
    expect(gitStatusSync('/nope')).toEqual({})
    await settle()
    expect(gitStatusSync('/nope')).toEqual({})
    expect(calls.filter((c) => c.cwd === '/nope')).toHaveLength(2)   // failed refresh is not retried until stale
  })
})

describe('resolveCheckout', () => {
  it('a repository root is its own checkout, whatever is under it', async () => {
    expect(await resolveCheckout('/repo')).toBe('/repo')
  })
  it('the `repo` link wins', async () => {
    expect(await resolveCheckout('/vault/p')).toBe('/vault/p/repo')
  })
  it('any other child that is a repository counts (astera links its code as `app`)', async () => {
    expect(await resolveCheckout('/vault/q')).toBe('/vault/q/app')
  })
  it('a REAL nested repo is vault content, not the checkout (root/al at the vault root)', async () => {
    expect(await resolveCheckout('/vault')).toBe('/vault')
  })
  it('no checkout inside → the cwd itself (the vault)', async () => {
    expect(await resolveCheckout('/vault/r')).toBe('/vault/r')
    expect(await resolveCheckout('/nope')).toBe('/nope')
  })
})
