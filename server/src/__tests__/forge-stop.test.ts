// How the hub puts a session's process down on purpose (respawn, hibernation,
// move). For a forge session that process is the ssh CLIENT, and the signal
// matters: measured on the box 9 Oct 2026, SIGKILL of a client on its own SSM
// tunnel left the remote stdin open four minutes later, so the watchdog never
// fired and the old agent worked on beside its replacement.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

class MockProcess extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() }
  stdout = new Readable({ read() {} })
  stderr = new Readable({ read() {} })
  pid = 4242
  exitCode: number | null = null
  signalCode: string | null = null
  signals: string[] = []
  constructor(public spawnfile: string) { super() }
  /** Records the signal and nothing else: the test decides when it exits. */
  kill(signal = 'SIGTERM') { this.signals.push(signal); return true }
  exit(code: number) { this.exitCode = code; this.emit('exit', code) }
}

let spawns: MockProcess[] = []
const noteForgeSpawn = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: (command: string) => {
    const p = new MockProcess(command)
    spawns.push(p)
    return p
  },
  execFile: (_c: string, _a: string[], _o: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => cb?.(null, { stdout: '' }),
  execSync: () => '',
}))
vi.mock('../auth-backend.js', () => ({ detectActiveBackend: () => 'bedrock' }))
vi.mock('../forge/index.js', async (orig) => ({
  ...(await orig<typeof import('../forge/index.js')>()),
  forgeConfig: () => ({ instanceId: 'i-test', region: 'us-east-1', host: 'forge', sshKey: '', remoteUser: 'amar', idleStopMinutes: 30 }),
  remoteCommandArgv: () => ['forge', 'claude'],
  forgeSshEnv: () => ({}),
  noteForgeUse: () => {},
  noteForgeSpawn: () => noteForgeSpawn(),
}))
vi.mock('../forge/agent-env.js', async (orig) => ({
  ...(await orig<typeof import('../forge/agent-env.js')>()),
  forgeSpawnPlan: () => ({ backend: 'bedrock' }),
  forgeMaxLoginDir: () => null,
  remoteBedrockEnv: () => ({}),
}))

const { Session } = await import('../session.js')

const last = () => spawns.at(-1)!
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
function userWrites(p: MockProcess): string[] {
  return p.stdin.write.mock.calls.map((c: string[]) => JSON.parse(c[0])).filter((w: any) => w.type === 'user').map((w: any) => w.message.content)
}
async function idleSession(placement?: 'forge') {
  const s = new Session({ prompt: 'go', ...(placement ? { placement } : {}) })
  const p = last()
  p.stdout.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'csid_stop', model: 'claude-opus-5-5', slash_commands: [] }) + '\n')
  p.stdout.push(JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1, session_id: 'csid_stop', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }) + '\n')
  await tick()
  return { s, p }
}

describe('putting a session\'s process down on purpose', () => {
  beforeEach(() => { spawns = []; noteForgeSpawn.mockClear(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
  afterEach(() => vi.useRealTimers())

  it('a local claude is SIGKILLed — instant, nothing to flush', async () => {
    const { s, p } = await idleSession()
    expect(p.spawnfile).not.toBe('ssh')
    expect(s.hibernate()).toBe(true)
    expect(p.signals).toEqual(['SIGKILL'])
  })

  it('a forge session\'s ssh client is ASKED to exit, so it closes its connection', async () => {
    const { s, p } = await idleSession('forge')
    expect(p.spawnfile).toBe('ssh')
    expect(s.hibernate()).toBe(true)
    expect(p.signals).toEqual(['SIGTERM'])
    // ssh exits 255 when a signal ends it. That is the hibernation landing,
    // not a transport fault to retry and not a model failure.
    const failures: string[] = []
    s.on('model_failure', (_m: string, r: string) => failures.push(r))
    p.exit(255)
    expect(s.hibernated).toBe(true)
    expect(failures).toEqual([])
    vi.advanceTimersByTime(60_000)
    expect(p.signals).toEqual(['SIGTERM'])
    expect(spawns).toHaveLength(1)
  })

  it('an ssh client that has not gone after the grace is killed after all', async () => {
    const { s, p } = await idleSession('forge')
    s.hibernate()
    vi.advanceTimersByTime(1_900)
    expect(p.signals).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(200)
    expect(p.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('a model or backend respawn of a forge session stops the old client the same way, then respawns', async () => {
    const { s, p } = await idleSession('forge')
    s.restartForModelChange()
    expect(p.signals).toEqual(['SIGTERM'])
    expect(spawns).toHaveLength(1)
    p.exit(255)
    expect(spawns).toHaveLength(2)
    expect(last().spawnfile).toBe('ssh')
    vi.advanceTimersByTime(5_000)
    // The grace timer belongs to the OLD client; the new one is never signalled.
    expect(last().signals).toEqual([])
    expect(p.signals).toEqual(['SIGTERM'])
  })

  it('reload() and a move off the box do too', async () => {
    const a = await idleSession('forge')
    a.s.reload()
    expect(a.p.signals).toEqual(['SIGTERM'])
    const b = await idleSession('forge')
    expect(b.s.applyPlacement('local', null)).toEqual({ ok: true })
    expect(b.p.signals).toEqual(['SIGTERM'])
  })

  it('tells the hub every time a forge agent is started — the post-respawn reap hangs off it', async () => {
    const { s, p } = await idleSession('forge')
    expect(noteForgeSpawn).toHaveBeenCalledTimes(1)
    s.restartForModelChange()
    p.exit(255)
    expect(noteForgeSpawn).toHaveBeenCalledTimes(2)
    await idleSession()
    expect(noteForgeSpawn).toHaveBeenCalledTimes(2)
  })
})

describe('a hub note owed with the next message', () => {
  beforeEach(() => { spawns = [] })

  it('rides in front of the next message once, and never wakes the session by itself', async () => {
    const { s, p } = await idleSession('forge')
    const before = userWrites(p).length
    s.nextMessageNote = '[Console hub] Your dev-server port on forge is now 5198, not 5183.'
    await tick()
    expect(userWrites(p)).toHaveLength(before)
    s.sendMessage('carry on')
    s.sendMessage('and again')
    expect(userWrites(p).slice(before)).toEqual([
      '[Console hub] Your dev-server port on forge is now 5198, not 5183.\n\ncarry on',
      'and again',
    ])
    expect(s.nextMessageNote).toBe(null)
  })

  it('survives a restore: it is a session option', async () => {
    const s = new Session({ prompt: '', silent: true, resume: 'csid_note', hibernateOnStart: true, nextMessageNote: 'owed' })
    expect(s.nextMessageNote).toBe('owed')
  })
})
