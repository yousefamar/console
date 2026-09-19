// Every fire attempt must leave a recorded outcome. Background: on 2026-09-14
// a weekly task's fire vanished — no lastFiredAt, no skip, no push — because
// fire() rejections escaped into a `void`ed promise, protect was inert, and a
// busy session got a mid-turn stdin write. These pin the three fixes plus the
// missed-fire sweep that catches "croner never called us".

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubCronScheduler, type HubCronTask } from '../cron/scheduler.js'
import type { Session } from '../session.js'
import type { PushMessage } from '../push.js'

const TRIGGER = '0 0 * * *'
const CSID = 'cs-1'

const dirs: string[] = []
const scheds: HubCronScheduler[] = []
afterEach(() => {
  for (const s of scheds.splice(0)) s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function make(sessions: Map<string, Session> = new Map(), seed?: Partial<HubCronTask>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'cron-outcome-'))
  dirs.push(dir)
  const file = join(dir, 'agent-cron.json')
  if (seed) writeFileSync(file, JSON.stringify({ tasks: seed, icsToken: '' }))
  const pushes: PushMessage[] = []
  const logs: string[] = []
  const sched = new HubCronScheduler(file, () => sessions, () => {}, (m) => logs.push(m), (m) => pushes.push(m))
  scheds.push(sched)
  return { sched, pushes, logs, file }
}

function session(over: Partial<Record<keyof Session, unknown>> = {}): Session {
  return {
    id: 'hub-1',
    claudeSessionId: CSID,
    status: 'idle',
    queuedMessage: null,
    logMessage: vi.fn(),
    sendMessage: vi.fn(),
    queueMessage: vi.fn(),
    ...over,
  } as unknown as Session
}

describe('a fire that throws is a recorded skip, never a silent drop', () => {
  it('records the throw as a skip and resolves (does not reject)', async () => {
    const s = session({ sendMessage: vi.fn(() => { throw new Error('stdin exploded') }) })
    const { sched } = make(new Map([['s1', s]]))
    const task = sched.add({ claudeSessionId: CSID, trigger: TRIGGER, prompt: 'ping', recurring: true })
    const before = Date.now()
    const r = await sched.runOnce(task.id)
    expect(r).toEqual({ ok: false, reason: 'fire threw: stdin exploded' })
    const t = sched.get(task.id)!
    expect(t.consecutiveSkips).toBe(1)
    expect(t.lastSkipReason).toBe('fire threw: stdin exploded')
    expect(t.lastOutcome).toBe('skipped: fire threw: stdin exploded')
    expect(t.lastAttemptAt).toBeGreaterThanOrEqual(before)
    expect(t.lastFiredAt).toBeUndefined()
  })

  it('ten consecutive throws auto-disable the task with a push, like any other skip', async () => {
    const s = session({ sendMessage: vi.fn(() => { throw new Error('boom') }) })
    const { sched, pushes } = make(new Map([['s1', s]]))
    const task = sched.add({ claudeSessionId: CSID, trigger: TRIGGER, prompt: 'ping', recurring: true })
    for (let i = 0; i < 10; i++) await sched.runOnce(task.id)
    expect(sched.get(task.id)!.disabledAt).toBeTypeOf('number')
    expect(pushes.some((p) => p.title?.includes('auto-disabled'))).toBe(true)
  })
})

describe('a busy session gets the prompt queued, not written mid-turn', () => {
  it('queues via the session queue and counts as fired', async () => {
    const s = session({ status: 'running' })
    const { sched } = make(new Map([['s1', s]]))
    const task = sched.add({ claudeSessionId: CSID, trigger: TRIGGER, prompt: 'nightly sweep', recurring: true })
    expect(await sched.runOnce(task.id)).toEqual({ ok: true })
    expect(s.queueMessage).toHaveBeenCalledWith('nightly sweep')
    expect(s.sendMessage).not.toHaveBeenCalled()
    const t = sched.get(task.id)!
    expect(t.lastOutcome).toBe('queued (session mid-turn)')
    expect(t.lastFiredAt).toBeTypeOf('number')
    expect(t.consecutiveSkips).toBe(0)
  })

  it('does not stack the same prompt when it is already pending', async () => {
    const s = session({ status: 'running', queuedMessage: 'nightly sweep' })
    const { sched } = make(new Map([['s1', s]]))
    const task = sched.add({ claudeSessionId: CSID, trigger: TRIGGER, prompt: 'nightly sweep', recurring: true })
    expect(await sched.runOnce(task.id)).toEqual({ ok: true })
    expect(s.queueMessage).not.toHaveBeenCalled()
    expect(sched.get(task.id)!.lastOutcome).toBe('queued (already pending from an earlier fire)')
  })

  it('an idle session still gets the direct stdin path', async () => {
    const s = session()
    const { sched } = make(new Map([['s1', s]]))
    const task = sched.add({ claudeSessionId: CSID, trigger: TRIGGER, prompt: 'go', recurring: true })
    await sched.runOnce(task.id)
    expect(s.sendMessage).toHaveBeenCalledWith('go')
    expect(s.queueMessage).not.toHaveBeenCalled()
    expect(sched.get(task.id)!.lastOutcome).toBe('fired')
  })
})

