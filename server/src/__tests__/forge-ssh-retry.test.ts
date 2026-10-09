import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { HubMessage } from '../protocol.js'

class MockProcess extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() }
  stdout = new Readable({ read() {} })
  stderr = new Readable({ read() {} })
  pid = 4242
  kill(signal?: string) { this.emit('exit', signal === 'SIGINT' ? 130 : 0) }
}

let spawns: Array<{ command: string; args: string[] }> = []
let proc: MockProcess

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawns.push({ command, args })
    proc = new MockProcess()
    return proc
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
}))
vi.mock('../forge/agent-env.js', async (orig) => ({
  ...(await orig<typeof import('../forge/agent-env.js')>()),
  forgeSpawnPlan: () => ({ backend: 'bedrock' }),
  forgeMaxLoginDir: () => null,
  remoteBedrockEnv: () => ({}),
}))

const { Session } = await import('../session.js')

function out(obj: Record<string, unknown>) { proc.stdout.push(JSON.stringify(obj) + '\n') }
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
function userWrites(p: MockProcess): string[] {
  return p.stdin.write.mock.calls.map((c: string[]) => JSON.parse(c[0])).filter((w: any) => w.type === 'user').map((w: any) => w.message.content)
}

async function idleForgeSession() {
  const s = new Session({ prompt: 'go', placement: 'forge' })
  out({ type: 'system', subtype: 'init', session_id: 'csid_forge', model: 'claude-opus-5-5', slash_commands: [] })
  out({ type: 'result', subtype: 'success', duration_ms: 1, session_id: 'csid_forge', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
  await tick()
  s.hibernate()
  await tick()
  return s
}

describe('forge spawn that dies on ssh before init (9 Oct 2026)', () => {
  beforeEach(() => { spawns = []; vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
  afterEach(() => vi.useRealTimers())

  it('retries the spawn and re-delivers the message the dead pipe swallowed', async () => {
    const s = await idleForgeSession()
    const failures: string[] = []
    s.on('model_failure', (_m: string, r: string) => failures.push(r))
    s.sendMessage('continue the work')
    const dead = proc
    expect(userWrites(dead)).toEqual(['continue the work'])
    const before = spawns.length
    dead.emit('exit', 255)
    expect(failures).toEqual([])
    expect(s.hibernated).toBe(true)
    expect(spawns.length).toBe(before)
    vi.advanceTimersByTime(31_000)
    expect(spawns.length).toBe(before + 1)
    expect(spawns.at(-1)!.args).toEqual(['forge', 'claude'])
    expect(userWrites(proc)).toEqual(['continue the work'])
    expect(s.status).toBe('running')
  })

  it('a message arriving before the retry carries the lost one with it', async () => {
    const s = await idleForgeSession()
    s.sendMessage('lost nudge')
    proc.emit('exit', 255)
    s.sendMessage('new message')
    expect(userWrites(proc)).toEqual(['lost nudge\n\nnew message'])
    const spawnsNow = spawns.length
    vi.advanceTimersByTime(120_000)
    expect(spawns.length).toBe(spawnsNow)
  })

  it('gives up after three attempts and leaves the session resumable', async () => {
    const s = await idleForgeSession()
    const msgs: HubMessage[] = []
    s.on('hub_message', (m: HubMessage) => msgs.push(m))
    s.sendMessage('try')
    for (let i = 0; i < 3; i++) {
      proc.emit('exit', 255)
      vi.advanceTimersByTime(80_000)
    }
    proc.emit('exit', 255)
    expect(s.hibernated).toBe(true)
    expect(s.status).toBe('idle')
    expect(msgs.some((m) => m.type === 'session_ended')).toBe(false)
  })

  it('an idle respawn that dies on ssh with nothing to deliver just hibernates, no model failure', async () => {
    const s = await idleForgeSession()
    const failures: string[] = []
    s.on('model_failure', (_m: string, r: string) => failures.push(r))
    s.restartForModelChange() // hibernated → no-op; wake it with nothing pending instead
    ;(s as any).wakeFromHibernation()
    const before = spawns.length
    proc.emit('exit', 255)
    vi.advanceTimersByTime(120_000)
    expect(failures).toEqual([])
    expect(spawns.length).toBe(before)
    expect(s.hibernated).toBe(true)
  })
})
