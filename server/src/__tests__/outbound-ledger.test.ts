import { describe, it, expect, beforeEach } from 'vitest'
import { recordOutbound, recentOutbound, formatRecentOutbound, relativeAgo, resetOutboundLedger } from '../al/outbound-ledger.js'
import { inboundEnvelope } from '../al/whatsapp.js'
import { forkSeed } from '../al/conversation-forks.js'

const T0 = 1_800_000_000_000

beforeEach(() => resetOutboundLedger())

describe('outbound ledger', () => {
  it('returns newest first, capped, within the window', () => {
    for (let i = 0; i < 7; i++) recordOutbound('nica', { text: `m${i}`, ts: T0 + i * 1000, jid: 'x' })
    const got = recentOutbound('nica', { now: T0 + 10_000 })
    expect(got.map((e) => e.text)).toEqual(['m6', 'm5', 'm4'])
    expect(recentOutbound('nica', { now: T0 + 10_000, limit: 10 })).toHaveLength(5)
  })

  it('drops entries older than the window and keys per contact', () => {
    recordOutbound('nica', { text: 'old', ts: T0 - 3 * 24 * 3600_000, jid: 'x' })
    recordOutbound('nica', { text: 'new', ts: T0 - 60_000, jid: 'x' })
    recordOutbound('mai', { text: 'other', ts: T0, jid: 'y' })
    expect(recentOutbound('nica', { now: T0 }).map((e) => e.text)).toEqual(['new'])
    expect(recentOutbound('unknown', { now: T0 })).toEqual([])
  })

  it('formats with relative age and a single-line preview', () => {
    const lines = formatRecentOutbound([{ text: 'Fun fact:\n  dinos\thad clubs', ts: T0 - 60_000, jid: 'x' }], T0)
    expect(lines).toEqual(['  • 1 min ago: "Fun fact: dinos had clubs"'])
    expect(relativeAgo(20_000)).toBe('just now')
    expect(relativeAgo(3 * 3600_000)).toBe('3 h ago')
    expect(relativeAgo(3 * 24 * 3600_000)).toBe('3 d ago')
  })
})

const inbound = {
  id: 'ID1', jid: '142245139378326@lid', sender: '142245139378326@lid', senderName: 'Nica',
  text: 'Thank youuu', imagePaths: [], files: [],
} as any

describe('inboundEnvelope recent-outbound block', () => {
  it('lists recent sends to the contact, newest first', () => {
    const env = inboundEnvelope(inbound, 'nica', [
      { text: 'Ankylosaurus fact', ts: T0 - 60_000, jid: '447776912442@s.whatsapp.net' },
      { text: 'Hello from the ring', ts: T0 - 43 * 60_000, jid: '447776912442@s.whatsapp.net' },
    ], T0)
    const i1 = env.indexOf('Ankylosaurus fact')
    const i2 = env.indexOf('Hello from the ring')
    expect(i1).toBeGreaterThan(-1)
    expect(i1).toBeLessThan(i2)
    expect(env).toMatch(/most recent messages to this contact/)
    expect(env.indexOf('Message:')).toBeLessThan(i1)
    expect(i2).toBeLessThan(env.indexOf('ACTION (do this FIRST'))
  })

  it('omits the block when there is nothing recent', () => {
    expect(inboundEnvelope(inbound, 'nica')).not.toMatch(/most recent messages/)
  })
})

describe('forkSeed identities', () => {
  it('names the contact\'s other identifiers as the same person', () => {
    const seed = forkSeed('142245139378326@lid', 'nica', ['447776912442'])
    expect(seed).toMatch(/SAME PERSON as 447776912442/)
  })
  it('stays silent when there are none', () => {
    expect(forkSeed('142245139378326@lid', 'nica')).not.toMatch(/SAME PERSON/)
  })
})
