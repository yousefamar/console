// Cron absorption on merge: when a child session is merged into its parent, the
// parent takes over the child's active hub crons (reassignSession re-keys them)
// so they don't orphan + auto-disable when the child is killed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubCronScheduler } from '../cron/scheduler.js'

const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const PARENT = 'pppppppp-pppp-pppp-pppp-pppppppppppp'

let dir: string
function makeScheduler() {
  return new HubCronScheduler(join(dir, 'cron.json'), () => new Map(), () => {})
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cron-reassign-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('HubCronScheduler.reassignSession', () => {
  it('re-keys a child task onto the parent + persists', () => {
    const s = makeScheduler()
    const t = s.add({ claudeSessionId: CHILD, trigger: '0 * * * *', prompt: 'x', recurring: true })
    const moved = s.reassignSession(CHILD, PARENT)
    expect(moved).toHaveLength(1)
    expect(moved[0]!.id).toBe(t.id)
    expect(s.list()[0]!.claudeSessionId).toBe(PARENT)
    // Parent owns it now; the child owns nothing.
    expect(s.list({ claudeSessionId: PARENT })).toHaveLength(1)
    expect(s.list({ claudeSessionId: CHILD })).toHaveLength(0)
    // Persisted to disk (so it survives a hub restart under the new owner).
    s.flush()
    const persisted = JSON.parse(readFileSync(join(dir, 'cron.json'), 'utf-8'))
    expect(persisted.tasks[0].claudeSessionId).toBe(PARENT)
  })

  it('moves ALL of the child\'s active tasks, leaving other sessions\' tasks alone', () => {
    const s = makeScheduler()
    s.add({ claudeSessionId: CHILD, trigger: '0 * * * *', prompt: 'a', recurring: true })
    s.add({ claudeSessionId: CHILD, trigger: '30 * * * *', prompt: 'b', recurring: true })
    const other = 'oooooooo-oooo-oooo-oooo-oooooooooooo'
    s.add({ claudeSessionId: other, trigger: '0 * * * *', prompt: 'unrelated', recurring: true })
    const moved = s.reassignSession(CHILD, PARENT)
    expect(moved).toHaveLength(2)
    expect(s.list({ claudeSessionId: PARENT })).toHaveLength(2)
    expect(s.list({ claudeSessionId: other })).toHaveLength(1) // untouched
  })

  it('resets the skip streak so the parent doesn\'t inherit the child\'s misses', () => {
    const s = makeScheduler()
    const t = s.add({ claudeSessionId: CHILD, trigger: '0 * * * *', prompt: 'x', recurring: true })
    // Simulate a few "session not found" misses while the child was dying.
    s.list()[0]!.consecutiveSkips = 5
    s.list()[0]!.lastSkipReason = 'session not found'
    s.reassignSession(CHILD, PARENT)
    const moved = s.list().find((x) => x.id === t.id)!
    expect(moved.consecutiveSkips).toBe(0)
    expect(moved.lastSkipReason).toBeUndefined()
  })

  it('does NOT move disabled tasks (a dead cron stays dead)', () => {
    const s = makeScheduler()
    const t = s.add({ claudeSessionId: CHILD, trigger: '0 * * * *', prompt: 'x', recurring: true })
    s.list()[0]!.disabledAt = 1
    const moved = s.reassignSession(CHILD, PARENT)
    expect(moved).toHaveLength(0)
    expect(s.list().find((x) => x.id === t.id)!.claudeSessionId).toBe(CHILD) // unchanged
  })

  it('is a no-op for empty / identical ids', () => {
    const s = makeScheduler()
    s.add({ claudeSessionId: CHILD, trigger: '0 * * * *', prompt: 'x', recurring: true })
    expect(s.reassignSession('', PARENT)).toHaveLength(0)
    expect(s.reassignSession(CHILD, '')).toHaveLength(0)
    expect(s.reassignSession(CHILD, CHILD)).toHaveLength(0)
    expect(s.list()[0]!.claudeSessionId).toBe(CHILD)
  })

  it('the reassigned task still fires under the new owner', async () => {
    // The Cron job closes over the task OBJECT (mutated in place), so re-keying
    // shouldn't detach the schedule. Prove a manual runOnce resolves the PARENT.
    const sent: string[] = []
    const parentSession = {
      id: 'parent_sess', claudeSessionId: PARENT, status: 'idle' as const,
      cwd: process.env.HOME, sendMessage: (c: string) => sent.push(c), logMessage() {},
    }
    const s = new HubCronScheduler(
      join(dir, 'cron.json'),
      () => new Map([[parentSession.id, parentSession as never]]),
      () => {},
    )
    const t = s.add({ claudeSessionId: CHILD, trigger: '0 * * * *', prompt: 'still alive', recurring: true })
    // Before reassign the child session doesn't exist → fire is a "session not found" skip.
    const before = await s.runOnce(t.id)
    expect(before.ok).toBe(false)
    s.reassignSession(CHILD, PARENT)
    const after = await s.runOnce(t.id)
    expect(after.ok).toBe(true)
    expect(sent).toContain('still alive')
  })
})
