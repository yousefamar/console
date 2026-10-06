import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Session } from '../session.js'

// Capture the manifest instead of writing the real ~/.claude one, and serve
// `stored` in place of reading it.
const written: string[] = []
let stored: string | null = null
const isManifest = (p: unknown) => typeof p === 'string' && p.includes('console-hub-sessions.json')
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (_p: string, data: string) => { written.push(data) },
    renameSync: () => {},
    existsSync: (p: string) => (isManifest(p) ? stored !== null : actual.existsSync(p)),
    readFileSync: ((p: string, ...rest: unknown[]) =>
      isManifest(p) ? stored : (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof actual.readFileSync,
  }
})

const { saveManifest, loadManifest, CLAUDE_SESSION_ID_RE } = await import('../manifest.js')

/** Only the fields saveManifest reads. */
function fakeSession(over: Partial<Session>): Session {
  return {
    id: 'session_1_1', formerIds: [], claudeSessionId: 'csid-1', cwd: '/tmp', initialPrompt: 'p', name: 'S',
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

// 7 Oct 2026: ten rows keyed by an 8-char display id (or a hub id) re-spawned a
// child that exited 1 before init on every boot, which the fallback chain read
// as seven unavailable models and parked the fleet on haiku.
describe('loadManifest drops unresumable entries', () => {
  const uuid = 'c277f50e-fa8b-4a2f-9418-9a33a0546586'
  const row = (claudeSessionId: unknown) => ({ claudeSessionId, cwd: '/tmp', prompt: 'p' })

  it('keeps UUID-keyed entries and drops prefixes, hub ids, and junk', () => {
    stored = JSON.stringify([
      row(uuid),
      row('cfa038ec'),                       // 8-char display prefix
      row('session_72_1791290349088'),       // a hub id, not a claudeSessionId
      row(''),
      row(undefined),
    ])
    const entries = loadManifest()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.claudeSessionId).toBe(uuid)
  })

  it('is a no-op for a clean manifest, and empty when there is no file', () => {
    stored = JSON.stringify([row(uuid)])
    expect(loadManifest()).toHaveLength(1)
    stored = null
    expect(loadManifest()).toEqual([])
  })

  it('CLAUDE_SESSION_ID_RE accepts a UUID and rejects the forms that poisoned it', () => {
    expect(CLAUDE_SESSION_ID_RE.test(uuid)).toBe(true)
    expect(CLAUDE_SESSION_ID_RE.test(uuid.toUpperCase())).toBe(true)
    for (const bad of ['cfa038ec', 'session_72_1791290349088', 'al', '', uuid + 'x']) {
      expect(CLAUDE_SESSION_ID_RE.test(bad), bad).toBe(false)
    }
  })
})
