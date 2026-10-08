import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { boardRemote, resolvePlacement } from '../forge/config.js'
import { decidePlacement } from '../forge/index.js'
import { remoteCommandArgv } from '../forge/ssh.js'
import { remoteSettings } from '../forge/agent-env.js'
import { encodeProjectDir, transcriptPath } from '../forge/transcripts.js'
import { memoryDirFor } from '../forge/mounts.js'
import { parseWorktreeList, decidePrimaryCheckout } from '../forge/repo.js'
import { blockIdFromAgentKey, PendingMoves, type MoveResult } from '../forge/move.js'
import { parseCardTokens, parseBoard, serializeBoard } from '../kanban/board.js'

const cfg = {
  instanceId: 'i-abc', region: 'eu-west-2', host: 'forge',
  sshKey: '/home/amar/.ssh/forge_ed25519', remoteUser: 'amar',
  idleStopMinutes: 20, codeDir: '/home/amar/proj/code', bareDir: '/srv/git',
}

describe('board frontmatter remote:', () => {
  it('reads `remote: forge`', () => {
    expect(boardRemote('---\ntitle: x\nremote: forge\n---\n\n## Backlog\n')).toBe('forge')
  })
  it('reads an explicit `remote: local`', () => {
    expect(boardRemote('---\nremote: local\n---\n')).toBe('local')
  })
  it('is null with no frontmatter or no key', () => {
    expect(boardRemote('## Backlog\n')).toBeNull()
    expect(boardRemote('---\ntitle: x\n---\n')).toBeNull()
  })
  it('treats an unknown target as null rather than guessing — a typo must not ship work to a cloud box', () => {
    expect(boardRemote('---\nremote: frogе\n---\n')).toBeNull()
    expect(boardRemote('---\nremote: true\n---\n')).toBeNull()
  })
})

describe('placement resolution', () => {
  it('defaults to local with nothing set', () => {
    expect(resolvePlacement({ available: true }).placement).toBe('local')
  })
  it('board opt-in sends a card to forge', () => {
    expect(resolvePlacement({ boardRemote: 'forge', available: true }).placement).toBe('forge')
  })
  it('a #local card overrides a board that opted in', () => {
    const r = resolvePlacement({ cardRemote: 'local', boardRemote: 'forge', available: true })
    expect(r.placement).toBe('local')
    expect(r.reason).toContain('card tag')
  })
  it('a #forge card overrides a board that did not opt in', () => {
    expect(resolvePlacement({ cardRemote: 'forge', boardRemote: null, available: true }).placement).toBe('forge')
  })
  it('falls back to local when no forge is configured, and says so', () => {
    const r = resolvePlacement({ cardRemote: 'forge', available: false })
    expect(r.placement).toBe('local')
    expect(r.reason).toMatch(/not configured/)
  })
})

describe('decidePlacement — a cold box DEFERS, it does not demote', () => {
  it('holds the spawn when forge is wanted but the cwd is not prepared', () => {
    const r = decidePlacement({ cwd: '/home/amar/sync/brain/root/projects/astera', boardRemote: 'forge', available: true })
    expect(r).toMatchObject({ placement: 'forge', defer: true })
    expect(r.reason).toMatch(/cold/)
  })
  it('never defers a local card', () => {
    expect(decidePlacement({ cwd: '/tmp/x', available: true }).defer).toBeUndefined()
    expect(decidePlacement({ cwd: '/tmp/x', cardRemote: 'local', boardRemote: 'forge', available: true })).toMatchObject({ placement: 'local' })
  })
  it('never defers when there is no forge at all — that is a real local fallback', () => {
    const r = decidePlacement({ cwd: '/tmp/x', cardRemote: 'forge', available: false })
    expect(r.placement).toBe('local')
    expect(r.defer).toBeUndefined()
  })
})

