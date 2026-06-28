// Idle HUD for the G1 lenses — a glanceable dashboard shown on head-up tilt.
//
// Transport: hub-driven (so it works when Console is backgrounded). On a
// head-up touch event (0xF5 0x02, right arm) the controller gathers live data
// from existing hub subsystems and pushes a 5×40 text frame; on head-down
// (0x03) it clears. While held up it refreshes on an interval so the clock
// stays current.
//
// `renderHud` is pure (no I/O) and unit-tested. It always returns exactly 5
// rows so the APK's leading-blank padding is a no-op and the HUD top-aligns.

import type { GlassesHub } from '../glasses-hub.js'
import type { GlassesConfig } from './config.js'

export const HUD_ROWS = 5

/**
 * Right-align target for the status bar, in CHARACTERS. The font is
 * PROPORTIONAL, so this is approximate — calibrated on-device (≈78 chars of
 * time+date+battery sat flush with the right edge). We use a few less so the
 * battery never tips into a wrap, which would shove the rows below off-screen
 * and break the layout. Same total-char target regardless of battery digits,
 * so the battery stays roughly in place as it counts down.
 */
const STATUS_TARGET_CHARS = 74
/** Char budget for an M/C/A preview row before it must be truncated with `…`.
 *  Kept under the wrap width (mixed text wraps around the high-40s). */
const PREVIEW_BUDGET = 40

export interface HudPreview {
  count: number
  /** Latest item to preview (subject / message / snippet). May be empty. */
  text: string
}

export interface HudData {
  /** Wall-clock for the status bar. */
  now: Date
  /** Glasses battery % (min of the two arms), or null. */
  battery: number | null
  mail: HudPreview
  chat: HudPreview
  agents: HudPreview
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `HH:MM Dow DD ·  …  NN%` — battery right-aligned via the char target. */
function statusBar(now: Date, battery: number | null): string {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const left = `${hh}:${mm} ${DOW[now.getDay()]} ${now.getDate()} ·`
  const right = battery == null ? '--' : `${battery}%`
  const spaces = Math.max(1, STATUS_TARGET_CHARS - left.length - right.length)
  return left + ' '.repeat(spaces) + right
}

/** `M3 · latest subject…` — count + dot divider + truncated preview. */
function previewRow(label: string, p: HudPreview): string {
  if (!p.text) return `${label}${p.count}`
  const head = `${label}${p.count} · `
  const room = PREVIEW_BUDGET - head.length
  const flat = p.text.replace(/\s+/g, ' ').trim()
  const text = flat.length <= room ? flat : flat.slice(0, Math.max(0, room - 1)) + '…'
  return head + text
}

/** Build the 5-row HUD frame (joined by \n). Pure.
 *  Row 1 status bar; rows 2-4 Mail/Chat/Agents previews; row 5 spare. */
export function renderHud(data: HudData): string {
  const rows = [
    statusBar(data.now, data.battery),
    previewRow('M', data.mail),
    previewRow('C', data.chat),
    previewRow('A', data.agents),
    '',
  ]
  return rows.slice(0, HUD_ROWS).join('\n')
}

// --- Controller ------------------------------------------------------------

const TOUCH_HEAD_UP = 0x02
const TOUCH_HEAD_DOWN = 0x03
const REFRESH_MS = 30_000

export interface HudProviders {
  /** Glasses battery % (min of arms) from the latest snapshot. */
  battery: () => number | null
  mail: () => HudPreview
  chat: () => HudPreview
  agents: () => HudPreview
}

/**
 * Wire head-tilt → HUD. Returns an unsubscribe fn. Renders on head-up,
 * clears on head-down, and refreshes every {@link REFRESH_MS} while held up.
 * No-op while `config.hudEnabled()` is false.
 */
export function wireHud(
  hub: GlassesHub,
  config: GlassesConfig,
  providers: HudProviders,
  log: (msg: string) => void,
  nowFn: () => Date = () => new Date(),
): () => void {
  let shown = false
  let timer: ReturnType<typeof setInterval> | null = null

  const build = (): string => renderHud({
    now: nowFn(),
    battery: providers.battery(),
    mail: providers.mail(),
    chat: providers.chat(),
    agents: providers.agents(),
  })

  const push = () => {
    hub.sendText(build()).catch((err) => log(`[glasses] HUD push failed: ${(err as Error).message}`))
  }

  const stopTimer = () => {
    if (timer) { clearInterval(timer); timer = null }
  }

  const unsub = hub.onTouch((f) => {
    if (f.arm !== 'right') return
    if (!config.hudEnabled()) return
    if (f.subcmd === TOUCH_HEAD_UP) {
      shown = true
      push()
      stopTimer()
      timer = setInterval(() => { if (shown) push() }, REFRESH_MS)
    } else if (f.subcmd === TOUCH_HEAD_DOWN) {
      if (!shown) return
      shown = false
      stopTimer()
      hub.clear().catch((err) => log(`[glasses] HUD clear failed: ${(err as Error).message}`))
    }
  })

  return () => { stopTimer(); unsub() }
}
