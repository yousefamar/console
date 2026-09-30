// `--fork` cron: a fire wakes a FRESH single-turn fork of the owning session
// (via the injected forkHooks) instead of the owner — the owner's context is
// never touched — and the fork is closed after its turn ends.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubCronScheduler, buildCronForkIdentity } from '../cron/scheduler.js'

const CSID = '11111111-1111-1111-1111-111111111111'

function fakeSession(id: string, csid: string, name: string) {
  const em = new EventEmitter()
  const sent: string[] = []
  return Object.assign(em, {
    id, claudeSessionId: csid, name, agentKey: name.toLowerCase().replace(/\s+/g, '-'),
    status: 'idle' as string, cwd: process.env.HOME, sent, needsAttention: null as unknown,
    sendMessage(content: string) { sent.push(content) },
    logMessage() {},
    queueMessage(content: string) { sent.push(`QUEUED:${content}`) },
    queuedMessage: null as string | null,
  })
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cron-fork-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.useRealTimers() })

describe('cron --fork', () => {
  it('wakes a fresh fork (not the owner), records the fork in lastOutcome, closes it after its result', async () => {
    vi.useFakeTimers()
    const owner = fakeSession('session_1', CSID, 'Astera general')
    const fork = fakeSession('session_9', '22222222-2222-2222-2222-222222222222', 'Cron abc (fork)')
    const closed: string[] = []
    const spawnFork = vi.fn(() => fork)
    const s = new HubCronScheduler(join(dir, 'cron.json'), () => new Map([[owner.id, owner as never]]), () => {}, () => {}, () => {},
      { spawnFork: spawnFork as never, closeFork: (f) => closed.push((f as unknown as { id: string }).id) })
    const t = s.add({ claudeSessionId: CSID, trigger: '0 * * * *', prompt: 'daily usage check', recurring: true, fork: true, model: 'haiku', guard: 'echo DELTA; exit 0' })
    expect(t.fork).toBe(true)
    expect(t.model).toBe('haiku')

    const r = await s.runOnce(t.id)
    expect(r.ok).toBe(true)
    expect(spawnFork).toHaveBeenCalledTimes(1)
    expect(spawnFork.mock.calls[0]![1]).toMatchObject({ id: t.id, model: 'haiku' })
    expect(owner.sent).toHaveLength(0)                       // the owner's context is never touched
    expect(fork.sent).toHaveLength(1)
    expect(fork.sent[0]).toContain('[CRON FORK]')
    expect(fork.sent[0]).toContain(`hub cron ${t.id}`)
    expect(fork.sent[0]).toContain('daily usage check')
    expect(fork.sent[0]).toContain('DELTA')                  // guard stdout still rides the prompt
    expect(s.list()[0]!.lastOutcome).toMatch(/^forked → Cron abc \(fork\) on haiku/)
    expect(s.list()[0]!.lastFiredAt).toBeGreaterThan(0)

    // The fork is reaped 2 s after its first result.
    fork.emit('hub_message', { type: 'result', cost: 0.5 })
    expect(closed).toEqual([])
    vi.advanceTimersByTime(2_500)
    expect(closed).toEqual(['session_9'])
  })

  it('skips (and counts a skip) when fork hooks are not wired', async () => {
    const owner = fakeSession('session_1', CSID, 'Owner')
    const s = new HubCronScheduler(join(dir, 'cron.json'), () => new Map([[owner.id, owner as never]]), () => {})
    const t = s.add({ claudeSessionId: CSID, trigger: '0 * * * *', prompt: 'p', recurring: true, fork: true })
    const r = await s.runOnce(t.id)
    expect(r.ok).toBe(false)
    expect(owner.sent).toHaveLength(0)
    expect(s.list()[0]!.lastOutcome).toContain('fork wakes are not wired')
  })

  it('a plain task never spawns a fork, and model is dropped without fork', async () => {
    const owner = fakeSession('session_1', CSID, 'Owner')
    const spawnFork = vi.fn()
    const s = new HubCronScheduler(join(dir, 'cron.json'), () => new Map([[owner.id, owner as never]]), () => {}, () => {}, () => {},
      { spawnFork: spawnFork as never, closeFork: () => {} })
    const t = s.add({ claudeSessionId: CSID, trigger: '0 * * * *', prompt: 'p', recurring: true, model: 'haiku' })
    expect(t.fork).toBeUndefined()
    expect(t.model).toBeUndefined()
    await s.runOnce(t.id)
    expect(spawnFork).not.toHaveBeenCalled()
    expect(owner.sent).toHaveLength(1)
  })

  it('identity names the fork, its csid, the owner and the cron', () => {
    const text = buildCronForkIdentity({ agentKey: 'astera-general-abc-fork', claudeSessionId: 'f0f0' }, { name: 'Astera general', agentKey: 'astera-general', cwd: '/x' }, { id: 'abc', trigger: '0 7 * * *' })
    expect(text).toContain('[CRON FORK]')
    expect(text).toContain('"Astera general" (@astera-general)')
    expect(text).toContain('hub cron abc (trigger `0 7 * * *`)')
    expect(text).toContain('--session-id f0f0')
    expect(text).toContain('Do not remove or edit this cron')
  })
})
