// Push → glasses notification forwarder.
//
// Every hub push (mail / chat / calendar / agent / money) already fans out to
// the APK's Android system notifications. This sink ALSO forwards it to the G1
// lenses. Hub-driven so it fires even when Console is backgrounded — same
// reliability as the Android notification.
//
// Rendering: we use a **0x4E text card**, not the native 0x4B notification.
// On this G1 firmware a 0x4B push is accepted (correct whitelist + NCS
// envelope, acked 0xC9) but renders NOTHING — verified on-device 2026-06-27.
// The 0x4E text path is what the HUD + mirror use and demonstrably displays,
// so we render a 5×40 card via `sendText` and auto-clear after a TTL (the
// firmware would have self-dismissed a 0x4B card; we do it ourselves).
//
// Gated by `GlassesConfig` (master + per-channel) and the global DnD pref.
// Cancels are dropped — a text card just times out, there's nothing to retract.

import type { PushMessage } from '../push.js'
import type { GlassesHub } from '../glasses-hub.js'
import type { GlassesConfig, GlassesChannel } from './config.js'

const COLS = 40
const ROWS = 5
/** How long a notification card stays on the lenses before auto-clearing. */
const CARD_TTL_MS = 6000

/** Friendly source label shown in the card header. */
const SOURCE_LABEL: Record<GlassesChannel, string> = {
  mail: 'Mail',
  chat: 'Chat',
  calendar: 'Calendar',
  agent: 'Agent',
  money: 'Money',
  generic: 'Console',
}

/** Map a PushMessage to the title/message the card should show. */
export function mapPushToCard(msg: PushMessage): { title: string; message: string } {
  switch (msg.type) {
    case 'chat':
      return {
        title: msg.senderName || msg.roomName || msg.title || 'Message',
        message: msg.body || '',
      }
    case 'mail':
      return {
        title: msg.fromName || msg.fromEmail || msg.title || 'Mail',
        message: msg.subject || msg.snippet || msg.body || '',
      }
    case 'calendar':
      return { title: msg.title || 'Event', message: msg.body || '' }
    case 'money':
      return { title: msg.title || 'Transaction', message: msg.body || '' }
    case 'agent':
      return { title: msg.title || 'Agent', message: msg.body || '' }
    default:
      return { title: msg.title || 'Console', message: msg.body || '' }
  }
}

function clip(s: string, cols = COLS): string {
  return s.length <= cols ? s : s.slice(0, cols)
}

/** Left text + right text on one row, space-filled to `cols`. */
function justify(left: string, right: string, cols = COLS): string {
  if (left.length + 1 + right.length > cols) left = left.slice(0, Math.max(0, cols - right.length - 1))
  const gap = Math.max(1, cols - left.length - right.length)
  return clip(left + ' '.repeat(gap) + right)
}

/** Greedy word-wrap into at most `maxRows` rows of `cols`. */
function wrap(text: string, maxRows: number, cols = COLS): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (!cur) cur = w
    else if ((cur + ' ' + w).length <= cols) cur += ' ' + w
    else { lines.push(cur); cur = w }
    if (lines.length >= maxRows) break
  }
  if (cur && lines.length < maxRows) lines.push(cur)
  return lines.slice(0, maxRows).map((l) => clip(l))
}

function fmtClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Render a 5×40 notification card. Pure.
 *   row 1: source (left) · time (right)
 *   row 2: title
 *   rows 3-5: message, word-wrapped
 */
export function renderNotificationCard(source: string, title: string, message: string, now: Date): string {
  const rows: string[] = []
  rows.push(justify(source, fmtClock(now)))
  rows.push(clip(title))
  rows.push(...wrap(message, ROWS - 2))
  while (rows.length < ROWS) rows.push('')
  return rows.slice(0, ROWS).join('\n')
}

export interface NotifyForwardDeps {
  hub: GlassesHub
  config: GlassesConfig
  /** Returns true when Do-Not-Disturb is on (suppress all glasses cards). */
  isDnd: () => boolean
  log: (msg: string) => void
  /** Override for tests; defaults to wall clock. */
  now?: () => Date
}

/**
 * Returns a `PushMessage` observer to register via `pushServer.onBroadcast`.
 * Decides per-message whether to show a glasses card.
 */
export function makeNotifyForwarder(deps: NotifyForwardDeps): (msg: PushMessage) => void {
  const { hub, config, isDnd, log } = deps
  const now = deps.now ?? (() => new Date())
  let clearTimer: ReturnType<typeof setTimeout> | null = null

  return (msg: PushMessage) => {
    if (msg.cancel) return
    const type = (msg.type ?? 'generic') as GlassesChannel
    if (!config.channelEnabled(type)) return
    if (isDnd()) return
    if (!hub.hasClient()) return

    const { title, message } = mapPushToCard(msg)
    if (!title && !message) return

    const card = renderNotificationCard(SOURCE_LABEL[type] ?? 'Console', title, message, now())
    hub.sendText(card).catch((err) => log(`[glasses] notify card failed: ${(err as Error).message}`))

    // Auto-clear after the TTL (a native 0x4B card would self-dismiss; a text
    // frame persists until overwritten, so we clear it). A newer card resets
    // the timer. The SPA mirror re-asserts on head-down if it was active.
    if (clearTimer) clearTimeout(clearTimer)
    clearTimer = setTimeout(() => {
      clearTimer = null
      hub.clear().catch(() => {})
    }, CARD_TTL_MS)
  }
}
