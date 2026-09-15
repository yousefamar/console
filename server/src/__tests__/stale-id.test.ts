import { describe, it, expect, vi } from 'vitest'
import type { Session } from '../session.js'
import { findByFormerId, missingSessionMessage } from '../agents/stale-id.js'

// Capture the manifest instead of writing the real ~/.claude one.
const written: string[] = []
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return { ...actual, writeFileSync: (_p: string, data: string) => { written.push(data) }, renameSync: () => {} }
})
const { saveManifest } = await import('../manifest.js')

function fake(over: Partial<Session>): Session {
  return {
    id: 'session_1_2', formerIds: [], claudeSessionId: 'csid-1', cwd: '/tmp', initialPrompt: 'p',
    status: 'idle', midTurn: false, endedByUser: false, messageLogLength: 0,
    ...over,
  } as unknown as Session
}

const sessionsOf = (...ss: Session[]) => new Map(ss.map((s) => [s.id, s]))

describe('stale hub session ids', () => {
  // The incident: AL sent to session_15_1789152050911 (pre-restart), the hub
  // said nothing useful, the CLI printed sent:true, the CEO never got it.
  const ceo = fake({ id: 'session_15_1789460773338', name: 'CEO', agentKey: 'ceo', formerIds: ['session_15_1789152050911', 'session_9_1789000000000'] })

  it('finds the successor of a pre-restart id', () => {
    expect(findByFormerId(sessionsOf(ceo), 'session_15_1789152050911')).toBe(ceo)
    expect(findByFormerId(sessionsOf(ceo), 'session_9_1789000000000')).toBe(ceo)
    expect(findByFormerId(sessionsOf(ceo), 'session_15_1789460773338')).toBeUndefined()
    expect(findByFormerId(sessionsOf(ceo), 'session_99_1')).toBeUndefined()
  })

  it('names the successor and its restart-proof address', () => {
    const msg = missingSessionMessage(sessionsOf(ceo), 'session_15_1789152050911')
    expect(msg).toContain('Session not found: session_15_1789152050911')
    expect(msg).toContain('session_15_1789460773338 (CEO)')
    expect(msg).toContain('"ceo"')
  })

  it('falls back to the claudeSessionId when the successor has no agentKey', () => {
    const anon = fake({ id: 'session_2_2', claudeSessionId: 'abc-123', formerIds: ['session_2_1'] })
    expect(missingSessionMessage(sessionsOf(anon), 'session_2_1')).toContain('"abc-123"')
  })

  it('is a plain not-found for an id no live session ever carried', () => {
    expect(missingSessionMessage(sessionsOf(ceo), 'session_42_7')).toBe('Session not found: session_42_7')
  })

  it('manifest persists hubId + formerHubIds so the chain survives the next restart', () => {
    written.length = 0
    saveManifest(sessionsOf(ceo, fake({ id: 'session_3_3', claudeSessionId: 'csid-3' })))
    const entries = JSON.parse(written[0]!) as Array<{ hubId?: string; formerHubIds?: string[] }>
    expect(entries[0]).toMatchObject({ hubId: 'session_15_1789460773338', formerHubIds: ['session_15_1789152050911', 'session_9_1789000000000'] })
    expect(entries[1]!.hubId).toBe('session_3_3')
    expect(entries[1]!.formerHubIds).toBeUndefined()
  })
})
