// G1 input events — touchbar taps, long-presses, head tilts, dashboard show/hide.
//
// Not "gestures" — the 0xF5 opcode carries both intentional user gestures
// (taps, long-press) AND passive state signals (head tilt, dashboard
// visibility), so we use "event" throughout.
//
// The APK forwards every `0xF5` frame verbatim via the
// `console:glasses:event` DOM event stream (see `MainActivity.kt`
// `glassesBleListener.onTouch`). This module subscribes to that stream,
// maps the raw `subcmd` byte to a semantic kind, and exposes:
//
//   - a ring buffer of recent raw events, for the in-app debug panel so
//     we can see what the glasses actually report vs what's documented
//   - `onG1Event(fn)` — typed subscription for semantic consumers
//     (pane routing, mic auto-arm, etc.)
//   - `onG1EventRaw(fn)` — subscription for the raw event stream, when a
//     caller wants to ignore our semantic mapping
//
// Protocol reference: `docs/g1-protocol.md` §8. Verified subcmds (firmware
// as of 2026-04-19):
//   0x00       → double-tap (only fires when there's text on screen to dismiss)
//   0x01       → single-tap (documented but appears inert on this FW)
//   0x02       → head-up (right arm only)
//   0x03       → head-down (right arm only)
//   0x04/0x05  → triple-tap
//   0x06/0x07  → glasses removed from charging case
//   0x08       → case lid opened
//   0x0b       → case lid closed
//   0x0e       → case charging state (byte[2]: 1 charging / 0 not)
//   0x0f       → case battery % (byte[2]: 0..100)
//   0x11       → connected / GATT handshake complete
//   0x17       → long-press start
//   0x18       → long-press end
//   0x1e       → dashboard shown (both arms; follows a 0x02)
//   0x1f       → dashboard hidden (both arms; follows a 0x03)
//   0x20       → double-tap when remapped to a feature in the official app
//
// Still unknown (seen in the wild, reverse-engineer on demand):
//   0x0a, 0x12 — observed on right arm. TBD.
//
// The ring buffer is the source of truth while we iterate.

import { onEvent, type GlassesEvent } from './bridge'

export type GlassesArm = 'left' | 'right'

export type G1EventKind =
  | 'tap-single'
  | 'tap-double'
  | 'tap-triple'
  | 'longpress-start'
  | 'longpress-end'
  | 'head-up'
  | 'head-down'
  | 'dashboard-show'
  | 'dashboard-hide'
  | 'connected'
  | 'case-removed'
  | 'case-opened'
  | 'case-closed'
  | 'case-charging'
  | 'case-battery'
  | 'unknown'

export interface RawG1Event {
  arm: GlassesArm
  subcmd: number // 0..255
  /** `performance.now()` at event receipt — for client-side timing analysis. */
  t: number
}

export interface G1Event {
  kind: G1EventKind
  arm: GlassesArm
  subcmd: number
  t: number
}

export function classify(subcmd: number): G1EventKind {
  switch (subcmd) {
    case 0x00:
      return 'tap-double'
    case 0x01:
      return 'tap-single'
    case 0x02:
      return 'head-up'
    case 0x03:
      return 'head-down'
    case 0x04:
    case 0x05:
      return 'tap-triple'
    case 0x17:
      return 'longpress-start'
    case 0x18:
      return 'longpress-end'
    // Charging-case state (MentraOS G1.java L573-605). The payload-carrying
    // subcmds (0x0e charging, 0x0f battery) are parsed APK-side into
    // GlassesState.caseCharging / caseBattery — classify them here for the
    // debug panel only.
    case 0x06:
    case 0x07:
      return 'case-removed'
    case 0x08:
      return 'case-opened'
    case 0x0b:
      return 'case-closed'
    case 0x0e:
      return 'case-charging'
    case 0x0f:
      return 'case-battery'
    // Dashboard visibility — fires on BOTH arms after a head tilt, so
    // consumers that only want one callback should dedup with a short window.
    case 0x11:
      // Fires on BOTH arms at the moment GATT handshake completes — observed
      // while narrating "now they are connected" during a pair session.
      return 'connected'
    case 0x1e:
      return 'dashboard-show'
    case 0x1f:
      return 'dashboard-hide'
    // Double-tap when the temple has been remapped in the official app to a
    // feature (e.g. Transcribe). Fires even with head down. The subsequent
    // "end" double-tap arrives as 0x00.
    case 0x20:
      return 'tap-double'
    default:
      return 'unknown'
  }
}

// --- Ring buffer of recent events (for the debug panel) --------------------

const RING_SIZE = 20
const ring: RawG1Event[] = []
const ringListeners = new Set<(ring: readonly RawG1Event[]) => void>()

function pushRing(ev: RawG1Event) {
  ring.push(ev)
  if (ring.length > RING_SIZE) ring.shift()
  // Hand out a fresh snapshot so React's Object.is comparison doesn't
  // short-circuit — the ring itself is mutated in place.
  const snap = ring.slice()
  for (const l of ringListeners) {
    try {
      l(snap)
    } catch {
      /* ignore */
    }
  }
}

/** Snapshot of the most recent raw events. Index 0 = oldest. */
export function getRecentEvents(): readonly RawG1Event[] {
  return ring.slice()
}

/** Subscribe to ring-buffer updates for a live debug panel. */
export function onRecentEventsChange(
  fn: (ring: readonly RawG1Event[]) => void,
): () => void {
  ringListeners.add(fn)
  return () => ringListeners.delete(fn)
}

// --- Event dispatcher ------------------------------------------------------

const rawListeners = new Set<(r: RawG1Event) => void>()
const eventListeners = new Set<(e: G1Event) => void>()

export function onG1EventRaw(fn: (r: RawG1Event) => void): () => void {
  rawListeners.add(fn)
  return () => rawListeners.delete(fn)
}

export function onG1Event(fn: (e: G1Event) => void): () => void {
  eventListeners.add(fn)
  return () => eventListeners.delete(fn)
}

// --- Wiring ----------------------------------------------------------------

let wired = false

/**
 * Start listening to the APK's 0xF5 event stream. Idempotent; calling
 * twice has no effect. Call once from `main.tsx` at boot.
 */
export function wireG1Events(): void {
  if (wired) return
  wired = true
  onEvent((ev: GlassesEvent) => {
    if (ev.name !== 'touch') return
    const d = ev.detail as { arm?: unknown; subcmd?: unknown } | null
    if (!d) return
    const arm = d.arm === 'left' ? 'left' : d.arm === 'right' ? 'right' : null
    const sub = typeof d.subcmd === 'number' ? d.subcmd : NaN
    if (!arm || Number.isNaN(sub)) return
    const raw: RawG1Event = { arm, subcmd: sub & 0xff, t: performance.now() }
    // Log every event so it's visible in the debug agent's feed
    // (`curl /debug/log` → `[glasses-event] arm=... subcmd=0x...`).
    // Cheap — only fires on actual user interaction.
    console.log(
      `[glasses-event] arm=${raw.arm} subcmd=0x${raw.subcmd.toString(16).padStart(2, '0')} kind=${classify(raw.subcmd)}`,
    )
    pushRing(raw)
    for (const l of rawListeners) {
      try {
        l(raw)
      } catch {
        /* ignore */
      }
    }
    const e: G1Event = {
      kind: classify(raw.subcmd),
      arm: raw.arm,
      subcmd: raw.subcmd,
      t: raw.t,
    }
    for (const l of eventListeners) {
      try {
        l(e)
      } catch {
        /* ignore */
      }
    }
  })
}
