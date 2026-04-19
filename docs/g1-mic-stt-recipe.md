# G1 Microphone → STT Recipe

The G1 right temple has a MEMS microphone. A long-press on the touchbar arms
it, and the glasses stream LC3-encoded audio frames back over BLE. This doc
captures the full pipeline from touchbar press to transcribed text landing in
Al, and the current state of the scaffold.

## Wire format (from the glasses)

See `docs/g1-protocol.md` for the exact opcode layout. Short version:

- `0x0E` — mic control. `[0x0E, 0x01]` starts, `[0x0E, 0x00]` stops. Only
  the **right** arm accepts this; the left arm never streams audio.
- `0xF1` — inbound audio frame. 202-byte packet: `[0xF1, seq, ...200 LC3 bytes]`.
  At ~50 fps that's ~10 KB/s — comfortable over BLE without extra framing.

LC3 (Low Complexity Communication Codec, part of the Bluetooth LE Audio spec)
uses 10 ms frames at 16 kHz, mono, ~32 kbps → 200 bytes/frame. Each G1 frame
is exactly one LC3 frame.

## Current scaffold

Today the pipeline is plumbed end-to-end but the **LC3→PCM decode step is a
TODO** — no frame actually becomes audio the SPA or Al can play yet.

| Layer               | File                                                      | What it does today |
|---------------------|-----------------------------------------------------------|--------------------|
| BLE capture         | `android/.../glasses/BleManager.kt`                       | `parseAudioFrame` delivers `(seq, lc3Bytes)` to listeners via `onAudioFrame` |
| APK → hub           | `android/.../PushService.kt`                              | Forwards every frame to the hub WS as `{type:'glasses_audio', seq, lc3b64}` |
| Hub fanout          | `server/src/glasses-hub.ts`                               | `onAudio(fn)` subscription; `/glasses/mic` WS endpoint re-emits `{type:'audio', seq, lc3b64}` |
| **Decode**          | **missing**                                               | Consumer decodes LC3 → 16kHz mono PCM → sends to OpenAI `/stt` or Al |
| Control             | `con glasses mic on` / `off`                              | Calls `POST /glasses/mic` which RPCs the APK's `setMic` |

## Completing the decode step

Three reasonable options; pick one per consumer:

### A. Hub-side with `liblc3` via Node FFI

**Best for STT → Al.** Pro: decode once centrally, plug into OpenAI realtime
transcription just like browser STT does today.

1. Build `liblc3` (~6 KLOC C from Google) for the hub host:
   ```bash
   git clone https://github.com/google/liblc3 ~/src/liblc3
   cd ~/src/liblc3 && make
   ```
2. Wrap with `ffi-napi` (or a thin native addon):
   ```js
   const lc3 = ffi.Library('liblc3', {
     lc3_setup_decoder: ['pointer', ['int', 'int', 'int', 'pointer']],
     lc3_decode:        ['int', ['pointer', 'pointer', 'int', 'int', 'pointer', 'int']],
   })
   ```
3. In a new `server/src/glasses/mic-stt.ts`, subscribe via `glassesHub.onAudio`,
   decode frame-by-frame (10 ms, 160 PCM16 samples each), and forward to the
   existing OpenAI Realtime Transcription WS (see the `/stt` handler in
   `server/src/index.ts`).
4. Emit transcribed text to Al by writing to `alBridge` the same way the
   browser STT does via `handleBrowserMessage('send_message', ws, text)`.

### B. APK-side with JNI liblc3

**Best if latency matters.** The EvenDemoApp does this — a `jniLibs/` dir with
`libg1_lc3.so` per ABI plus a small Kotlin wrapper (`Lc3.kt`) that calls
`lc3_setup_decoder` and `lc3_decode`. Plumbing:

1. Drop `libg1_lc3.so` (arm64-v8a / armeabi-v7a / x86_64) into
   `android/app/src/main/jniLibs/<abi>/`.
2. Add a `Lc3Codec` Kotlin object that `System.loadLibrary("g1_lc3")` and
   exposes `decode(lc3: ByteArray): ShortArray`.
3. Replace the `glasses_audio` frame emitter in `PushService.kt` with a
   `glasses_pcm` emitter sending base64-encoded PCM16 (or raw WAV chunks).
4. Hub-side decode path above becomes a no-op; OpenAI `/stt` accepts PCM16
   direct.

### C. Browser-side in the SPA

**Useful for dev / visual monitoring.** The APK already exposes frames to the
WebView as `console:glasses:event` detail `{name:'audio', seq, lc3b64}` (see
`MainActivity.glassesBleListener`). A pure-JS LC3 decoder (e.g.
[`liblc3.js`](https://github.com/google/liblc3) compiled with Emscripten) can
run inline. Not recommended for production — CPU hog, only runs while the
WebView is foregrounded.

## Touchbar auto-wire

**Shipped.** Lives in `server/src/glasses/touch-autowire.ts` and is registered
once at hub boot (`wireTouchToMic(glassesHub, log)` in `server/src/index.ts`).

- Right arm `0x17` (TOUCH_LONG_PRESS_START)   → `glassesHub.setMic(true)`
- Right arm `0x18` (TOUCH_LONG_PRESS_RELEASE) → `glassesHub.setMic(false)`

Left-arm long-presses are ignored (only the right arm has the mic). STT flushing
still depends on the decode step (A/B/C) being plumbed — the mic arm/disarm is
wired, frames fan out, but nothing reassembles them yet.

## Offline buffering (APK-side)

`PushService` keeps an `audioBuffer: ArrayDeque<String>` (cap 3000 frames
= ~60 s @ 50 fps, ~840 KB) of serialized `glasses_audio` JSON frames. When
the hub WS is down the BLE listener routes audio there instead of dropping
it; on WS reconnect `flushAudioLocked()` drains the buffer to the hub before
any new frame. Overflow drops from the front so an STT consumer connecting
late gets the most recent 60 s of speech rather than ancient audio.

Touches and state snapshots are not buffered — they're transient input /
eventually-consistent state, and the next `glasses_state` push on reconnect
corrects anything the hub cached wrong.

## Expected latency budget

- BLE notification → hub: ~10 ms (LAN)
- LC3 decode (liblc3, desktop): <1 ms per 10 ms frame
- OpenAI Realtime Transcription: 100–300 ms server lag
- Al response (Claude Sonnet): 1–3 s

→ "long-press, speak, hear answer on glasses" round-trip target: 2–4 s.
