import { describe, it, expect } from 'vitest'
import { mutedRoomsFromRules } from '../matrix/sync.js'

describe('mutedRoomsFromRules (^tall-ant)', () => {
  it('reads both mute encodings: legacy dont_notify and the spec\'s empty actions', () => {
    const muted = mutedRoomsFromRules([
      { rule_id: '!legacy:hs', enabled: true, actions: ['dont_notify'] },
      { rule_id: '!beeper:hs', enabled: true, actions: [] },
      { rule_id: '!noactions:hs', enabled: true },
    ])
    expect([...muted].sort()).toEqual(['!beeper:hs', '!legacy:hs', '!noactions:hs'])
  })

  it('a rule that notifies is not a mute, whatever tweaks ride along', () => {
    const muted = mutedRoomsFromRules([
      { rule_id: '!loud:hs', actions: ['notify', { set_tweak: 'sound', value: 'default' }] },
      { rule_id: '!tweakonly:hs', actions: [{ set_tweak: 'highlight' }] },
    ])
    expect([...muted]).toEqual(['!tweakonly:hs'])
  })

  it('skips disabled rules and rules without an id', () => {
    const muted = mutedRoomsFromRules([
      { rule_id: '!off:hs', enabled: false, actions: [] },
      { actions: [] },
    ])
    expect(muted.size).toBe(0)
    expect(mutedRoomsFromRules(undefined).size).toBe(0)
  })
})
