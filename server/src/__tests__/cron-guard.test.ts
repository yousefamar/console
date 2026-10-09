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

// ---------------------------------------------------------------------------
// A guard that cannot CHECK is not a guard that found nothing.
// ---------------------------------------------------------------------------

import { classifyGuardExit } from '../cron/scheduler.js'

describe('classifyGuardExit', () => {
  it('exit 1 with nothing alarming on stderr is "nothing to do"', () => {
    expect(classifyGuardExit(1, '')).toBeNull()
    expect(classifyGuardExit(1, 'no new mail\n')).toBeNull()
  })

  it('any other exit code is a failure to check', () => {
    expect(classifyGuardExit(2, '')).toBe('exit 2')
    expect(classifyGuardExit(28, 'curl: (28) Operation timed out after 10001 milliseconds\n')).toBe('exit 28: curl: (28) Operation timed out after 10001 milliseconds')
    expect(classifyGuardExit(127, 'bash: line 1: nosuchtool: command not found\n')).toBe('crashed (exit 127): bash: line 1: nosuchtool: command not found')
  })

  it('recognises a crash that exits 1, which is what an uncaught exception does', () => {
    // The real one, 9 Oct 2026: a guard's own 40 s timeout on a slow `con`.
    const stderr = 'Traceback (most recent call last):\n  File "guard.py", line 96, in main\n    for s in sessions():\nsubprocess.TimeoutExpired: Command \'[con, agent, list]\' timed out after 40 seconds\n'
    expect(classifyGuardExit(1, stderr)).toBe("crashed (exit 1): subprocess.TimeoutExpired: Command '[con, agent, list]' timed out after 40 seconds")
    expect(classifyGuardExit(1, 'guard.sh: line 12: syntax error near unexpected token `fi\'\n')).toMatch(/^crashed \(exit 1\)/)
  })
})

describe('a failing guard reaches its owner', () => {
  const crash = `python3 -c 'raise TimeoutError("con agent list timed out after 40 seconds")'`

  it('records a crash as an error, not as "no change"', async () => {
    const s = makeScheduler()
    const t = s.add({ claudeSessionId: CSID, trigger: '*/5 * * * *', prompt: 'p', recurring: true, guard: crash })
    await s.runOnce(t.id)
    const task = s.list()[0]!
    expect(task.lastGuardResult).toBe('error')
    expect(task.lastSkipReason).toMatch(/^guard error: crashed \(exit 1\): TimeoutError: con agent list timed out/)
    expect(task.guardErrorStreak).toBe(1)
    expect(session.sent).toHaveLength(0)           // one failure is not worth a wake
  })

  it('wakes the owner on the third failure in a row, once, and never with the task prompt', async () => {
    const s = makeScheduler()
    const t = s.add({ claudeSessionId: CSID, trigger: '*/5 * * * *', prompt: 'THE REAL PROMPT', recurring: true, guard: 'echo "could not reach the hub" >&2; exit 2' })
    await s.runOnce(t.id)
    await s.runOnce(t.id)
    expect(session.sent).toHaveLength(0)
    await s.runOnce(t.id)
    expect(session.sent).toHaveLength(1)
    expect(session.sent[0]).toContain('[HUB CRON — GUARD FAILING]')
    expect(session.sent[0]).toContain(`\`${t.id}\``)
    expect(session.sent[0]).toContain('3 runs in a row')
    expect(session.sent[0]).toContain('Last failure: exit 2: could not reach the hub')
    expect(session.sent[0]).not.toContain('THE REAL PROMPT')
    for (let i = 0; i < 20; i++) await s.runOnce(t.id)
    expect(session.sent).toHaveLength(1)           // told once, not every five minutes
    expect(s.list()[0]!.lastFiredAt).toBeUndefined()
    expect(s.list()[0]!.disabledAt).toBeUndefined()
  })

  it('a guard that the hub had to kill at its own cap counts too', async () => {
    // That path was already labelled an error; it just never reached anyone.
    const s = makeScheduler()
    const t = s.add({ claudeSessionId: CSID, trigger: '*/5 * * * *', prompt: 'p', recurring: true, guard: 'kill -9 $$' })
    for (let i = 0; i < 3; i++) await s.runOnce(t.id)
    expect(s.list()[0]!.lastGuardResult).toBe('error')
    expect(session.sent).toHaveLength(1)
  })

  it('one good check ends the streak, and a new streak is reported afresh', async () => {
    const flag = join(dir, 'broken')
    const s = makeScheduler()
    const t = s.add({ claudeSessionId: CSID, trigger: '*/5 * * * *', prompt: 'p', recurring: true, guard: `[ -e ${flag} ] && exit 2; exit 1` })
    const { writeFileSync, unlinkSync } = await import('node:fs')
    writeFileSync(flag, '')
    for (let i = 0; i < 3; i++) await s.runOnce(t.id)
    expect(session.sent).toHaveLength(1)
    unlinkSync(flag)
    await s.runOnce(t.id)                           // "nothing to do": the guard can look again
    expect(s.list()[0]!.guardErrorStreak).toBe(0)
    expect(s.list()[0]!.lastSkipReason).toBe('guard: no change')
    writeFileSync(flag, '')
    for (let i = 0; i < 3; i++) await s.runOnce(t.id)
    expect(session.sent).toHaveLength(2)           // not muffled by the six-hour re-alert
  })

  it('plain "nothing to do" never wakes anyone, however long it goes on', async () => {
    const s = makeScheduler()
    const t = s.add({ claudeSessionId: CSID, trigger: '*/5 * * * *', prompt: 'p', recurring: true, guard: 'exit 1' })
    for (let i = 0; i < 50; i++) await s.runOnce(t.id)
    expect(session.sent).toHaveLength(0)
    expect(s.list()[0]!.guardErrorStreak).toBe(0)
  })
})