describe('#forge / #local card tags', () => {
  it('parses the tags off the text', () => {
    expect(parseCardTokens('Do a thing #forge @console-general ^gray-deer')).toMatchObject({
      text: 'Do a thing', remote: 'forge', agentKey: 'console-general', blockId: 'gray-deer',
    })
    expect(parseCardTokens('Keep it here #local ^abc').remote).toBe('local')
  })
  it('leaves other hashtags alone', () => {
    const c = parseCardTokens('Ship the #rfp response ^abc')
    expect(c.remote).toBeNull()
    expect(c.text).toBe('Ship the #rfp response')
  })
  it('coexists with the other trailing tokens in any order', () => {
    const c = parseCardTokens('Thing #haiku #local #nofork @me ^id1')
    expect(c).toMatchObject({ remote: 'local', nofork: true, model: 'haiku', agentKey: 'me', blockId: 'id1' })
    expect(c.text).toBe('Thing')
  })
  it('round-trips through serialize without duplicating or dropping the tag', () => {
    const src = '---\nremote: forge\n---\n\n## In Progress\n\n- [ ] Build it #local @me ^abc\n'
    const board = parseBoard(src)
    const out = serializeBoard(board)
    expect(out).toContain('#local')
    expect(out.match(/#local/g)).toHaveLength(1)
    expect(parseBoard(out).columns[0]!.cards[0]!.remote).toBe('local')
  })
})

describe('remoteCommandArgv', () => {
  it('ferries env explicitly — ssh forwards none of its own', () => {
    const argv = remoteCommandArgv(cfg, { cwd: '/home/amar/x', env: { A: '1', B: 'two' }, command: 'claude', args: ['--foo'] })
    const inner = argv[argv.length - 1]!
    expect(inner).toContain("A='1'")
    expect(inner).toContain("B='two'")
    expect(inner).toContain("cd '/home/amar/x'")
    expect(inner).toContain("'claude' '--foo'")
  })
  it('uses -T so stdin/stdout are clean pipes for stream-json', () => {
    const argv = remoteCommandArgv(cfg, { cwd: '/x', command: 'claude' })
    expect(argv[0]).toBe('-T')
    expect(argv).toContain('forge')
  })
  it('sources the profile so the shared warm caches apply', () => {
    const inner = remoteCommandArgv(cfg, { cwd: '/x', command: 'claude' }).at(-1)!
    expect(inner).toContain('/etc/profile.d/forge.sh')
  })
  // The inner string is evaluated by a REMOTE shell, so the only assertion
  // worth making is that a real shell round-trips a hostile value intact
  // instead of executing any of it.
  it('quotes hostile values so a shell cannot break out of them', () => {
    const evil = "'; rm -rf / ; touch /tmp/forge-pwned-marker ; echo '"
    const inner = remoteCommandArgv(cfg, { cwd: '/tmp', env: { EVIL: evil }, command: 'printenv', args: ['EVIL'] }).at(-1)!
    const out = execFileSync('bash', ['-c', inner.replace('. /etc/profile.d/forge.sh >/dev/null 2>&1 ;', '')], { encoding: 'utf8' })
    // Round-tripping byte-for-byte IS the proof: the shell treated all of it as
    // one value rather than as syntax.
    expect(out.trim()).toBe(evil)
    expect(existsSync('/tmp/forge-pwned-marker')).toBe(false)
  })
})

describe('remoteSettings', () => {
  it('strips the desktop static-credential profile so forge uses its instance role', () => {
    const out = JSON.parse(remoteSettings(JSON.stringify({
      env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'bedrock-amar', AWS_REGION: 'us-east-1', ANTHROPIC_MODEL: 'arn:…' },
    }))) as { env: Record<string, string> }
    expect(out.env.AWS_PROFILE).toBeUndefined()
    expect(out.env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    // Cost attribution rides this ARN, not the calling principal — it must survive.
    expect(out.env.ANTHROPIC_MODEL).toBe('arn:…')
    expect(out.env.AWS_REGION).toBe('us-east-1')
  })
  it('strips any copied keys or bearer token too', () => {
    const out = JSON.parse(remoteSettings(JSON.stringify({
      env: { AWS_BEARER_TOKEN_BEDROCK: 't', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
    }))) as { env: Record<string, string> }
    expect(Object.keys(out.env)).toHaveLength(0)
  })
  it('leaves a settings file with no env block alone', () => {
    expect(JSON.parse(remoteSettings('{"permissions":{"allow":[]}}'))).toEqual({ permissions: { allow: [] } })
  })
})

describe('path parity', () => {
  it('encodes a project dir the way the CLI does', () => {
    expect(encodeProjectDir('/home/amar/sync/brain/root/projects/console'))
      .toBe('-home-amar-sync-brain-root-projects-console')
  })
  it('puts a remote transcript at the identical path under the forge home', () => {
    expect(transcriptPath('/home/amar/sync/brain/root/projects/console', 'abc', '/home/amar'))
      .toBe('/home/amar/.claude/projects/-home-amar-sync-brain-root-projects-console/abc.jsonl')
  })
  it('derives the auto-memory dir that has to be mounted', () => {
    expect(memoryDirFor('/home/amar/sync/brain/root/projects/console'))
      .toBe('/home/amar/.claude/projects/-home-amar-sync-brain-root-projects-console/memory')
  })
})

describe('forge move — picking what to carry across', () => {
  it('reads a session\'s card worktrees out of git worktree list', () => {
    const porcelain = [
      'worktree /opt/code/astera-app', 'HEAD abc', 'branch refs/heads/main', '',
      'worktree /opt/code/astera-app-worktrees/gray-deer', 'HEAD def', 'branch refs/heads/card/gray-deer-forge', '',
      'worktree /opt/code/astera-app-worktrees/pink-bat', 'HEAD 123', 'branch refs/heads/pink-bat', '',
    ].join('\n')
    const trees = parseWorktreeList(porcelain, '/opt/code/astera-app')
    // The primary checkout is not a card worktree and must never be rsynced over.
    expect(trees.map((w) => w.path)).toEqual([
      '/opt/code/astera-app-worktrees/gray-deer',
      '/opt/code/astera-app-worktrees/pink-bat',
    ])
    expect(trees[0]!.branch).toBe('card/gray-deer-forge')
  })

  it('skips a detached worktree — there is no branch to push', () => {
    const porcelain = ['worktree /tmp/wt/detached', 'HEAD abc', 'detached', ''].join('\n')
    expect(parseWorktreeList(porcelain, '/tmp/repo')).toEqual([])
  })

  it('finds the blockId in a ticket fork\'s agentKey, and nothing in a general session\'s', () => {
    expect(blockIdFromAgentKey('astera-general-gray-deer-fork')).toBe('gray-deer')
    expect(blockIdFromAgentKey('console-general-pink-bat-fork')).toBe('pink-bat')
    expect(blockIdFromAgentKey('astera-general')).toBeNull()
    expect(blockIdFromAgentKey(undefined)).toBeNull()
  })
})

describe('a prepare never moves the primary checkout off the branch it is on', () => {
  it('leaves a checkout that is on a DIFFERENT branch alone', () => {
    // Astera's shape: the desktop's astera-app sits on main because main is
    // production, while forks base on staging. The old code checked main out
    // underneath them, so a running fork kept building against the wrong base.
    const d = decidePrimaryCheckout({ exists: true, branch: 'staging', dirty: false }, 'main')
    expect(d.action).toBe('leave')
    expect(d.why).toMatch(/staging/)
  })

  it('leaves a DIRTY checkout alone even on the right branch', () => {
    expect(decidePrimaryCheckout({ exists: true, branch: 'main', dirty: true }, 'main').action).toBe('leave')
  })

  it('fast-forwards only when it is already on that branch and clean', () => {
    expect(decidePrimaryCheckout({ exists: true, branch: 'main', dirty: false }, 'main').action).toBe('fast-forward')
  })

  it('clones when there is nothing there', () => {
    expect(decidePrimaryCheckout({ exists: false, branch: '', dirty: false }, 'main').action).toBe('clone')
  })
})

describe('a deferred move that never runs still reports', () => {
  it('tells every waiting mover when the hub shuts down first', () => {
    // The real case: a move accepted mid-turn is one in-memory callback, and
    // the 08:46 restart on 8 Oct discarded it leaving the mover believing the
    // session had moved.
    const seen: MoveResult[] = []
    const p = new PendingMoves()
    p.add('session_1', 'Gray deer (fork)', (r) => seen.push(r))
    p.add('session_2', 'Jade fox (fork)', (r) => seen.push(r))

    const drained = p.drain('the hub shut down first')
    expect(drained.map((r) => r.session)).toEqual(['Gray deer (fork)', 'Jade fox (fork)'])
    expect(seen).toHaveLength(2)
    expect(seen.every((r) => r.ok === false)).toBe(true)
    // Drained means forgotten: a second drain must not re-report.
    expect(p.drain('again')).toEqual([])
  })

  it('does not report a move that already ran', () => {
    const seen: MoveResult[] = []
    const p = new PendingMoves()
    p.add('session_1', 'Gray deer (fork)', (r) => seen.push(r))
    p.clear('session_1')
    expect(p.drain('the hub shut down first')).toEqual([])
    expect(seen).toEqual([])
  })

  it('one throwing reporter does not hide the others', () => {
    const seen: string[] = []
    const p = new PendingMoves()
    p.add('a', 'A', () => { throw new Error('reporter exploded') })
    p.add('b', 'B', (r) => seen.push(r.session))
    expect(p.drain('shutdown')).toHaveLength(2)
    expect(seen).toEqual(['B'])
  })
})