describe('missed-fire sweep', () => {
  it('a task whose nextFireAt passed with no attempt is recorded as a skip and re-armed', () => {
    const { sched, logs } = make()
    const task = sched.add({ claudeSessionId: CSID, trigger: TRIGGER, prompt: 'x', recurring: true })
    expect(task.nextFireAt).toBeGreaterThan(Date.now())
    task.nextFireAt = Date.now() - 10 * 60_000
    const caught = sched.sweep()
    expect(caught.map((t) => t.id)).toEqual([task.id])
    expect(task.consecutiveSkips).toBe(1)
    expect(task.lastSkipReason).toMatch(/^missed fire due .* — scheduler never ran it$/)
    expect(task.lastOutcome).toBe(`skipped: ${task.lastSkipReason}`)
    expect(task.nextFireAt).toBeGreaterThan(Date.now())
    expect(logs.some((l) => l.includes(task.id) && l.includes('missed fire'))).toBe(true)
  })

  it('a fire attempted after the due time is not a miss', () => {
    const { sched } = make()
    const task = sched.add({ claudeSessionId: CSID, trigger: TRIGGER, prompt: 'x', recurring: true })
    task.nextFireAt = Date.now() - 10 * 60_000
    task.lastAttemptAt = task.nextFireAt + 5
    expect(sched.sweep()).toEqual([])
    expect(task.consecutiveSkips).toBe(0)
  })

  it('inside the grace window nothing is flagged', () => {
    const { sched } = make()
    const task = sched.add({ claudeSessionId: CSID, trigger: TRIGGER, prompt: 'x', recurring: true })
    task.nextFireAt = Date.now() - 30_000
    expect(sched.sweep()).toEqual([])
  })

  it('start() records a fire the previous hub process owed', () => {
    const due = Date.now() - 60 * 60_000
    const { sched } = make(new Map(), [{
      id: 'aaaaaaaa', claudeSessionId: CSID, trigger: TRIGGER, recurring: true, prompt: 'x',
      createdAt: due - 1, consecutiveSkips: 0, nextFireAt: due, lastAttemptAt: due - 86_400_000,
    }])
    sched.start()
    const t = sched.get('aaaaaaaa')!
    expect(t.consecutiveSkips).toBe(1)
    expect(t.lastSkipReason).toContain('hub was not running')
    expect(t.nextFireAt).toBeGreaterThan(Date.now())
  })

  it('a legacy task without nextFireAt is simply armed', () => {
    const { sched } = make(new Map(), [{
      id: 'bbbbbbbb', claudeSessionId: CSID, trigger: TRIGGER, recurring: true, prompt: 'x',
      createdAt: 1, consecutiveSkips: 0,
    }])
    sched.start()
    const t = sched.get('bbbbbbbb')!
    expect(t.consecutiveSkips).toBe(0)
    expect(t.nextFireAt).toBeGreaterThan(Date.now())
  })
})

describe('overdue one-shots', () => {
  it('an hour-overdue one-shot is re-armed to fire shortly, not lost', () => {
    const at = Date.now() - 60 * 60_000
    const { sched, logs } = make(new Map(), [{
      id: 'cccccccc', claudeSessionId: CSID, trigger: new Date(at).toISOString(), recurring: false, prompt: 'wake',
      createdAt: at - 1, consecutiveSkips: 0, nextFireAt: at,
    }])
    sched.start()
    const t = sched.get('cccccccc')!
    expect(t.disabledAt).toBeUndefined()
    expect(t.lastSkipReason).toContain('missed fire')
    expect(t.nextFireAt).toBeGreaterThan(Date.now())
    expect(t.nextFireAt).toBeLessThanOrEqual(Date.now() + 31_000)
    expect(logs.some((l) => l.includes('one-shot overdue'))).toBe(true)
    expect(sched.upcoming().find((u) => u.task.id === 'cccccccc')?.fires).toHaveLength(1)
  })

  it('a day-stale one-shot is recorded and disabled instead of waking anyone', () => {
    const at = Date.now() - 2 * 86_400_000
    const { sched } = make(new Map(), [{
      id: 'dddddddd', claudeSessionId: CSID, trigger: new Date(at).toISOString(), recurring: false, prompt: 'wake',
      createdAt: at - 1, consecutiveSkips: 0,
    }])
    sched.start()
    const t = sched.get('dddddddd')!
    expect(t.disabledAt).toBeTypeOf('number')
    expect(t.lastSkipReason).toMatch(/^one-shot 48h overdue/)
    expect(t.nextFireAt).toBeUndefined()
    expect(sched.upcoming()).toEqual([])
  })
})

describe('persistence', () => {
  it('lastAttemptAt / lastOutcome / nextFireAt round-trip; guardOutput still does not', async () => {
    const { sched, file } = make(new Map([['s1', session()]]))
    const task = sched.add({ claudeSessionId: CSID, trigger: TRIGGER, prompt: 'x', recurring: true, guard: 'echo hi; exit 0' })
    await sched.runOnce(task.id)
    sched.flush()
    const persisted = JSON.parse(readFileSync(file, 'utf-8')).tasks[0]
    expect(persisted.lastAttemptAt).toBeTypeOf('number')
    expect(persisted.lastOutcome).toBe('fired')
    expect(persisted.nextFireAt).toBeGreaterThan(Date.now())
    expect(persisted).not.toHaveProperty('guardOutput')
  })
})
