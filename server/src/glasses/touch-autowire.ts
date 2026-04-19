// Glasses touchbar → mic auto-arming.
//
// The G1 right temple's long-press gesture is the canonical "talk to my
// assistant" trigger (Even Realities calls it "AI query" in their app). We
// wire it up on the hub rather than in the APK because the mic stream flows
// APK → hub → STT, and the hub is where the STT pipeline lives (see
// `docs/g1-mic-stt-recipe.md`). On the APK all we'd gain is skipping a round
// trip, at the cost of baking policy into native code.
//
// Subcommand bytes of a 0xF5 touchbar event (see G1Protocol.kt):
//   0x17  TOUCH_LONG_PRESS_START    — arm the mic
//   0x18  TOUCH_LONG_PRESS_RELEASE  — disarm + flush audio to STT
//
// Only the right arm can record — the left touchbar never fires 0x17/0x18
// in a way we care about, but we filter explicitly anyway.

import type { GlassesHub } from '../glasses-hub.js'

const TOUCH_LONG_PRESS_START = 0x17
const TOUCH_LONG_PRESS_RELEASE = 0x18

export function wireTouchToMic(
  hub: GlassesHub,
  log: (msg: string) => void,
): () => void {
  return hub.onTouch((f) => {
    if (f.arm !== 'right') return
    if (f.subcmd === TOUCH_LONG_PRESS_START) {
      log('[glasses] long-press → mic on')
      hub.setMic(true).catch((err) => {
        log(`[glasses] setMic(true) failed: ${(err as Error).message}`)
      })
    } else if (f.subcmd === TOUCH_LONG_PRESS_RELEASE) {
      log('[glasses] long-press release → mic off')
      hub.setMic(false).catch((err) => {
        log(`[glasses] setMic(false) failed: ${(err as Error).message}`)
      })
    }
  })
}
