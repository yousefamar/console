// Guard-gated cron: the scheduler runs a shell guard at each trigger and only
// wakes the agent when it exits 0 (token-free polling). Exercises fire() via
// runOnce() with real `bash -c` guards + a fake session capturing sendMessage.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubCronScheduler } from '../cron/scheduler.js'

const CSID = '11111111-1111-1111-1111-111111111111'

// Minimal Session stand-in — only what fire()/runGuard touch.
function fakeSession() {
  const sent: string[] = []
  return {
    id: 'session_1',
    claudeSessionId: CSID,
    status: 'idle' as const,
    cwd: process.env.HOME,
    sent,
    sendMessage(content: string) { sent.push(content) },
    logMessage() {},
  }
}

let dir: string
let session: ReturnType<typeof fakeSession>
let broadcasts: unknown[]

function makeScheduler() {
  broadcasts = []
  return new HubCronScheduler(
    join(dir, 'cron.json'),
    () => new Map([[session.id, session as never]]),
    (m) => broadcasts.push(m),
  )
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cron-guard-')); session = fakeSession() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('cron guard gate', () => {
  it('fires (wakes agent) when the guard exits 0, appending guard stdout', async () => {
    const s = makeScheduler()
    const t = s.add({ claudeSessionId: CSID, trigger: '0 * * * *', prompt: 'check the schedule', recurring: true, guard: 'echo "PAGE CHANGED"; exit 0' })
    const r = await s.runOnce(t.id)
    expect(r.ok).toBe(true)
    expect(session.sent).toHaveLength(1)
    expect(session.sent[0]).toContain('check the schedule')
    expect(session.sent[0]).toContain('PAGE CHANGED')            // guard stdout appended
    expect(s.list()[0]!.lastGuardResult).toBe('fired')
    expect(s.list()[0]!.lastFiredAt).toBeGreaterThan(0)
  })

  it('does NOT wake the agent when the guard exits non-zero (no change)', async () => {
    const s = makeScheduler()
    const t = s.add({ claudeSessionId: CSID, trigger: '0 * * * *', prompt: 'wake me', recurring: true, guard: 'exit 1' })
    const r = await s.runOnce(t.id)
    expect(r.ok).toBe(false)
    expect(session.sent).toHaveLength(0)                          // agent untouched — zero tokens
    const task = s.list()[0]!
    expect(task.lastGuardResult).toBe('skipped')
    expect(task.lastCheckedAt).toBeGreaterThan(0)
    expect(task.lastFiredAt).toBeUndefined()
  })

  it('a skipping guard does NOT count toward the auto-disable skip budget', async () => {
    const s = makeScheduler()
    const t = s.add({ claudeSessionId: CSID, trigger: '* * * * *', prompt: 'x', recurring: true, guard: 'exit 1' })
    for (let i = 0; i < 15; i++) await s.runOnce(t.id) // > MAX_SKIPS_BEFORE_DISABLE (10)
    const task = s.list()[0]!
    expect(task.consecutiveSkips).toBe(0)                         // guard skips aren't failures
    expect(task.disabledAt).toBeUndefined()                      // still scheduled
  })

  it('a guard that fails to run (spawn error) skips + records error, never wakes', async () => {
    const s = makeScheduler()
    // A syntactically-broken command → bash exits non-zero (treated as no-change,
    // proceed:false). Use a guaranteed-failing spawn instead: an unterminated
    // quote makes bash exit 2 (still non-zero → skip).
    const t = s.add({ claudeSessionId: CSID, trigger: '0 * * * *', prompt: 'x', recurring: true, guard: 'this-binary-does-not-exist-xyz' })
    const r = await s.runOnce(t.id)
    expect(r.ok).toBe(false)
    expect(session.sent).toHaveLength(0)
  })

  it('guardOutput is transient — never written to the persisted JSON', async () => {
    const s = makeScheduler()
    // Guard command is quiet; its OUTPUT (the echoed marker) must not persist.
    const t = s.add({ claudeSessionId: CSID, trigger: '0 * * * *', prompt: 'x', recurring: true, guard: 'printf TRANSIENTMARKER; exit 0' })
    await s.runOnce(t.id)
    s.flush()
    const persisted = JSON.parse(readFileSync(join(dir, 'cron.json'), 'utf-8'))
    expect(persisted.tasks[0]).not.toHaveProperty('guardOutput')       // transient field stripped
    expect(persisted.tasks[0].guard).toBe('printf TRANSIENTMARKER; exit 0') // guard cmd itself persists
  })

  it('a guardless task fires unconditionally (unchanged behavior)', async () => {
    const s = makeScheduler()
    const t = s.add({ claudeSessionId: CSID, trigger: '0 * * * *', prompt: 'always run', recurring: true })
    const r = await s.runOnce(t.id)
    expect(r.ok).toBe(true)
    expect(session.sent[0]).toBe('always run')                    // no guard-output suffix
  })

  it('guard survives persistence round-trip (survives hub restart)', async () => {
    const s = makeScheduler()
    s.add({ claudeSessionId: CSID, trigger: '0 * * * *', prompt: 'x', recurring: true, guard: 'exit 0' })
    s.flush()
    // Fresh scheduler loading the same file = a hub restart
    const s2 = makeScheduler()
    expect(s2.list()[0]!.guard).toBe('exit 0')
  })
})
