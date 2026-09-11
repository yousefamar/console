// Thread history in the inbound envelope (^zany-crow): the parent AL read
// Yousef's "Tell her yeet" with no antecedent because a conversation fork had
// done the relaying. The envelope now carries the recent exchange across all
// of the contact's identifiers, naming which session sent each outbound line,
// and — on the owner thread — which conversation forks are mid-flight.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { record, recentThread, resetHistoryCache, viaLabel, formatHistoryLine, formatTime } from '../al/wa-history.js'
import { inboundEnvelope } from '../al/whatsapp.js'

const PHONE = '447776912442@s.whatsapp.net'
const LID = '142245139378326@lid'
const OWNER = '447845443890@s.whatsapp.net'

// Fixed clock: 2026-09-11 19:41 local. formatTime uses local getters, so the
// expected strings below are built the same way.
const NOW = new Date(2026, 8, 11, 19, 41).getTime()
const at = (h: number, m: number) => new Date(2026, 8, 11, h, m).getTime()

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-history-test-'))
  process.env.CONSOLE_WA_HISTORY_FILE = join(dir, 'wa-history.json')
  resetHistoryCache()
})
afterEach(() => {
  delete process.env.CONSOLE_WA_HISTORY_FILE
  resetHistoryCache()
  rmSync(dir, { recursive: true, force: true })
})

const inbound = (over: Partial<{ id: string; jid: string; sender: string; senderName: string; text: string }> = {}) => ({
  id: 'CUR', jid: LID, sender: LID, senderName: 'Nica', text: 'Thank youuu', imagePaths: [], files: [], ...over,
}) as any

describe('recentThread', () => {
  it('merges the phone and @lid sides of one contact, oldest first, minus the current message', () => {
    record({ ts: at(19, 10), dir: 'out', jid: PHONE, user: 'nica', text: 'Hey Nica', via: 'al' })
    record({ ts: at(19, 12), dir: 'in', jid: LID, user: 'nica', name: 'Nica', text: 'Hi!', id: 'A' })
    record({ ts: at(19, 15), dir: 'in', jid: LID, user: 'nica', name: 'Nica', text: 'Thank youuu', id: 'CUR' })
    const h = recentThread([LID, '447776912442'], { excludeId: 'CUR' })
    expect(h.map((e) => e.text)).toEqual(['Hey Nica', 'Hi!'])
  })

  it('keeps only the last N across the merged thread and persists to disk', () => {
    for (let i = 0; i < 10; i++) record({ ts: at(18, i), dir: 'in', jid: PHONE, user: 'nica', text: `m${i}`, id: `m${i}` })
    expect(recentThread([PHONE], { limit: 6 }).map((e) => e.text)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9'])
    const onDisk = JSON.parse(readFileSync(process.env.CONSOLE_WA_HISTORY_FILE!, 'utf-8'))
    expect(onDisk.threads['447776912442']).toHaveLength(10)
    resetHistoryCache()
    expect(recentThread([PHONE], { limit: 1 })[0]!.text).toBe('m9')
  })

  it('caps a thread at 50 entries', () => {
    for (let i = 0; i < 60; i++) record({ ts: at(10, 0) + i, dir: 'in', jid: PHONE, user: 'nica', text: `m${i}` })
    const all = recentThread([PHONE], { limit: 1000 })
    expect(all).toHaveLength(50)
    expect(all[0]!.text).toBe('m10')
  })

  it('truncates long texts to ~300 chars and flattens newlines', () => {
    record({ ts: at(19, 0), dir: 'in', jid: PHONE, user: 'nica', text: 'a\nb\n' + 'x'.repeat(400) })
    const [e] = recentThread([PHONE])
    expect(e!.text.length).toBe(300)
    expect(e!.text.startsWith('a b x')).toBe(true)
    expect(e!.text.endsWith('…')).toBe(true)
  })
})

describe('formatHistoryLine', () => {
  it('labels inbound by the contact and outbound by the sending session', () => {
    expect(formatHistoryLine({ ts: at(19, 17), dir: 'in', jid: '142245139378326', user: 'nica', name: 'Nica', text: 'hey' }, NOW))
      .toBe('19:17 Nica: hey')
    expect(formatHistoryLine({ ts: at(19, 18), dir: 'out', jid: '447776912442', user: 'nica', text: 'hi', via: 'al' }, NOW))
      .toBe('19:18 AL→Nica: hi')
    expect(formatHistoryLine({ ts: at(19, 39), dir: 'out', jid: '447845443890', user: 'yousef', text: 'Nica says: thanks', via: 'al-nica' }, NOW))
      .toBe('19:39 AL(nica fork)→Yousef: Nica says: thanks')
  })

  it('falls back to push name, then jid, for unknown contacts', () => {
    expect(formatHistoryLine({ ts: at(9, 5), dir: 'in', jid: '999', user: null, name: 'Rando', text: 'yo' }, NOW)).toBe('09:05 Rando: yo')
    expect(formatHistoryLine({ ts: at(9, 5), dir: 'in', jid: '999', user: null, text: 'yo' }, NOW)).toBe('09:05 999: yo')
  })

  it('dates entries from another day', () => {
    expect(formatTime(new Date(2026, 8, 10, 23, 59).getTime(), NOW)).toBe('10 Sept 23:59')
  })

  it('viaLabel: parent, conversation fork, any other agent', () => {
    expect(viaLabel(undefined)).toBe('AL')
    expect(viaLabel('al')).toBe('AL')
    expect(viaLabel('al-nica')).toBe('AL(nica fork)')
    expect(viaLabel('console-general')).toBe('console-general')
  })
})

describe('inboundEnvelope thread context', () => {
  it('shows the recent thread between Message ID and Message', () => {
    const env = inboundEnvelope(inbound(), 'nica', ['447776912442'], {
      now: NOW,
      history: [
        { ts: at(19, 10), dir: 'out', jid: '447776912442', user: 'nica', text: 'Hey Nica', via: 'al' },
        { ts: at(19, 12), dir: 'in', jid: '142245139378326', user: 'nica', name: 'Nica', text: 'Hi!' },
      ],
    })
    expect(env).toContain([
      'Message ID: CUR',
      '',
      'Recent thread (oldest first):',
      '19:10 AL→Nica: Hey Nica',
      '19:12 Nica: Hi!',
      '',
      'Message:',
      'Thank youuu',
    ].join('\n'))
  })

  it('omits the section when there is no history', () => {
    const env = inboundEnvelope(inbound(), 'nica', ['447776912442'], { now: NOW, history: [] })
    expect(env).not.toContain('Recent thread')
    expect(env).not.toContain('Active conversation forks')
    expect(env).toContain('Message ID: CUR\n\nMessage:\nThank youuu')
  })

  it('owner envelope lists the active conversation forks', () => {
    const env = inboundEnvelope(inbound({ id: 'Y1', jid: OWNER, sender: OWNER, senderName: 'Yousef', text: 'Tell her yeet' }), 'yousef', [], {
      now: NOW,
      history: [{ ts: at(19, 39), dir: 'out', jid: '447845443890', user: 'yousef', text: 'Nica says: thanks!', via: 'al-nica' }],
      forks: [{ label: 'nica', lastInboundAt: at(19, 39) }],
    })
    expect(env).toContain('19:39 AL(nica fork)→Yousef: Nica says: thanks!')
    expect(env).toContain('\n\nActive conversation forks: nica (last message 19:39)\n\nMessage:\nTell her yeet')
  })
})
