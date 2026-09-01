import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubCronScheduler } from '../cron/scheduler.js'
import type { Session } from '../session.js'
import type { PushMessage } from '../push.js'

// A daily trigger that will never fire inside a test run — every fire in these
// tests goes through runOnce().
const TRIGGER = '0 0 * * *'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function make(sessions: Map<string, Session> = new Map()) {
  const dir = mkdtempSync(join(tmpdir(), 'cron-alerts-'))
  dirs.push(dir)
  const pushes: PushMessage[] = []
  const sched = new HubCronScheduler(
    join(dir, 'agent-cron.json'),
    () => sessions,
    () => {},
    () => {},
    (m) => pushes.push(m),
  )
  return { sched, pushes }
}

function liveSession(claudeSessionId: string): Session {
  return {
    id: 'hub-1',
    claudeSessionId,
    status: 'running',
    logMessage: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as Session
}

describe('HubCronScheduler skip alerts', () => {
  it('pushes a warning on the 3rd consecutive skip, once', async () => {
    const { sched, pushes } = make()
    const task = sched.add({ claudeSessionId: 'dead', trigger: TRIGGER, prompt: 'do the thing', recurring: true })
    for (let i = 0; i < 4; i++) await sched.runOnce(task.id)
    const warns = pushes.filter((p) => p.title?.includes('skipping'))
    expect(warns).toHaveLength(1)
    expect(warns[0].id).toBe(`cron:${task.id}`)
    expect(warns[0].body).toContain('session not found')
    sched.remove(task.id)
    sched.flush()
  })

  it('pushes an alert when the task auto-disables at 10 skips', async () => {
    const { sched, pushes } = make()
    const task = sched.add({ claudeSessionId: 'dead', trigger: TRIGGER, prompt: 'do the thing', recurring: true })
    for (let i = 0; i < 10; i++) await sched.runOnce(task.id)
    const disables = pushes.filter((p) => p.title?.includes('auto-disabled'))
    expect(disables).toHaveLength(1)
    expect(disables[0].body).toContain('10 skips')
    const persisted = sched.list().find((t) => t.id === task.id)
    expect(persisted?.disabledAt).toBeTypeOf('number')
    // Once disabled, further fires are refused without another push.
    expect(await sched.runOnce(task.id)).toEqual({ ok: false, reason: 'disabled' })
    expect(pushes.filter((p) => p.title?.includes('auto-disabled'))).toHaveLength(1)
    sched.flush()
  })

  it('reports "session ended" skips distinctly', async () => {
    const sessions = new Map<string, Session>([['s1', { ...liveSession('cs-1'), status: 'ended' } as unknown as Session]])
    const { sched, pushes } = make(sessions)
    const task = sched.add({ claudeSessionId: 'cs-1', trigger: TRIGGER, prompt: 'ping', recurring: true })
    for (let i = 0; i < 3; i++) await sched.runOnce(task.id)
    expect(pushes).toHaveLength(1)
    expect(pushes[0].body).toContain('session ended')
    sched.remove(task.id)
    sched.flush()
  })

  it('a successful fire resets the skip counter, so no alert fires later', async () => {
    const sessions = new Map<string, Session>()
    const { sched, pushes } = make(sessions)
    const task = sched.add({ claudeSessionId: 'cs-1', trigger: TRIGGER, prompt: 'ping', recurring: true })
    await sched.runOnce(task.id)
    await sched.runOnce(task.id) // two skips — one short of the warning
    sessions.set('s1', liveSession('cs-1'))
    expect(await sched.runOnce(task.id)).toEqual({ ok: true })
    sessions.delete('s1')
    await sched.runOnce(task.id)
    await sched.runOnce(task.id)
    expect(pushes).toHaveLength(0) // counter reset — never reached 3 in a row
    sched.remove(task.id)
    sched.flush()
  })

  it('does not throw when the notify sink throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-alerts-'))
    dirs.push(dir)
    const sched = new HubCronScheduler(
      join(dir, 'agent-cron.json'),
      () => new Map(),
      () => {},
      () => {},
      () => { throw new Error('push down') },
    )
    const task = sched.add({ claudeSessionId: 'dead', trigger: TRIGGER, prompt: 'x', recurring: true })
    // An unhandled rejection here fails the test — notifySafe must swallow it.
    for (let i = 0; i < 10; i++) await sched.runOnce(task.id)
    expect(sched.list().find((t) => t.id === task.id)?.disabledAt).toBeTypeOf('number')
    sched.flush()
  })
})
