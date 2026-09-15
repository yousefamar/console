// Cron removal is guarded, logged and announced. Why: on 2026-09-11 one agent
// bulk-removed every task whose prompt contained "merge" — `con cron list` is
// fleet-wide, so that took out ANOTHER session's recurring weekly sweep, and
// nothing logged it or told the owner. Three defences: DELETE /cron/:id 403s
// an agent removing a task it doesn't own (unless ?force=1), every removal
// logs its actor, and a cross-actor removal wakes the owning session.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HubCronScheduler } from '../cron/scheduler.js'
import { handleCronRoutes } from '../routes/cron.js'
import type { Session } from '../session.js'
import type { PushMessage } from '../push.js'

const OWNER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function session(id: string, csid: string, agentKey: string, name: string): Session {
  return {
    id, claudeSessionId: csid, agentKey, name, status: 'idle',
    logMessage: vi.fn(), sendMessage: vi.fn(),
  } as unknown as Session
}

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'cron-remove-'))
  dirs.push(dir)
  const owner = session('hub-owner', OWNER, 'mobile', 'Console mobile')
  const other = session('hub-other', OTHER, 'astera', 'Astera general')
  const sessions = new Map<string, Session>([['hub-owner', owner], ['hub-other', other]])
  const logs: string[] = []
  const pushes: PushMessage[] = []
  const broadcasts: unknown[] = []
  const sched = new HubCronScheduler(join(dir, 'agent-cron.json'), () => sessions, (m) => broadcasts.push(m), (m) => logs.push(m), (m) => pushes.push(m))
  const task = sched.add({ claudeSessionId: OWNER, trigger: '0 5 * * 0', prompt: 'weekly sweep — reconcile the [MERGE] fold-ins', recurring: true })
  return { sched, task, owner, other, sessions, logs, pushes, broadcasts }
}

function del(id: string, actor?: string, force = false) {
  const req = new EventEmitter() as unknown as IncomingMessage
  ;(req as { method?: string }).method = 'DELETE'
  ;(req as { headers: Record<string, string> }).headers = actor ? { 'x-console-agent': actor } : {}
  let status = 0
  let body: unknown
  const res = {
    writeHead: (s: number) => { status = s },
    end: (b: string) => { body = JSON.parse(b) },
  } as unknown as ServerResponse
  return { req, res, url: new URL(`http://x/cron/${id}${force ? '?force=1' : ''}`), path: `/cron/${id}`, result: () => ({ status, body }) }
}

describe('cron removal guard', () => {
  it('an agent cannot remove another session\'s task (403, task intact)', () => {
    const { sched, task, sessions } = make()
    const d = del(task.id, 'astera')
    handleCronRoutes(d.req, d.res, d.path, d.url, { scheduler: sched, getSessions: () => sessions, getAlConnected: () => false, log: () => {} }, async () => '')
    const { status, body } = d.result()
    expect(status).toBe(403)
    expect((body as { error: string }).error).toMatch(/Console mobile/)
    expect(sched.get(task.id)).toBeDefined()
  })

  it('the owning agent removes its own task without ceremony — no owner wake, no push', () => {
    const { sched, task, sessions, owner, pushes } = make()
    const d = del(task.id, 'mobile')
    handleCronRoutes(d.req, d.res, d.path, d.url, { scheduler: sched, getSessions: () => sessions, getAlConnected: () => false, log: () => {} }, async () => '')
    expect(d.result().status).toBe(200)
    expect(sched.get(task.id)).toBeUndefined()
    expect((owner as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage).not.toHaveBeenCalled()
    expect(pushes).toHaveLength(0)
  })

  it('--force removes a foreign task, logs the actor and wakes the owner with the prompt', () => {
    const { sched, task, sessions, owner, logs, pushes } = make()
    const d = del(task.id, 'astera', true)
    handleCronRoutes(d.req, d.res, d.path, d.url, { scheduler: sched, getSessions: () => sessions, getAlConnected: () => false, log: () => {} }, async () => '')
    expect(d.result().status).toBe(200)
    expect(sched.get(task.id)).toBeUndefined()
    expect(logs.some((l) => l.includes(`removed ${task.id}`) && l.includes('by astera') && l.includes('forced'))).toBe(true)
    const send = (owner as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage
    expect(send).toHaveBeenCalledTimes(1)
    const notice = send.mock.calls[0]![0] as string
    expect(notice).toMatch(/HUB CRON REMOVED/)
    expect(notice).toMatch(/astera/)
    expect(notice).toMatch(/weekly sweep/) // the full prompt rides along so it can be re-registered
    expect(pushes).toHaveLength(1)
  })

  it('a human client (no agent key) is unrestricted; the owner is told it was intentional', () => {
    const { sched, task, sessions, owner, pushes } = make()
    const d = del(task.id)
    handleCronRoutes(d.req, d.res, d.path, d.url, { scheduler: sched, getSessions: () => sessions, getAlConnected: () => false, log: () => {} }, async () => '')
    expect(d.result().status).toBe(200)
    expect(sched.get(task.id)).toBeUndefined()
    const send = (owner as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0] as string).toMatch(/do NOT re-add/)
    expect(pushes).toHaveLength(0) // Yousef did it himself — no push
  })

  it('a one-shot removing itself after firing is silent', () => {
    const { sched, owner, logs } = make()
    const once = sched.add({ claudeSessionId: OWNER, trigger: '2099-01-01T00:00:00', prompt: 'later', recurring: false })
    sched.remove(once.id, { actor: 'hub', reason: 'fired' })
    expect((owner as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes(`removed ${once.id}`) && l.includes('fired'))).toBe(true)
  })
})
