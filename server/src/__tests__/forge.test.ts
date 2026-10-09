import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boardRemote, resolvePlacement, forgeConfig, type ForgeConfig } from '../forge/config.js'
import { decidePlacement } from '../forge/index.js'
import { remoteCommandArgv } from '../forge/ssh.js'
import { remoteSettings, remoteBedrockEnv, credentialRsyncArgv, forgeSpawnPlan, forgeMaxLoginScript, remoteMaxSettings } from '../forge/agent-env.js'
import { encodeProjectDir, transcriptPath } from '../forge/transcripts.js'
import { memoryDirFor } from '../forge/mounts.js'
import { parseWorktreeList, decidePrimaryCheckout, githubHttpsUrl, baseRemoteFor } from '../forge/repo.js'
import { isGithubOriginRepo } from '../forge/config.js'
import { blockIdFromAgentKey, PendingMoves, type MoveResult } from '../forge/move.js'
import { parseCardTokens, parseBoard, serializeBoard } from '../kanban/board.js'

// Typed, so a new required ForgeConfig field fails HERE rather than at every
// call site that passes this fixture.
const cfg: ForgeConfig = {
  instanceId: 'i-abc', region: 'eu-west-2', host: 'forge',
  sshKey: '/home/amar/.ssh/forge_ed25519', remoteUser: 'amar',
  idleStopMinutes: 20, codeDir: '/home/amar/proj/code', bareDir: '/srv/git',
  githubOriginRepos: [], appEnv: {},
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
  it('wires Bedrock in even when the desktop file is on the Max subscription', () => {
    // 9 Oct 2026: the fleet moved to a Max login, the mirror shipped a file with
    // no Bedrock keys, and every forge fork answered "Not logged in".
    const out = JSON.parse(remoteSettings(
      JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }, theme: 'auto' }),
      { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', ANTHROPIC_MODEL: 'arn:…' },
    )) as { env: Record<string, string>; theme: string }
    expect(out.env).toEqual({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', ANTHROPIC_MODEL: 'arn:…' })
    expect(out.theme).toBe('auto')
  })
  it('adds the Bedrock wiring to a file that had no env block at all', () => {
    const out = JSON.parse(remoteSettings('{}', { CLAUDE_CODE_USE_BEDROCK: '1' })) as { env: Record<string, string> }
    expect(out.env).toEqual({ CLAUDE_CODE_USE_BEDROCK: '1' })
  })
})

describe('forgeSpawnPlan — which identity a forge fork gets', () => {
  it('follows the fleet onto the subscription only with a login for that account on the box', () => {
    expect(forgeSpawnPlan('first_party', '/home/amar/.claude-max')).toEqual({ backend: 'first_party', configDir: '/home/amar/.claude-max' })
  })
  it('is Bedrock when the fleet is on Max but the box has no usable login (the 9 Oct outage)', () => {
    expect(forgeSpawnPlan('first_party', null)).toEqual({ backend: 'bedrock' })
  })
  it('is Bedrock whenever the fleet is on Bedrock, login or not — a spent window moves forge too', () => {
    expect(forgeSpawnPlan('bedrock', '/home/amar/.claude-max')).toEqual({ backend: 'bedrock' })
    expect(forgeSpawnPlan('bedrock', null)).toEqual({ backend: 'bedrock' })
  })
})

describe('forgeMaxLoginScript — sharing the box\'s ~/.claude with an account dir', () => {
  const script = forgeMaxLoginScript({ second: '/home/amar/.claude-max' }, ['projects', 'skills'])
  it('touches a dir only when it holds credentials, and never reads, copies or moves them', () => {
    expect(script).toContain('if [ -f /home/amar/.claude-max/.credentials.json ]; then')
    // The credentials file appears in that one existence test and nowhere else.
    expect(script.match(/\.credentials\.json/g)).toHaveLength(1)
  })
  it('moves a real dir the CLI created aside instead of deleting it, then links', () => {
    expect(script).toContain('[ -e "$l" ] && mv "$l" "$l.pre-link.$(date +%s)"')
    expect(script).toContain('ln -s "$src" "$l"')
    expect(script).not.toMatch(/\brm\b/)
  })
  it('reports a login only once its projects dir resolves to the canonical one', () => {
    // 15 forks lost their context on 9 Oct because a config dir did not share `projects`.
    expect(script).toContain('[ "$(readlink /home/amar/.claude-max/projects)" = /home/amar/.claude/projects ] && echo "LOGIN second"')
  })
  it('ignores a name or path that is not plainly safe to put in a shell line', () => {
    const s = forgeMaxLoginScript({ 'x; rm -rf ~': '/home/amar/.claude-max', ok: '/tmp/$(id)' }, ['projects'])
    expect(s).not.toContain('rm -rf')
    expect(s).not.toContain('$(id)')
    expect(s).not.toContain('LOGIN')
  })
})

