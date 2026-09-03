import { describe, it, expect } from 'vitest'
import { inboundEnvelope } from '../al/whatsapp.js'
import { forkSeed } from '../al/conversation-forks.js'

// One person, two JIDs: replies arrive from the @lid while Al's sends went to
// the phone. Both surfaces must label them as the same identity (^rosy-kiwi).

const inbound = {
  id: 'ID1', jid: '142245139378326@lid', sender: '142245139378326@lid', senderName: 'Nica',
  text: 'Thank youuu', imagePaths: [], files: [],
} as any

describe('inboundEnvelope identity label', () => {
  it('names the contact\'s other identifiers on the From line', () => {
    const env = inboundEnvelope(inbound, 'nica', ['447776912442'])
    expect(env).toMatch(/^From: Nica \(142245139378326@lid\) — resolved user: nica \(same person as 447776912442\)$/m)
  })

  it('is unchanged when there are none', () => {
    expect(inboundEnvelope(inbound, 'nica')).toMatch(/^From: Nica \(142245139378326@lid\) — resolved user: nica$/m)
    expect(inboundEnvelope(inbound, null)).toMatch(/resolved user: unknown$/m)
  })
})

describe('forkSeed identity line', () => {
  it('names the other identifiers as the same person', () => {
    expect(forkSeed('142245139378326@lid', 'nica', ['447776912442'])).toMatch(/SAME PERSON as 447776912442/)
  })
  it('stays silent when there are none', () => {
    expect(forkSeed('142245139378326@lid', 'nica')).not.toMatch(/SAME PERSON/)
  })
})
