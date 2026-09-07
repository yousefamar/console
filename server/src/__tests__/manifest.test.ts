import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Session } from '../session.js'

// Capture the manifest instead of writing the real ~/.claude one.
const written: string[] = []
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return { ...actual, writeFileSync: (_p: string, data: string) => { written.push(data) }, renameSync: () => {} }
})

const { saveManifest } = await import('../manifest.js')

/** Only the fields saveManifest reads. */
function fakeSession(over: Partial<Session>): Session {
  return {
    claudeSessionId: 'csid-1', cwd: '/tmp', initialPrompt: 'p', name: 'S',
    status: 'idle', midTurn: false, endedByUser: false, messageLogLength: 0,
    ...over,
  } as unknown as Session
}

function save(...sessions: Session[]) {
  written.length = 0
  saveManifest(new Map(sessions.map((s, i) => [`session_${i}`, s])))
  return JSON.parse(written[0]!) as Array<{ wasRunning?: boolean }>
}

describe('saveManifest wasRunning', () => {
  beforeEach(() => { written.length = 0 })

  it('is true for a session that is mid-turn even though its child already died', () => {
    // pm2's treekill SIGINTs the claude children too; one that exits before the
    // hub's own signal handler leaves status 'ended'. Trusting status alone is
    // what silently killed the "hub was restarted … Continue." nudge.
    const [entry] = save(fakeSession({ status: 'ended', midTurn: true }))
    expect(entry!.wasRunning).toBe(true)
  })

  it('is true while a turn is genuinely running', () => {
    const [entry] = save(fakeSession({ status: 'running', midTurn: true }))
    expect(entry!.wasRunning).toBe(true)
  })

  it('is false for an idle session whose last turn completed', () => {
    const [entry] = save(fakeSession({ status: 'idle', midTurn: false }))
    expect(entry!.wasRunning).toBe(false)
  })
})