describe('remoteMaxSettings', () => {
  it('carries no backend key and no desktop credential, whatever the desktop file is on', () => {
    const out = JSON.parse(remoteMaxSettings(JSON.stringify({
      env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'bedrock-amar', AWS_REGION: 'us-east-1', ANTHROPIC_MODEL: 'arn:…', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
      theme: 'auto',
    }))) as { env: Record<string, string>; theme: string }
    expect(out.env).toEqual({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' })
    expect(out.theme).toBe('auto')
  })
})

describe('remoteBedrockEnv', () => {
  it('is Bedrock-wired and carries no desktop credential, whatever the fleet is on', () => {
    const env = remoteBedrockEnv()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(env.AWS_REGION).toBe('us-east-1')
    expect(env.ANTHROPIC_MODEL).toMatch(/^arn:aws:bedrock:/)
    for (const k of ['AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) expect(env[k], k).toBeUndefined()
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

describe('origin on the box is per-repo — a mirror is not a base', () => {
  const gh = { ...cfg, githubOriginRepos: ['astera-app'] }

  it('only the named repos get GitHub as origin', () => {
    expect(isGithubOriginRepo(gh, 'astera-app')).toBe(true)
    // Console is trunk-based and its forks never push to GitHub; pointing its
    // origin there would invent a dependency it does not have.
    expect(isGithubOriginRepo(gh, 'console')).toBe(false)
    expect(isGithubOriginRepo(cfg, 'astera-app')).toBe(false)
  })

  it('bases a card worktree on the MIRROR for a GitHub-origin repo', () => {
    // The card branch is pushed desktop → mirror, so it does not exist on
    // GitHub yet; basing on origin/<branch> would fail to resolve.
    expect(baseRemoteFor(gh, 'astera-app')).toBe('mirror')
    expect(baseRemoteFor(gh, 'console')).toBe('origin')
  })

  it('converts the desktop SSH remote to HTTPS, because the box has a token not a key', () => {
    expect(githubHttpsUrl('git@github.com:yousefamar/astera-app.git')).toBe('https://github.com/yousefamar/astera-app.git')
    expect(githubHttpsUrl('https://github.com/yousefamar/astera-app')).toBe('https://github.com/yousefamar/astera-app.git')
  })

  it('refuses a non-GitHub remote rather than pointing origin somewhere surprising', () => {
    expect(githubHttpsUrl('/srv/git/astera-app.git')).toBeNull()
    expect(githubHttpsUrl('git@gitlab.com:x/y.git')).toBeNull()
  })
})

describe('appEnv — the path the app expects, with the bytes outside the tree', () => {
  it('reads a repo → non-checkout source map, and defaults to nothing rather than guessing', () => {
    const f = join(tmpdir(), `forge-cfg-${process.pid}.json`)
    writeFileSync(f, JSON.stringify({
      instanceId: 'i-abc', region: 'eu-west-2',
      appEnv: { 'astera-app': '/home/amar/.config/astera/app.env' },
    }))
    expect(forgeConfig({ file: f })!.appEnv).toEqual({ 'astera-app': '/home/amar/.config/astera/app.env' })
    writeFileSync(f, JSON.stringify({ instanceId: 'i-abc', region: 'eu-west-2' }))
    // No entry = the step is inert. It must never invent a source path, because
    // linking .env at a guess is worse than leaving it absent.
    expect(forgeConfig({ file: f })!.appEnv).toEqual({})
    rmSync(f, { force: true })
  })
})

describe('the credential mirror must keep replacing files, not writing into them', () => {
  const m = { files: ['app.env', 'neon.env'], remoteDir: '/home/amar/.config/astera' }

  it('never uses --inplace, because the box\'s copy is deliberately read-only', () => {
    const argv = credentialRsyncArgv(m, '/home/amar/.config/astera', 'forge')
    // appEnv leaves the box's copy 0400 so nothing can append through the
    // symlinks pointing at it. rsync's default temp-file-and-rename replaces a
    // 0400 destination fine; --inplace writes through the inode and would be
    // REFUSED — so the owner's edits would stop arriving while every mode and
    // log line still looked right. Verified on the box before locking it here.
    expect(argv).not.toContain('--inplace')
    expect(argv).not.toContain('--append')
    expect(argv).not.toContain('--append-verify')
  })

  it('carries only the named files, deletes strays, and pins 0700/0600', () => {
    const argv = credentialRsyncArgv(m, '/home/amar/.config/astera', 'forge')
    expect(argv).toContain('--chmod=D700,F600')
    expect(argv).toContain('--delete')
    expect(argv.join(' ')).toContain('--include app.env --include neon.env --exclude *')
    expect(argv.at(-1)).toBe('forge:/home/amar/.config/astera/')
  })

  it('carries NO glob — an unlisted credential must not reach a shared box', () => {
    // The regression this exists for: `--include '*.env'` put 41 files on the
    // box, two of which held the real prod Vercel Blob RW token. An allow-list
    // makes a new desktop credential private by default; a glob made it public
    // by default and needed a hash sweep to notice.
    const argv = credentialRsyncArgv(m, '/home/amar/.config/astera', 'forge')
    expect(argv.filter((a) => a === '--include')).toHaveLength(2)
    expect(argv.some((a) => a.includes('*') && a !== '*')).toBe(false)
    for (const unlisted of ['blob.env', 'front-sync.staging.env', 'stripe.env', 'xero.env']) {
      expect(argv).not.toContain(unlisted)
    }
  })

  it('is retroactive: --delete-excluded, or dropping a name would strand the copy already there', () => {
    // Plain --delete PROTECTS excluded files on the receiver. Without this flag,
    // removing a credential from the list would stop it being updated while
    // leaving the box's copy in place forever.
    expect(credentialRsyncArgv(m, '/l', 'forge')).toContain('--delete-excluded')
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
