import { describe, it, expect } from 'vitest'
import { renderHud, HUD_ROWS } from '../glasses/hud.js'
import { mapPushToCard, renderNotificationCard } from '../glasses/notify-forward.js'
import type { PushMessage } from '../push.js'

// Fixed clock: Fri 2026-06-26 12:45 local.
const NOW = new Date(2026, 5, 26, 12, 45, 0)

const FULL = {
  now: NOW,
  battery: 84,
  mail: { count: 3, text: 'Stripe: Q3 invoice — payment received and reconciled' },
  chat: { count: 5, text: 'Nica: dinner at 8 tonight if you are free?' },
  agents: { count: 1, text: 'console-ui: @amar deploy failed' },
}

describe('renderHud', () => {
  it('returns exactly 5 rows', () => {
    expect(renderHud(FULL).split('\n')).toHaveLength(HUD_ROWS)
  })

  it('status bar: time + dotted date left, battery right', () => {
    const row0 = renderHud(FULL).split('\n')[0]!
    expect(row0.startsWith('12:45 Fri 26 ·')).toBe(true)
    expect(row0.trimEnd().endsWith('84%')).toBe(true)
  })

  it('battery shows -- when unknown', () => {
    const row0 = renderHud({ ...FULL, battery: null }).split('\n')[0]!
    expect(row0.trimEnd().endsWith('--')).toBe(true)
  })

  it('M/C/A rows: count + dot divider + preview, truncated with …', () => {
    const [, m, c, a] = renderHud(FULL).split('\n')
    expect(m!.startsWith('M3 · ')).toBe(true)
    expect(c!.startsWith('C5 · ')).toBe(true)
    expect(a!.startsWith('A1 · ')).toBe(true)
    expect(m!.endsWith('…')).toBe(true)        // long subject truncated
    expect(m!.length).toBeLessThanOrEqual(40)
  })

  it('row with no preview text shows just label+count', () => {
    const rows = renderHud({
      ...FULL,
      mail: { count: 0, text: '' },
    }).split('\n')
    expect(rows[1]).toBe('M0')
  })

  it('keeps the same status-bar char target regardless of battery digits', () => {
    const a = renderHud({ ...FULL, battery: 100 }).split('\n')[0]!
    const b = renderHud({ ...FULL, battery: 9 }).split('\n')[0]!
    expect(a.length).toBe(b.length)
  })
})

describe('mapPushToCard', () => {
  it('chat → sender as title, body as message', () => {
    const m: PushMessage = { type: 'chat', senderName: 'Nica', roomName: 'Family', body: 'dinner?' }
    expect(mapPushToCard(m)).toEqual({ title: 'Nica', message: 'dinner?' })
  })
  it('mail → from name as title, subject as message', () => {
    const m: PushMessage = { type: 'mail', fromName: 'Stripe', subject: 'Payout sent', snippet: '...' }
    expect(mapPushToCard(m)).toEqual({ title: 'Stripe', message: 'Payout sent' })
  })
  it('calendar/money/agent fall back to title + body', () => {
    expect(mapPushToCard({ type: 'calendar', title: 'Standup', body: 'in 5m' })).toEqual({ title: 'Standup', message: 'in 5m' })
    expect(mapPushToCard({ type: 'money', title: 'Tesco', body: '-£4.20' })).toEqual({ title: 'Tesco', message: '-£4.20' })
    expect(mapPushToCard({ type: 'generic' })).toEqual({ title: 'Console', message: '' })
  })
})

describe('renderNotificationCard', () => {
  it('returns exactly 5 rows, each ≤ 40 cols', () => {
    const rows = renderNotificationCard('Chat', 'Nica', 'dinner at 8 if you are free tonight?', NOW).split('\n')
    expect(rows).toHaveLength(5)
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(40)
  })
  it('puts source left + time right on the header', () => {
    const rows = renderNotificationCard('Mail', 'Stripe', 'Payout sent', NOW).split('\n')
    expect(rows[0]!.startsWith('Mail')).toBe(true)
    expect(rows[0]!.trimEnd().endsWith('12:45')).toBe(true)
    expect(rows[1]).toBe('Stripe')
  })
  it('word-wraps a long message across rows 3-5', () => {
    const rows = renderNotificationCard('Chat', 'X', 'one two three four five six seven eight nine ten eleven twelve thirteen', NOW).split('\n')
    // message occupies rows 3..5; no row exceeds the width
    expect(rows.slice(2).join(' ')).toContain('one two')
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(40)
  })
})
