// Did the capture open after Yousef had started speaking? The Index has no
// pre-roll — Pebble's FAQ: "wait half a second after clicking the button" —
// and he mostly does not wait (48 of the first 76 timestamped recordings put
// the first word at 0.00 s), so the press-to-capture latency eats the opener: the
// ring's own STT drops the clipped first word ("It's called chickweed" →
// "Called chickweed", 2026-09-26) or the transcript just begins mid-clause.
// Two independent signals, either enough; judged for UNCLAIMED text only — a
// matched verb means the opening survived.

import { wordKey, wordKeys, fuzzyEqual, isFiller } from './router.js'
import type { TimedWord } from './voice.js'

export interface Truncation {
  /** Words hub STT heard at the very top of the recording that the ring's transcript lacks. */
  leading?: string
  /** The classifier read the transcript as a mid-sentence fragment. */
  fragment?: true
}

/** A clipped opener starts this early or it is not the recording's start. */
const OPENER_WINDOW_S = 0.35
/** How far into the head the ring's opening words may sit. */
const ANCHOR_WINDOW = 4

/** Words the hub hears BEFORE the ring transcript's opening words, starting at
 *  the very top of the recording — a clipped opener the ring's STT dropped.
 *  The ring's first two words are anchored in the head (fuzzy), falling back
 *  to the next pair when the first is itself a mis-hearing, so "Al" vs "I'll"
 *  at the same position is a homophone, not a missing word; hub-only fillers
 *  don't count; words the HUB dropped never flag. */
export function clippedOpener(head: TimedWord[], transcript: string): string | null {
  const timed = head.filter((w) => wordKey(w.word))
  if (!timed.length || timed[0]!.start > OPENER_WINDOW_S) return null
  const keys = timed.map((w) => wordKey(w.word))
  const ring = wordKeys(transcript)
  for (let i = 0; i <= 2 && i < ring.length; i++) {
    const at = fuzzyRun(keys, ring.slice(i, i + 2), ANCHOR_WINDOW)
    if (at < 0) continue
    if (at - i <= 0) return null
    const lead = timed.slice(0, at).filter((w) => !isFiller(wordKey(w.word)))
    return lead.length ? lead.map((w) => w.word.trim()).join(' ') : null
  }
  return null
}

function fuzzyRun(hay: string[], needle: string[], maxStart: number): number {
  for (let s = 0; s <= Math.min(maxStart, hay.length - needle.length); s++) {
    if (needle.every((k, j) => fuzzyEqual(hay[s + j]!, k))) return s
  }
  return -1
}

export function assessCapture(transcript: string, head: TimedWord[] | null, fragment: boolean): Truncation | null {
  const leading = head ? clippedOpener(head, transcript) : null
  if (!leading && !fragment) return null
  return { ...(leading ? { leading } : {}), ...(fragment ? { fragment: true as const } : {}) }
}

/** One line for the envelope header, the log and `con ring show`. */
export function describeTruncation(t: Truncation, durationMs?: number | null): string {
  return [
    durationMs ? `${(durationMs / 1000).toFixed(1)} s of audio` : null,
    t.leading ? `hub STT hears "${t.leading}" before the transcript's first word — the ring's STT dropped a clipped opener` : null,
    t.fragment ? 'the transcript reads as a mid-sentence fragment' : null,
  ].filter(Boolean).join('; ')
}
