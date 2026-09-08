# G1 Smart Glasses — BLE Protocol Reference

This is the authoritative protocol reference for Console's G1 integration.
Compiled from:

- **MentraOS (formerly AugmentOS) `G1.java`** — the single most thoroughly
  reverse-engineered public G1 client (3943 lines of Android Java). Mirrored
  at `/tmp/g1-research/g1-mentraos-ref.java`; upstream at
  https://github.com/Mentra-Community/MentraOS. This is the best reference
  for any opcode not listed below.
- Even Realities' official `EvenDemoApp` (Flutter, open-source) —
  https://github.com/even-realities/EvenDemoApp. Lighter coverage than
  MentraOS, but authoritative where they agree.
- `emingenc/even_glasses` Python wrapper — useful as a sanity-check
  cross-reference on constants (`models.py`).
- String-mining of the **official Even Realities Android app** (`com.even.g1`,
  Flutter + `libapp.so`) confirmed 0x18 = "exit feature" and 0x56 =
  "exit dashboard while awake". See `/tmp/g1-research/findings.md` in a local
  research checkout for the full strings workup.
- This repo's earlier experimental client at `~/proj/code/g1-term`, which
  independently rediscovered most of the same protocol. **Note:** its
  `api.md` mislabels `0x0F` as battery — that's the *subcmd* of `0xF5` for
  case-battery level, not a top-level opcode. The authoritative battery path
  is `0x2C` (below).
- **`FreedomCoder-dev/g1-reverse`** — a buildable decompilation of the shipped
  G1 firmware itself (nRF5340, Zephyr). **Primary source**: when it and any
  app-side reference disagree, the firmware wins. Opcode map + where to look
  in §17 (added 2026-09-07, ^snug-elk). Its sibling `g1-fw` is a flashing
  toolchain — read §17's safety boundary before touching anything from it.
- Community notes at https://github.com/nickustinov/even-g2-notes (actually
  documents the G2 Even Hub SDK, not the raw G1 BLE protocol — of limited use
  for this integration but referenced for completeness).

**Scope:** G1 only. G2 uses a completely different architecture (a container
UI SDK loaded inside the official iOS app's WebView) and is out of scope for
Console.

---

## 1. Hardware summary

- Two independent BLE peripherals, one per temple arm.
- Advertised names follow `G\d+_\d+_[LR]_\d+`, e.g. `G1_45_L_92333` and
  `G1_45_R_92333`. The two arms of a pair share the **same middle number**
  (the "channel number"), which is how we match them.
- 576×136 px monochrome display per eye. Effectively 5 lines × ~36 chars at
  21 pt default.
- Microphone on the **right arm only**.
- No speaker, no camera.
- Touch surfaces on both temples.

## 2. GATT

Each arm exposes a Nordic UART Service (NUS). Not Even-specific.

| Role       | UUID                                     |
|------------|------------------------------------------|
| Service    | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`   |
| TX (write) | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E`   |
| RX (notify)| `6E400003-B5A3-F393-E0A9-E50E24DCCA9E`   |

- Writes use `WRITE_TYPE_NO_RESPONSE` on Android.
- Enable notifications by writing `00002902-0000-1000-8000-00805f9b34fb` CCCD.
- **Request MTU 247 before `discoverServices()`** — default ATT_MTU=23 caps
  writes at 20 bytes and silently truncates text/BMP/notification frames.
  Symptom: `connected:true` + writes accepted, zero inbound frames, display
  stuck on "Loading".
- **Post-connect init handshake** (right after CCCD subscribed):
  - Console (Android): single byte-pair `[0xF4, 0x01]` per arm. Origin is the
    earlier `g1-term` RE notes; works in practice.
  - MentraOS (verified reference, `G1.java` lines 680-692): four-frame
    sequence — `[0x6E, 0x74]` (firmware request), `[0x4D, 0xFB]` (left only),
    `[0x27, 0x00]` (disable wear detection), `[0x03, 0x0A]` (silent off).
  - iOS (per community notes): `[0x4D, 0x01]`.
  Without *some* init, glasses stay on the "Loading" screen and silently
  ignore text/bmp/notify commands even though BLE accepts the writes. The
  MentraOS sequence is worth considering if our minimal `0xF4` init ever
  regresses on a firmware update.
- Inter-packet delay: **5 ms on Android** (EvenDemoApp's measured value;
  iOS uses 8 ms).

## 3. L / R coordination rules

- **Every non-BMP command**: send to L, wait for a matching ack byte
  (`0xC9` success / `0xCA` fail), **then** send to R. Ack matching is keyed
  by opcode, not sequence number.
- **BMP upload is the only exception**: fire in parallel on L and R via
  `Promise.all`-style. Inter-packet delay still applies per arm.
- **Mic enable (`0x0E`)**: right arm only. The left arm has no microphone.
- Each arm has its own write queue to prevent GATT write collisions.

## 4. Heartbeat

- Opcode `0x25`, every **8 seconds** on both arms.
- Wire format: `[0x25, len_lo, len_hi, seq, 0x04, seq]` — the trailing
  `0x04, seq` matters; some firmware versions reject without it.
- Response must echo opcode and have `byte[4] == 0x04`.
- Missing heartbeat responses are the first sign of a stale connection.

## 5. Opcodes

All opcodes are a single leading byte. Response payloads for
"request" style commands have the same opcode in byte 0 and typically
`0xC9` / `0xCA` in a later byte.

| Op   | Name                | Direction | Notes |
|------|---------------------|-----------|-------|
| 0x01 | Brightness          | → glasses | `[0x01, level 0-0x3F, auto_flag]`; auto-brightness is folded in; see §9 |
| 0x03 | Silent mode         | → glasses | `[0x03, 0x0A off / 0x0C on]`; see §9 |
| 0x04 | App whitelist JSON  | → glasses | 176-byte chunks, `[0x04, totalChunks, seq, ...json...]` |
| 0x06 | Dashboard show      | → glasses | Force dashboard visible. MentraOS constant; untested in Console. |
| 0x09 | Teleprompter        | → glasses | `[0x09, len16, seq, action, total16, pkt16, p9, p10, p11, text…, ts64]`; native teleprompter, one 512-B page per buffer; see §20 |
| 0x0B | Head-up angle       | → glasses | `[0x0B, angle 0-60]`; configures the pitch threshold that triggers dashboard-on. MentraOS verified. |
| 0x0E | Mic enable/disable  | → glasses | `[0x0E, 0x01 or 0x00]`, **right arm only** |
| 0x15 | BMP data packet     | → glasses | 194-byte payload; packet 0 prefixes 4-byte flash address |
| 0x16 | BMP CRC             | → glasses | `[0x16, crc32_xz, 4 bytes BE]` |
| 0x18 | Exit feature        | → glasses | Single byte; exits current feature (Transcribe/Teleprompt/AI) back to idle |
| 0x20 | BMP end marker      | → glasses | Fixed `[0x20, 0x0D, 0x0E]` |
| 0x21 | QuickNote snapshot  | ← glasses | Unsolicited. Fires on long-press right (QuickNote save). `[0x21, len, 0x00, seq, 0x01, noteCount, ...]` + variable 8-byte metadata records. Not in any public reference — Console finding. See §15. |
| 0x22 | Dashboard content   | → glasses | Widget/card push (weather/calendar/stocks); payload format **not publicly RE'd** |
| 0x25 | Heartbeat           | ↔         | Every 8s, both arms |
| 0x26 | Dashboard position  | → glasses | `[0x26, 0x08, 0x00, ctr, 0x02, 0x01, height(0-8), depth(1-9)]` |
| 0x27 | Wear detection      | ↔         | `[0x27, 0x00]` disables detection; event `[0x27, 0x06]`=on-head / `0x07`=off-head |
| 0x2C | Battery query/reply | ↔         | Poll `[0x2C, 0x01]` (Android) / `[0x2C, 0x02]` (iOS); reply `[0x2C, 0x66, pct, …]` |
| 0x34 | Serial number query | → glasses | Response: bytes [2:18] = ASCII serial |
| 0x39 | System status query | ↔         | `[0x39, len16, 0, 0]` → `[0x39, …echo…, appId]`; appId `0` = idle screen. See §19 |
| 0x47 | Un-pair ⚠           | → glasses | Opcode only. Glasses drop the bond + disconnect — human-only. See §19 |
| 0x4B | Notification push   | → glasses | `[0x4B, msgId, maxSeq, seq, json...]`, 176-byte chunks |
| 0x4C | Dismiss a card      | → glasses | `[0x4C, msgId]` — clears a 0x4B card. Ack is unconditional. See §19 |
| 0x4E | Text / AI result    | → glasses | 191-byte chunks; see §6 |
| 0x56 | Exit dashboard ⚠    | → glasses | Force-close dashboard while glasses awake (distinct from 0x18). **Unconfirmed:** came from string-mining `com.even.g1`'s `libapp.so`; **not** in MentraOS, EvenDemoApp, or emingenc. Full payload beyond byte[0] unknown. |
| 0xF1 | Inbound mic audio   | ← glasses | `[0xF1, seq, 200 bytes LC3]`, **must be 202 bytes total** |
| 0xF4 | Init handshake (Android) | → glasses | `[0xF4, 0x01]` once per arm after CCCD subscribed |
| 0xF5 | Touchbar / system / case events | ← glasses | Second byte = subcmd; see §8 |

## 6. Text display — `0x4E`

Wire format per chunk (max 191 text bytes per chunk):

```
byte 0   : 0x4E
byte 1   : syncSeq   (wraps mod 256, increments per text send)
byte 2   : maxSeq    (total chunks - 1)
byte 3   : seq       (current chunk, 0-indexed)
byte 4   : screenStatus  (see nibble table below)
byte 5-6 : pos_hi, pos_lo (historically 0, 0 — unused for plain text)
byte 7   : current_page_num  (1-indexed; use 1 for single-page)
byte 8   : max_page_num      (use 1 for single-page)
byte 9+  : UTF-8 text payload
```

`screenStatus` packs two nibbles:

| High nibble | Meaning                    |
|-------------|----------------------------|
| 0x30        | AI content, auto-scrolling |
| 0x40        | AI content, last page      |
| 0x50        | AI content, manual scroll  |
| 0x60        | Network error              |
| **0x70**    | **Plain text (what we use)** |

| Low nibble | Meaning              |
|------------|----------------------|
| 0x01       | New content (reset display) |

So for a normal text send we use `0x71` (plain text + new content).

Ack status byte: both **`0xC9` and `0xCB` are success**; anything else is a
failure. The protocol's lenient `parseAck` just scans for `0xC9` / `0xCA`
presence, which treats `0xCB` as an implicit ok — fine in practice.

**`total_packages` is a count, not a max-index.** Early Console versions
sent `totalChunks - 1` in byte[2] (symmetric with `current_package` being
0-indexed). Firmware acks `0xCB` but renders nothing because it sees
`total=0` and treats the message as empty. Same pitfall applies to the
`0x4B` notification chunking (byte[2] there too). Fixed in APK v11.

### Text layout

EvenDemoApp measures with Flutter's `TextPainter` at:

- `maxWidth = 488` px
- `fontSize = 21` pt

These are tunable, not hard device limits. 5 lines per screen fits the 136 px
height. For multi-screen scrolling, EvenDemoApp advances one screen every
8 seconds. Console pre-wraps on the phone before handing chunks to native BLE.

**Bottom-align short content.** The viewport always shows 5 lines; shorter
payloads silently render above the visible area. Pad with leading blank
lines so content sits at the bottom:

- 1 line → `"\n\n\n\n" + text`
- 2 lines → `"\n\n\n" + a + "\n" + b`
- etc.

`G1Protocol.padTextToFiveLines()` handles this automatically before
chunking. Discovered after v9 shipped and "hello from the hub" acked-ok
with `0xCB` but rendered nothing visible — it was painting line 1 of a
5-line canvas.

### Font / glyph support (empirically enumerated 2026-06-28)

The firmware text font covers far more than ASCII, but it is **not** a full
Unicode font — most symbol/emoji ranges fall back to blank (no tofu box;
missing glyphs render as nothing). Enumerated on-device by paging labelled
candidate glyphs through `0x4E` and eyeballing the lenses (`/tmp/g1chars.py`).
**A missing glyph is invisible, so anything not on this list must be avoided
or it silently corrupts layout.**

**Renders (beyond printable ASCII 0x20–0x7E):**
- Typography: `…` `—` `–` `•` `·` `«` `»` `‹` `›`
- Currency: `€` `£` `¢` `¥`
- Marks: `©` `®` `™` `§` `¶`
- Fractions: `¼` `½` `¾`
- Math: `°` `±` `×` `÷` `−` `∞` `≈` `≠` `≤` `≥` `√` `∑` `∏` `′` `″` `‰` `№` `℃`
- Punctuation: `¿`
- Arrows: `←` `↑` `→` `↓` `↔` `↕`  (line arrows only)
- Shapes: `■` `□` `▲` `△` `◆` `◇` `○` `●` `★` `☆`
- Status: `✓` (U+2713) and `☐` (U+2610)
- Box-drawing (**single line only**): `─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼`

**Does NOT render (silently blank — do not use):**
- All block / shading elements `█ ▉ … ▏ ░ ▒ ▓` (U+2580–259F) → **no native
  bar/progress fill; fake bars with `■`/`□` or `[..]` instead**
- Filled directional triangles `◀ ▶ ▼` — **asymmetric: `▲`/`△` render but
  `▼` does NOT** (use `↓` or ASCII `v` for "down")
- Double-line box-drawing `═ ║ ╔ ╗ ╚ ╝ ╬`
- Cross/heavy dingbats `✗ ✘ ✔ ✖ ✅ ❌ ❤`, checked box `☑`
- Weather/misc symbols `☀ ☁ ⚠ ⚙ ⌚ ⌛ ♥ ♦ ♠ ⚡ ⚑` (U+2600–26FF essentially all)
- Small squares `▪ ▫`, half-shaded circles `◐ ◑`, big squares `⬛ ⬜`, `◦`, `∙`
- Heavy/curved arrows `⇨ ⤴ ➤ ➙ ↺ ↵`
- `µ` (U+00B5), `¡` (U+00A1), `℉` (U+2109), `♦` (U+2666)

Practical dashboard kit: `■ □ ● ○` for status dots & faked bars, `★ ☆` for
priority, `✓` for done, `← ↑ → ↓` for trends/direction, `° ℃` for temperature,
`• ·` for separators, `…` (U+2026) to mark truncated text.

### Text layout behaviour — clip vs wrap, width, alignment (2026-06-28)

Verified on-device. These govern any 5×40-ish text layout:

- **Clip vs wrap depends on payload shape.** A **single-line** payload that
  overflows the display width is **clipped** (truncated, rest discarded). A
  **multi-line** payload (any `\n`) **wraps** each overflowing line onto extra
  physical rows instead. Since the display only shows ~5 physical rows and the
  render is top-aligned, a wrapped line pushes everything below it off-screen.
  → **Rule: a dashboard is always multi-line, so keep EVERY line under the
  width or it wraps and destroys the layout.**
- **There is no visible edge/margin** — the wearer can only perceive *wrapping*,
  not where the right edge is. To measure width, send an overflowing multi-line
  payload and count what lands on the wrapped row.
- **Width reference: 41 × `—` (em-dash, U+2014) == exactly the full display
  width.** Measured by sending 50 and removing the 9 that wrapped. This is the
  canonical horizontal unit — use a 41-em-dash rule as an on-screen alignment
  ruler while designing (then drop it).
- **The font is PROPORTIONAL — never align columns with spaces.** A `1` is
  narrower than a `9`; a space is very narrow and variable. Space-padding to
  right-align / make columns produces chaotic, non-aligned output. Align by
  measuring against the em-dash grid (or use inline separators `·` / `|` and
  left-align), not by padding spaces.
- `padTextToFiveLines()` prepends blank lines for <5-line payloads; combined
  with wrapping this wastes rows. For a fixed dashboard, send exactly 5 lines.

## 7. BMP upload — `0x15` + `0x20` + `0x16`

Image format: **1-bit BMP, 576×136**. Roughly ~9.8 KB on disk.

```
1. Slice entire BMP into 194-byte chunks.
2. Packet 0  : [0x15, 0, 0x00, 0x1C, 0x00, 0x00, ...first 194 bytes]
   The four bytes 0x00,0x1C,0x00,0x00 are the flash target address.
3. Packet n  : [0x15, seq, ...194 bytes]
4. Inter-packet delay: 5ms (Android). No per-packet acks during stream.
5. After last chunk: [0x20, 0x0D, 0x0E]  — wait for 0xC9, retry up to 10×
6. CRC32/XZ (big-endian, 4 bytes) over [0x00,0x1C,0x00,0x00] + imageBytes.
   Send [0x16, crc_BE_0, crc_BE_1, crc_BE_2, crc_BE_3]  — wait for 0xC9.
```

L and R are sent in parallel for BMP (unlike text).

## 8. Touchbar / system / case events — `0xF5`

The `0xF5` opcode is a grab-bag of unsolicited glasses→phone events. Second
byte is the subcmd; third byte (when present) is a state payload.

### 8a. Touchbar + head tilt + dashboard

| Subcmd | Meaning |
|--------|---------|
| 0x00   | Double-tap (only fires when something on screen to dismiss) |
| 0x01   | Single-tap (documented, inert on current FW) |
| 0x02   | Head-up (right arm only) |
| 0x03   | Head-down (right arm only) |
| 0x04   | Triple-tap → silent mode **on** (direction, not arm variant) |
| 0x05   | Triple-tap → silent mode **off** |
| 0x11   | Connected / GATT handshake complete (both arms) |
| 0x17   | Long-press start (Even AI trigger) — **does not fire on default touchbar mapping**; firmware emits `0x21` (QuickNote snapshot, §15) instead when the default long-press-right feature is QuickNote |
| 0x18   | Long-press release / recording over — same caveat as 0x17 |
| 0x1e   | Dashboard shown (both arms; follows 0x02). **Only fires if dashboard has content configured** — on a fresh pair with dashboard disabled, head-up emits only 0x02 with no 0x1e follow-up. |
| 0x1f   | Dashboard hidden (both arms; follows 0x03). Same "requires content" caveat as 0x1e. |
| 0x20   | Double-tap when remapped to a feature (e.g. Transcribe in the official app); `0x00` matches as the end-event |

Verified against firmware as of 2026-04-22 using research-mode frame logging
(`con glasses research on`) cross-referenced with MentraOS `G1.java`.
Head-tilt semantics: the 0x02/0x03 motion event fires on the right arm
only, followed ~700ms later by a 0x1e/0x1f "dashboard shown/hidden" state
pair (one per arm) **if** the dashboard has content — so "tilt up →
dashboard appears" produces one to three events per action depending on
configuration.

Triple-tap direction: `0x04` and `0x05` are **not** left vs right arm —
they track the new silent-mode state. Firing `0x04` once (silent on) then
triple-tapping again yields `0x05` (silent off) regardless of which arm
was tapped.

### 8b. Charging / battery state (unsolicited)

Per MentraOS `G1.java` lines 573-605, plus Console findings for 0x09 and
0x0A (confirmed via research-mode logging against live hardware):

| Subcmd | Payload | Meaning |
|--------|---------|---------|
| 0x06   | —       | Glasses removed from case (variant A) — **firmware name `EVENT_ENTER_WARED`**: the arm decided it is being WORN (out of box + on head). So wear detection IS reachable via `0xF5`, independent of the silent `0x27` detector (§12) — not yet observed live in our 5K-line log window; verify before relying on it |
| 0x07   | —       | Glasses removed from case (variant B) — **firmware name `EVENT_UNWARED_OUTBOX`**: out of the box but NOT worn |
| 0x08   | —       | Case lid opened — firmware `EVENT_PUT_IN_GLASS_BOX_OPEN` (in the box, lid open) |
| 0x09   | byte[2] | **Per-arm charging-pin contact:** `1` = arm sitting on its case charging pin, `0` = lifted off. Fires on each arm independently. Distinct from 0x0E (whole-case charging state). Not in MentraOS — Console finding. |
| 0x0A   | byte[2] | **Unsolicited arm battery push (0–100 %)** — firmware `EVENT_STATE_BATTERY_PERCENT`: emitted whenever the arm's percent CHANGES (value < 0x65 and ≠ last sent), not only on docking. Complements the polled `0x2C` reply. |
| 0x0B   | —       | Case lid closed — firmware `EVENT_PUT_IN_GLASS_BOX_CLOSE` |
| 0x0E   | byte[2] | Case charging status; `1` = charging, `0` = not — firmware `EVENT_STATE_CHARGING` |
| 0x0F   | byte[2] | Case battery level (0–100) — firmware `EVENT_GLASS_BOX_SOC` |

Firmware names are from `check_work_mode.c` in the g1-reverse reconstruction
(§17); the case/worn events are all decided by one state machine there
(`param_1` = in box?, `param_2` = lid?, worn flag), which is why they arrive
as one consistent family.

### 8c. Unclassified

| Subcmd | Status |
|--------|--------|
| 0x12   | **Resolved (firmware, 2026-09-07): auto-brightness lux bucket changed** — `check_work_mode` emits it when `compute_lux_brightness_bucket()` returns a new bucket. Earlier "long-press while mic armed" reading was a coincidence. |
| 0x11   | Firmware `EVENT_GLASS_HAS_FINISH_BIND` — matches our "connected / handshake complete" reading in §8a |
| 0x13–0x16 | Onboarding screen steps (`onboarding_render_step_screen`) — first-run flow only |
| 0x18   | ESB (arm↔arm radio) link event (`g1_esb_02`) — not the long-press release when it arrives outside a mic session |
| 0x1e / 0x1f | Dashboard shown / hidden (`ui_DashBoard_task`) — confirms §8a |
| 0xF0 / 0xF1 / 0xF2 | **Render-complete acks**: the display thread emits `0xF5 0xF0` after processing a `0x0D` command, `0xF1` after `0x0F`, `0xF2` after a `0x4E` text send. A cheap "text is on the lens" signal we don't use yet. |

Every `0xF5` event is built by one firmware function, `send_event(id)` →
`[0xF5, id, 0xCB]` — so the third byte `0xCB` is a constant marker, not
data, and the full id space is whatever the firmware passes to `send_event`.
Ids `0x00`–`0x04` come from the key thread (`0x01` = touch key), IMU
(`0x02`/`0x03` head up/down) and fuel gauge (`0x04`).

Note: the `[0x03, 0x0A]` byte sequence is the phone→glasses silent-mode-off
command (see §9), **not** a `0xF5` subcmd — don't confuse the two when
reading frame dumps.

Not all 0xF5 events are gestures — head-tilt and dashboard-visibility are
passive state signals. The SPA-side classifier lives in `src/glasses/events.ts`
and uses "event" not "gesture" as the umbrella term.

Console routes these to whichever pane is "active on the glasses" — the last
feature to push a screen. Default mapping (v1):
long-press-right-temple starts mic recording; release stops.

## 9. Notification push — `0x4B`

EvenDemoApp uses an iOS-NCS-style JSON blob:

```json
{
  "ncs_notification": {
    "msg_id": <int>,
    "app_identifier": "com.example.app",
    "title": "...",
    "subtitle": "...",
    "message": "...",
    "time_s": <unix>,
    "date": "YYYY-MM-DD HH:MM:SS",
    "display_name": "..."
  }
}
```

Chunked in 176-byte slices:

```
[0x4B, msgId, maxSeq, seq, ...json bytes...]
```

Retries up to 6× per EvenDemoApp.

**Load-bearing gotcha (verified on-device 2026-06-27):** the JSON MUST be the
full `{"ncs_notification": {...}}` envelope with `msg_id` + `date`. A *flat*
object (`{"app_identifier":…,"title":…}` with no wrapper) is still **acked**
by the firmware (`4B C9 …` = valid chunk) but renders **nothing** — silent
drop. The whitelist (`0x04`) being correct is necessary but not sufficient;
both must be right. Console builds the envelope in `PushService.handleHubRpc`
"notify" (APK v0.1.37+).

**Clearing a card:** the push has no expiry — a card sits on the lens until
something dismisses it. That's `0x4C` with the same `msgId`; see §19, which is
also why the hub (not the APK) now allocates the id.

## 10. Audio — `0xF1` (inbound)

- Enable mic: send `[0x0E, 0x01]` to right arm only; disable with `0x00`.
- Right arm emits `[0xF1, seq, 200 bytes LC3]`. **Every inbound 0xF1 frame
  is exactly 202 bytes.** If you receive a different size, skip it.
- Codec: LC3, 16 kHz mono, 20 ms frames (10 ms window in some configs).
  Decoded PCM is S16LE at 16 kHz. EvenDemoApp bundles `liblc3` in C; Console
  does the same via JNI.
- Max session: 30 s auto-enforced (glasses will stop sending).

## 11. Serial number — `0x34`

Send `[0x34]`. Response: `[0x34, ?, SN byte 0, ...SN byte 15, ...]`.
ASCII decode bytes [2:18].

## 12. Battery & wear detection

### Battery — `0x2C` (poll, not push)

Battery is **poll-based**, not unsolicited. MentraOS polls every ~10
heartbeats (~80 s). Wire format:

```
Query  (phone→G1): [0x2C, 0x01]   # Android identifier; iOS uses 0x02
Reply  (G1→phone): [0x2C, 0x66, pct, ...]   # byte[2] = 0-100 percent
```

Sent to **both arms** (each arm tracks its own battery). Replies arrive
independently on L and R.

**The reply is the firmware's `BLE_REQ_GET_DEVICE_INFO`, not just battery**
(firmware handler `ble_process_get_req` case `0x2c`, see §17). Its log
format names the payload — `CHG:%02x×5 M_SW_VER:v%d.%d.%d S_SW_VER:v%d.%d.%d
BLE_SW_VER:v%d.%d…` — and our own captures match it exactly:

```
right: 2c 66 | 45 3f cd 83 1b | 01 06 06 | 01 06 06 | 00 00 00 | 00…   (20 bytes)
left:  2c 66 | 3f 00 c7 88 1c | 00 00 00 | 01 06 06 | 00 00 00 | 00…
        │  │   │  │  └──┬──┘ │   └─M_SW─┘  └─S_SW─┘  └BLE_SW┘
        │  │   │  │     │    └ CHG[4] = 0x1b/0x1c → 27/28, plausibly °C (inference)
        │  │   │  │     └ CHG[2..3] = 0x83cd / 0x88c7 → 3374 / 3503, plausibly mV big-endian (inference)
        │  │   │  └ CHG[1] flags — 0x3f on the master arm, 0x00 on the slave (unknown)
        │  │   └ CHG[0] = battery percent (what Console parses today)
        │  └ 0x66 = success marker for this GET
        └ opcode
```

So **firmware version = bytes [7..9] (master, `M_SW_VER`) and [10..12] (slave,
`S_SW_VER`)** — `01 06 06` = v1.6.6 on this pair (2026-06). Only the RIGHT
arm (master, hardware strap P0.26 — see §17) fills `M_SW_VER`; the left
reports zeros there and its own version under `S_SW_VER`. `BLE_SW_VER` read
0.0.0 on both. Console parses this since ^kind-pony (`G1Protocol.parseDeviceInfo`,
APK): per-arm `firmware` in the glasses snapshot (`left.firmware` /
`right.firmware`, right = master slot, left = slave slot, all-zero = null) —
no new traffic, the poll already ran every ~80 s. The `[0x2C, 0x01|0x02]`
request byte is stored by the firmware as the phone platform ("`%s mobile
phone is connected`" — Android/iOS).

### Wear detection — `0x27`

Glasses fire unsolicited events when put on / taken off the head:

```
[0x27, 0x06]   # put on (glasses worn)
[0x27, 0x07]   # taken off
```

**Disabled by default on current firmware.** In 5K+ lines of research-mode
logging across multiple wear/unwear cycles we never observed a `0x27 0x06`
or `0x27 0x07` push — the detector is silent unless explicitly enabled.
MentraOS *disables* wear detection at init with `[0x27, 0x00]` because it
re-uses the `0xF5` case events (§8b) as a proxy; Console does not send
that disable frame but still sees no events, suggesting the firmware
default is already off. `GlassesState.worn` therefore stays `null` in
practice — trust the `0xF5 0x09` per-arm charging-pin signal as the more
reliable "glasses are not being worn right now" proxy.

### Case battery & case state

See §8b — charging case events piggy-back on `0xF5` subcmds (0x06-0x0F).

### Residual unknowns

- ~~`0xF5` subcmd `0x12` — fires on long-press-right when the mic is already
  armed. Exact semantics TBD.~~ **RESOLVED 2026-09-07 from firmware** (§17):
  `0x12` is the auto-brightness **lux bucket changed** event
  (`check_work_mode` → `compute_lux_brightness_bucket`, emitted when the
  bucket differs from the last one sent). The long-press correlation was
  coincidence — lifting the arm to press changed the light.
- ~~Firmware version query — **G1 doesn't expose one.**~~ **WRONG — corrected
  2026-09-07.** MentraOS `G1.java` line 1761 ("G1 doesn't support version
  info requests") is an app-side assumption; the firmware's `0x2C` reply IS
  `BLE_REQ_GET_DEVICE_INFO` and carries `M_SW_VER`/`S_SW_VER`/`BLE_SW_VER`
  at bytes [7..15] — see §12 Battery for the byte map and our captured
  v1.6.6 sample. Primary source (firmware + our own frames) beats the
  secondary (MentraOS comment).

### In-repo reverse-engineering path

We have our own pipeline now: `con glasses research on` flips a flag on the
APK so every inbound BLE frame (classified as `audio|touch|heartbeat|ack|unhandled`
— audio excluded, heartbeat gated on verbose) is forwarded to the hub as a
`glasses_frame` WS message. The hub appends NDJSON to
`~/.config/console/glasses-research.log` (rotating at 5K lines) and flags
anything classified `unhandled` with `unknown: true`.

Workflow for hunting a new opcode (e.g. battery):
1. `con glasses research on` — verbose mode picks up heartbeats too so you
   have a timeline reference.
2. Trigger the on-device action with the official app running alongside
   (e.g. open the battery screen in EvenDemoApp).
3. `con glasses research tail 500 | jq 'select(.unknown)'` — the
   unhandled frames are your candidates; compare timing against the action.
4. Promote any identified opcode into `G1Protocol.kt` + a new case in
   `BleManager.handleNotification` + expose on `GlassesState`.

## 13. Wire-level quirks & gotchas

1. The L-arm-first sequencing is load-bearing: the right arm rejects many
   commands if the left hasn't acknowledged first.
2. Inter-packet delay below 5 ms on Android causes silent packet drops.
3. `0xF1` audio frames are often emitted before `[0x0E, 0x01]` is fully
   acknowledged. Listen before you enable.
4. `0x20 BMP end` frequently times out even on success — retry up to 10×
   with 1 s delays before giving up.
5. `0x4E` text chunks use `syncSeq` that increments per call (not per chunk)
   to let the firmware discard stale partial sends.
6. Disconnects are common after ~5 minutes of idle BLE traffic. Heartbeat
   prevents this.
7. The "long-press release" event `0x18` fires independently of whether you
   were listening for mic audio — always treat it as a state change.

## 14. Settings & control commands

All phone→glasses, all acked with `0xC9` / `0xCA`. Sent to both arms with the
same L-then-R sequencing as other non-BMP commands (§3). None are wired up
in Console yet — MentraOS is the byte-level reference.

### Brightness — `0x01`

```
[0x01, level, auto_flag]
  level      : 0x00-0x3F (0-63)        # map UI 0-100% via (pct * 63) / 100
  auto_flag  : 0x00 manual, 0x01 auto  # auto-brightness is folded in
```

To toggle auto without changing manual level, pass `level = 0x12` (MentraOS's
default ~30%) and flip `auto_flag`.

### Silent mode — `0x03`

```
[0x03, 0x0A]  # silent off
[0x03, 0x0C]  # silent on
```

When silent mode is on, the firmware suppresses some touch events before
they leave the device — observed as `BleManager - eventBleReceive: double
tap failure, is in silent mode` in the official Even app.

### App whitelist — `0x04`

Chunked JSON, 176 bytes of payload per chunk, 3-byte header
`[0x04, totalChunks, seq]`. JSON structure:

```json
{
  "calendar_enable": false,
  "call_enable": false,
  "msg_enable": false,
  "ios_mail_enable": false,
  "app": {
    "list": [{"id": "com.example", "name": "Example"}],
    "enable": true
  }
}
```

Required before notifications for arbitrary apps will be displayed — without
a matching whitelist entry the firmware drops `0x4B` pushes. (Calls /
calendar / msg / iOS-mail have dedicated first-class flags.)

**Implemented in Console (v0.1.36).** `G1Protocol.encodeAppWhitelistChunks` +
`BleManager.sendAppWhitelist()` register a single Console app id
(`io.amar.console` / "Console") on connect, right after the `0xF4` init
handshake (`onDescriptorWrite`). Every Console notification rides that one id;
the human-readable source ("Mail" / "Chat" / …) goes in the `0x4B`
`display_name`, so one whitelist entry covers all sources. Re-sendable at
runtime via `BleManager.sendAppWhitelist()`.

### Dashboard position — `0x26`

```
[0x26, 0x08, 0x00, ctr, 0x02, 0x01, height, depth]
  ctr     : 1-byte rolling counter (increments per call)
  height  : 0-8
  depth   : 1-9
```

Moves the dashboard viewport. Does *not* inject widget content.

### Head-up angle — `0x0B`

```
[0x0B, angle]
  angle : 0-60 (degrees)  # clamped MentraOS-side; firmware behaviour outside
                          # the range is unverified
```

Configures the pitch threshold (in degrees) at which a right-arm head-up
tilt triggers the dashboard. Per MentraOS `G1.java` `sendHeadUpAngleCommand`
(lines 2603-2620). Applied per-arm with the usual L-then-R sequencing.

**Used by Console's HUD (v0.1.36).** Sent on connect (default 30°) so the
head-up tilt reliably fires a `0xF5 0x02` event. The hub listens for that on
the touch stream and renders the idle HUD (time / battery / next event /
unread counts) via `0x4E` text; head-down `0x03` clears it. Runtime-adjustable
via `BleManager.setHeadUpAngle()` (hub RPC `setHeadUpAngle` → the settings
slider). The HUD never uses the un-RE'd `0x22` firmware dashboard — it renders
its own text frame, so no widget-protocol gap blocks it.

### Dashboard content / widgets — `0x22` (not publicly RE'd)

`0x22` is referenced as `DASHBOARD` in `emingenc/even_glasses` but neither
MentraOS nor any public source implements weather / calendar / stocks card
injection — those cards are rendered firmware-side from configuration pushed
by the official Even Realities app, with a payload nobody has decoded yet.
This is the biggest remaining protocol gap. Path forward: capture an HCI BT
snoop of the official app while it updates a widget, diff against a null
push.

### Exit feature — `0x18`

```
[0x18]
```

Single-byte command. Kicks the glasses out of any currently-displayed
feature (Transcribe, Teleprompter, Even AI) back to idle. Distinct from
`0x56` (which specifically closes the dashboard — the feature view survives).

### Exit dashboard while awake — `0x56`

```
[0x56, ...]
```

Force-closes the dashboard when the user would otherwise still be looking at
it (e.g. head still up). MentraOS doesn't wire this; the byte came from
string-mining the official Even app (`exitDashboardWhileBeAwake----0x56-----`
in `libapp.so`). Full payload beyond byte[0] is unconfirmed.

## 15. QuickNote snapshot — `0x21`

Unsolicited frame emitted by the glasses when the user performs a long-press
on the right temple while QuickNote is the default long-press feature (the
out-of-box config). Instead of the expected `0xF5 0x17` long-press-start /
`0xF5 0x18` long-press-end pair, firmware emits a single `0x21` frame
carrying a snapshot of the on-device saved-notes database.

Not in MentraOS, EvenDemoApp, or any other public reference — Console
reverse-engineered this by triggering the long-press, reading the
"QuickNote saved" UI text on the glasses, and diffing research-log frames.

Wire format (observed; field names provisional):

```
byte 0      : 0x21
byte 1      : total length (little-endian, single byte observed)
byte 2      : 0x00  (reserved / padding)
byte 3      : seq / message id
byte 4      : 0x01  (fixed marker — "snapshot")
byte 5      : note count on device
byte 6+     : variable — 8-byte metadata records per note, each containing
              a `61 92 65` three-byte signature plus 5 bytes of TBD metadata
              (likely id + timestamp + length — not yet decoded).
```

Console **does not parse the payload** today; `BleManager` classifies it
as `kind: "quicknote"` and forwards it to research logging (via `onFrame`),
then early-returns without further action. The handler stub lives in
`BleManager.handleNotification` — the place to add decoding once the
per-note metadata is fully mapped.

## 16. Console's implementation map

| Concern          | Location                                                           |
|------------------|--------------------------------------------------------------------|
| Opcodes + CRC    | `android/app/src/main/kotlin/io/amar/console/glasses/G1Protocol.kt`|
| L/R GATT + queues| `.../glasses/BleManager.kt`                                        |
| Foreground svc   | `.../glasses/GlassesService.kt`                                    |
| Pair persistence | `.../glasses/PairStore.kt`                                         |
| State snapshot   | `.../glasses/GlassesState.kt`                                      |
| JS bridge        | `android/app/src/main/kotlin/.../MainActivity.kt` (`ConsoleBridge`)|
| SPA bridge       | `src/glasses/bridge.ts`                                            |
| Text wrapping    | `src/glasses/textLayout.ts`                                        |
| Hub RPC          | `server/src/routes/glasses.ts`, `server/src/glasses-hub.ts`        |
| CLI              | `cli/src/commands/glasses.ts`                                      |
| Native nav card  | §18 — `G1Protocol.Nav`/`encodeNav*`, `BleManager.nav*`, `routes/glasses.ts` `/glasses/nav/*`, `con glasses nav` |
| Dismiss/status/un-pair | §19 — `encodeDeleteNotification`/`encodeSystemStatusQuery`/`encodeBtUnpair`, `/glasses/notify/dismiss`, `/glasses/unpair` |
| Native teleprompter | §20 — `G1Protocol.Teleprompter`/`encodeTeleprompter*`, `BleManager.teleprompter*`, `server/src/glasses/teleprompter.ts`, `/glasses/teleprompt/*`, `con glasses teleprompt` |

## 17. Firmware-derived opcode map (FreedomCoder-dev/g1-reverse, 2026-09-07)

`https://github.com/FreedomCoder-dev/g1-reverse` is a **buildable Zephyr/NCS
reconstruction of the shipped G1 firmware** (nRF5340, `app_update.bin` +
`netcore_image.bin`), decompiled function-by-function and refactored into
named modules; its sibling `g1-fw` is an nRF5340 Renode emulator plus a
real-hardware OTA/flash toolchain. Investigated for card ^snug-elk. For our
purposes the firmware is the **primary source** — it outranks MentraOS
`G1.java`, which is an app-side re-implementation with its own guesses
(the "no firmware version query" claim in §12 was one).

Where to look (paths under `recon/refactor/stage_09_call_cohesion/tree/recon/symbolized/app/`):

| File | What it is |
|------|------------|
| `ble/ble_process_get_req.c` | GET requests `0x29`–`0x3E` (the `0x2C` battery/device-info handler lives here) |
| `ble/ble_process_put_req.c` + `ble_process_put_ops_*.inc` | PUT/settings requests `0x01`–`0x27` (brightness, dashboard, nav, news, quick notes, teleprompter, timers, whitelist…) |
| `ble/ble_process_req_dispatch.c` | POST requests `0x47`–`0x50` (unpair, notification push/delete, `0x4E` text) and the `0xF1`/`0xF4`/`0xF5` fast path |
| `core/send_event.c`, `core/check_work_mode.c` | the `0xF5` event emitter and the case/worn/charging state machine that names its ids |
| `../../../../../../debug_strings.txt` (repo root) | every log string in the binary, grouped by function — the fastest way to name an opcode (`BLE_REQ_GET_*`, `BLE_REQ_PUT_*`, `EVENT_*`) |
| `recon/app/src/FUN_<addr>.c` | untouched per-function evidence when the refactored copy has stripped log arguments |

The three request families the firmware distinguishes (reply byte[1] `0xC9` =
ok, `0xCA` = error with an ASCII reason; `0x66`/`0x67`/`0x68`/`0x69`/`0x6D`
mark specific GET successes):

**GET (`ble_process_get_req`)** — request `[op, id16…]`, reply `[op, marker, payload…]`

| Op | Reply marker | Payload | Firmware meaning (from log strings) / status |
|----|--------------|---------|------------------------------|
| 0x29 | 0x65 | 2 B | settings record #1 — `BLE_REQ_GET_BRIGHTNESS` or `GET_ANTI_SHAKE_ENABLE` (both log 2 bytes; not yet disambiguated) |
| 0x2A | 0x68 | 1 B | 1-byte setting (`GET_ESB_CHANNEL` logs `%d`) |
| 0x2B | 0x69 | 2 B | 2-byte setting (`GET_DISPLAY_MODE` logs 2 bytes) |
| 0x2C | 0x66 | 17 B | **`BLE_REQ_GET_DEVICE_INFO`** — battery % + charge fields + M/S/BLE firmware versions (§12). Request byte[1] `1`=Android `2`=iOS is stored as the phone platform |
| 0x2D | 0x67 | 12 B | **`BLE_REQ_GET_M_N_S_MAC`** — master + slave BLE MACs (6 + 6), `debug_print_hex_dump("get_mn_mac")` |
| 0x2E | chunked | JSON | **GET the notification app whitelist** (`send_whitelist_json_chunked`) — the read side of `0x04` (§14) |
| 0x2F–0x31 | — | — | reserved in stock firmware (error reply). `0x2F` is what g1-fw's *patched* firmware repurposes as a QSPI exporter — never send it to stock glasses expecting anything |
| 0x32 | 0x6D | 2 B | 2-byte setting (unnamed) |
| 0x33 / 0x34 | 0x33 / 0x34 | 16 B | 16-byte records — `0x34` is the serial (§11, `BLE_REQ_GET_DEVICE_SN`); `0x33` is the other 16-byte record (unnamed) |
| 0x35 | 0xC9 | 1 B | 1-byte setting (unnamed) |
| 0x36 | — | — | **notification counts** (`get_notification_counts_cmd_process`) |
| 0x37 | 0x37 | 5 B | 5-byte record (unnamed) |
| 0x38 / 0x3A / 0x3C | 0xC9 | 1 B | runtime flags read straight from the connection context (one logs `globle->check_mode %d`) |
| 0x39 | — | 6 B | **system status / current running app**: `[…, app_id]` or `0xFF` when idle (`return system status to app, current running app is %d / E_ID_SCREEN_IDLE`) — tells you whether the lens is showing the dashboard, a feature, or nothing |
| 0x3B | 0xC9 | 2 B | two context bytes (unnamed) |
| 0x3D | echo | — | language info, forwarded to the slave arm (`SendSystemLanguageInfoToSlave`) |
| 0x3E | 0xC9 | **192 B** | large device-info blob (`get_device_info()+0x10c6`, 0xC0 bytes) — untyped; worth a capture |

**PUT (`ble_process_put_req`)** — `0x01`–`0x08` handled in `put_ops_01_08.inc`
(`0x01` brightness, `0x03` silent, `0x04` whitelist, `0x06` multipart with
sub-ops `01..05` — all documented in §14); the rest map to handlers:
`0x0B`+`0x14` → `ble_put_op0b_14` (head-up angle family), `0x0C`/`0x11`/`0x12`/`0x13`
→ one handler, `0x0D`/`0x0F` → one handler (their completion is acked by
`0xF5 0xF0` / `0xF1`), `0x0E`, `0x10` → `ble_put_op10_media`, `0x15`–`0x18`
(BMP upload §7 / exit feature §14), `0x19`/`0x1A`/`0x1B`/`0x1D` → quick-note +
translate start/pause (`received start/Pause command, origin language type…`),
`0x1C`, `0x1E` (+`_note`), `0x1F` (onboarding init), `0x20` (font upgrade —
`recv upgrade font success/failed`), `0x21`–`0x27` → dashboard/teleprompter
(`received teleprompter suspend packet`, `dashboard information packet`,
`ble set lum gear`, sync ids). Named PUT requests in the string table:
`PUT_NAVIGATION_INFO` = **`0x0A`, fully laid out in §18** (turn direction, x/y,
road name, remaining km/time, panoramic + overview map chunks); still undocumented: `PUT_COUNTDOWN_TIMER`
(`countdown expect_ts:%d, enable:%d`), `PUT_SCHEDULE_TASK`, `PUT_TELEPROMPTER_INFO`,
`PUT_WAKEUP_ANGLE`, `PUT_ANTI_SHAKE_ENABLE`, `PUT_DISPLAY_MODE`, `PUT_NOTIFY_EN`,
`PUT_GLASSES_SETTING`, `PUT_INTERNAL_DEBUG`, `PUT_DEVICE_SN`, plus news/stocks
feeds (`news source : %s`, `current stocks index num`). **These are the
native features our "future ideas" (nav chevron, timer, teleprompter) would
ride on** — each is a per-handler read away from a byte layout.

**POST (`ble_process_req_dispatch`)**

| Op | Meaning |
|----|---------|
| 0x47 | **`BLE_REQ_POST_BT_UNPAIR`** — glasses forget the bond and disconnect (`will unbond current bt connection`). Programmatic un-pair for a broken bond; nothing else does this. **Implemented, §19** |
| 0x49 / 0x4A / 0x4D | write an 8-byte record via the settings store (`0x4A` carries a payload) — unnamed |
| 0x4B | notification push (§9, `BLE_REQ_POST_NOTIFICATION_MSG`) |
| 0x4C | **`BLE_REQ_POST_DELETE_NOTIFICATION_MSG`** — dismiss a pushed card. **Implemented, §19** |
| 0x4E | text display (§6) — ack `0xC9`; the render-complete follow-up is `0xF5 0xF2` |
| 0x4F / 0x50 | multi-page AI text modes (§6 mentions `0x50`) |

Fast path before the switch: `0xF4` flushes queued indications, `0xF5`
(phone→glasses direction) builds a status-notify packet, `0xF1` with
byte[2]==`0xCC` triggers `send_dmic_msg` (mic frames — §10).

### Hardware facts that explain wire behaviour

- **Master/slave is a hardware strap**: `P0.26 == 0` → `device_info[0] = 1`
  → RIGHT arm is master; LEFT is slave (`g1-fw/docs/g1-leg-identity.md`,
  watchpoint-verified in Renode). That is why only the right arm fills
  `M_SW_VER`, why head-tilt events come from the right arm, and why L-then-R
  ordering matters (§3).
- The `0xF5` third byte `0xCB` is a constant; every event goes through
  `send_event()` (§8c).

### ⛔ Safety boundary — what NOT to take from these repos

- **Firmware update rides a separate GATT service** — SMP `8d53dc1d-…`
  (char `da2e7828-…`), stock Zephyr mcumgr/MCUboot — not NUS. **Console
  must never write to that service.** The G1's MCUboot is
  `MCUBOOT_OVERWRITE_ONLY`: the primary slot is erased before the new image
  is copied, there is no backup slot, no serial/USB/ROM recovery, no
  button-gated boot mode, and APPROTECT is on — a bad image means SWD
  `ERASEALL` after physically opening the arm (`g1-fw/README.md`,
  `docs/g1-bootloader-failure-recovery.md`).
- g1-fw's "ephemeral slot", QSPI exporter (`0x2F`) and memory-read variants
  all require THEIR patched firmware on the glasses. None of it applies to
  stock glasses and none of it is for us.
- The reconstruction is a decompile of the owner's own binaries; treat
  byte layouts as strong evidence, confirm against our research log
  (`~/.config/console/glasses-research.log`) before coding to them — which
  is exactly how the `0x2C` firmware-version layout above was confirmed.

---

## 18. Native navigation card — PUT `0x0A` (`BLE_REQ_PUT_NAVIGATION_INFO`)

The glasses have a built-in turn-by-turn screen: a 50×50 manoeuvre pictogram,
road name, distance-to-turn, route ETA/remaining, and an optional map with a
"you are here" marker. Console drives it with `con glasses nav …` → hub
`POST /glasses/nav/*` → APK `G1Protocol.encodeNav*` / `BleManager.nav*`.
**There is no route source behind it yet** — this section is the layout plus
the primitive; a route provider (OSRM is already in the hub for property
drive times) is a later card.

**Source and reliability.** Byte layout: the firmware handler
`ble/ble_process_put_ops_09_10.inc` (subcommand 0–6) and the renderers under
`ui/navigation/` in FreedomCoder-dev/g1-reverse (§17) — decompiled shipped
firmware, i.e. strong evidence, *not yet confirmed against a live capture*
(no glasses were connected when this was written; the first `con glasses nav
step` against real hardware should be checked in the research log). The 35
pictogram meanings come from the same repo's `visual_assets_report.json`
`visual_description` fields — the authors' eyeballing of the decoded bitmaps
(secondary; expect a few neighbours to be swapped). No public SDK uses this
opcode (MentraOS draws its own nav via `0x4E` text/BMP), so nothing here is
cross-checked against an app.

### Frame header (all subcommands)

```
byte 0    : 0x0A
byte 1..2 : length, LE16 — the WHOLE frame including byte 0. Firmware compares it
            with the received byte count and drops the packet on mismatch
            ("packet length error").
byte 3    : seq — rolling counter chosen by us; stored per session and echoed in acks
byte 4    : subcommand (below)
```

Acks come back on NUS RX as `[0x0A, len_lo, len_hi, seq, subcmd, status, …]` —
**there is no `0xC9`/`0xCA`**, and `seq` can *be* 0xC9, so `parseAck` special-cases
`0x0A` (`G1Protocol.parseNavAck`). Send to L, await ack, then R (§3); the right
arm is the master (§17) and is what the hub reports back. When the slave's
screen isn't on navigation the master drops forwarded commands ("The master
Send the navigation command, but the slave's current ScreenID is not
navigation") — always start both arms.

| sub | name | request body (after byte 4) | ack |
|-----|------|-----------------------------|-----|
| 0 | start | — (5-byte frame) | `[…,0x00, 0x00]` 6 B. Zeroes the nav state (0xF5 bytes), sets `nav.active=1`, enters the nav app (`update_persist_task_status(10, 2)`) |
| 1 | step | `dir, x_lo, x_hi, y_lo, y_hi, s0\0, s1\0, s2\0, s3\0, s4\0` | `[…,0x01, status]` 6 B — `0` applied, `1` a string overran its buffer (**nothing** applied) |
| 2 | overview map | `total_lo, total_hi, pkt_lo, pkt_hi, data…` (data from byte 9) | 10 B: bytes 0–8 echoed + status |
| 3 | panoramic map | `total_lo, total_hi, pkt_lo, pkt_hi, flag, data…` (data from byte 10, every packet) | 11 B: bytes 0–9 echoed + status |
| 4 | sync (keep-alive) | `v` (1 byte, we send 0x01) | `[…,0x04, v]` while navigation is running, `[…,0x04, 0x00]` when it isn't ("navigation don't startup, sync packet return") |
| 5 | exit | — | `[…,0x05, 0x01]` always. Zeroes state, `nav.active=0` |
| 6 | arrived | `status, prompt…` (UTF-8, ≤63 B, **no NUL**) | `[…,0x06, 0]` ok / `1` "prompt word oversize, drop it" |

### Step (sub 1) — the per-turn update

```
[0x0A, len, len, seq, 0x01,
 dir,                 1..35  → pictogram (table below). 0 / 36+ → "navigation direction
                      parampter error", the pictogram slot stays blank, the rest still renders
 x_lo, x_hi,          0..488 (0x1e8)  ┐ "you are here" marker on the PANORAMIC map; over → logged
 y_lo, y_hi,          0..136 (0x88)   ┘ "x/y parameter overstep" and the marker is skipped
 s0 "\0"              time remaining      ≤23 B + NUL  (buffer 0x18 at nav+0x0d)
 s1 "\0"              route distance left ≤23 B + NUL  (0x18 at nav+0x25)
 s2 "\0"              road name           ≤63 B + NUL  (0x40 at nav+0x3d)
 s3 "\0"              distance to turn    ≤23 B + NUL  (0x18 at nav+0x7d)
 s4 "\0"]             current speed       ≤23 B + NUL  (0x18 at nav+0x95)
```

All five terminators must be present inside the frame (the scanner walks
`request[pos+n+1] != 0` and bails with status 1 if it runs off the end or a
string exceeds its max) — an empty field is a lone `\0`. Worst case is 170
bytes, one write. The firmware's own log line names the fields in this order:
`direction, x, y, time_remaining, remainning_kilometers, road_name_info,
remaining_distance_info, current speed`.

**What renders where.** Two views, picked by head pose (`imu_action_status`,
the same tilt that opens the dashboard):

- *Overview* (head level, the default): 136×136 map at x≈438–576 (right
  edge), `"s0 s1"` top-right (`snprintf("%s %s")` — e.g. `12 min 3.4 km`), road
  name `s2` across the middle (430 px wide), `s3` bottom-left (200 px wide),
  the pictogram at (0x55, +0x39) beside it, clock top-left.
- *Panoramic* (head up): 488×136 map at x≈88–576 with the marker bitmap
  `0x54` drawn at `(x-6, y-6)` relative to the map's top-left (i.e. `x`/`y`
  are map-pixel coordinates and the marker is centred on them), `s4` (speed),
  `s0`, `s1` stacked down the left column.

**Pictograms** (`dir` → bitmap id `dir+0x55`, 50×50 4-bit grayscale; descriptions
are the g1-reverse authors', see caveat above):

| dir | meaning | dir | meaning |
|----|---------|----|---------|
| 1 | straight ahead | 19 | curved left turn |
| 2 | slight left / veer | 20 | roundabout / loop |
| 3 | slight right / veer | 21 | roundabout / loop |
| 4 | left turn | 22 | wide right arc |
| 5 | right turn | 23 | wide left arc |
| 6 | left fork | 24 | tight hooked right |
| 7 | right fork | 25 | tight hooked left |
| 8 | hard left bend | 26 | U-turn with exit marker |
| 9 | hard right bend | 27 | U-turn with exit marker (alt) |
| 10 | U-turn | 28 | diagonal right branch |
| 11 | U-turn (alt) | 29 | diagonal left branch |
| 12 | roundabout / loop exit | 30 | right-side merge |
| 13 | roundabout / loop exit | 31 | left-side merge |
| 14 | merge / fork | 32 | sharp diagonal right |
| 15 | merge / fork | 33 | sharp diagonal left |
| 16 | roundabout turn | 34 | split / Y junction |
| 17 | roundabout turn | 35 | split / Y junction (alt) |
| 18 | curved right turn | | |

### Keep-alive (sub 4) — mandatory

`ui_navigation_task` runs a one-second countdown: 10 at start, reset to **19 by
every sync ack**, and at 0 it declares "There is a disconnection between the AR
Glasses and the Bluetooth application", tells the slave to stop (`0x0106`) and
**auto-exits navigation**. So the phone must sync at least every ~10 s (first
window) / ~19 s (after the first sync). `BleManager.navStart` arms a 5 s ticker
(`Nav.SYNC_INTERVAL_MS`); `navExit`, `disconnect()` and `stop()` cancel it, and a
sync ack with status 0 (glasses left nav on their own) cancels it too.
Nothing else needs periodic refresh — a step stays on screen until replaced.

### Maps (sub 2 overview, sub 3 panoramic) — chunked, two 1-bpp planes

Both maps are drawn by `gui_bitmps_merge_draw(x0,y0,x1,y1, planeA, planeB, 2, 0xF)`:
**two 1-bit-per-pixel planes of the same size, plane A painted gray 2 (dim),
plane B gray 0xF (bright)**, B over A. Rows are `(x1-x0)/8` bytes, LSB-first
(bit 0 = leftmost pixel of the byte). The assembled payload is the two planes
back to back:

| | region | bytes/row | rows | plane | raw total | firmware buffer |
|-|--------|-----------|------|-------|-----------|-----------------|
| overview (2) | 136 px wide (17 B → 136 px; the 138-px region's last 2 px are never written) | 17 | 136 | 2312 | **4624 = 0x1210** | `0x1210` |
| panoramic (3) | 488 px | 61 | 136 | 8296 | **16592 = 0x40d0** | `0x40d0` |

Chunking: packet index is **1-based** (`pkt == 1` resets the assembly), `total`
is the packet count; middle packets must arrive in order ("packet order error"
otherwise) and keep the running size *below* the buffer, the last packet may
land exactly on it. After the last packet the size is stored and the renderer
decides the encoding by **size alone**: exactly the buffer size → raw planes;
anything smaller → `decode_rle_byte_pairs`: `[count, value]` pairs, count 1–255,
decoded until the encoded bytes run out ("Data is in raw / rle compress raw
format"). So an RLE stream that would land on exactly the raw size must be sent
raw instead (`encodeNavMapChunks` does that). The panoramic `flag` byte
(byte 9) is stored at `nav+0xad`; no renderer reads it — send 0. A one-packet
map logs "Maps are compressed to only one pack!!!". `Nav.MAP_CHUNK_BODY = 230`
keeps every packet under the 244-byte MTU write.

### Arrived (sub 6)

`status 1` → "arrived page": the prompt (≤63 B UTF-8) replaces the road name
over the current map; `status 2` → "arrival complete": screen cleared, prompt
drawn large, and the glasses **auto-exit after 5 s** (`AUTO_EXIT_DELAY = 5000`).
`con glasses nav arrived --prompt … [--complete]`.

### Console surface

| Layer | Where |
|-------|-------|
| Encoders + ack parser + limits | `android/…/glasses/G1Protocol.kt` `Nav`, `encodeNavStart/Step/Sync/Exit/Arrived`, `encodeNavMapChunks`, `rleEncode`, `parseNavAck`; tests `G1NavigationTest.kt` |
| BLE sequencing + keep-alive | `BleManager.navStart/navStep/navArrived/navExit/navMap`, `startNavSync` |
| RPC | `PushService` `navStart|navStep|navArrived|navExit|navMap` → `{ok, status, ack}` (right arm) |
| Hub | `POST /glasses/nav/{start,step,arrived,exit,map}` (`routes/glasses.ts`, `parseNavStep` gates the firmware limits → 422 before any write; tests `glasses-nav.test.ts`), `GlassesHub.nav*` |
| CLI | `con glasses nav start|step|arrived|exit|map` (`--dir --road --dist --eta --remaining --speed --x --y`, `--prompt --complete`, `--panoramic`) |

Not built (deliberately): a route source, map rasterisation, direction
inference from a route's manoeuvre type. The APK half ships with the next
release cut; until then the hub route 502s with "unknown method" from an older
app.

---

## 19. Small primitives — dismiss `0x4C`, system status `0x39`, un-pair `0x47`

Card ^glad-vole. All three layouts are **derived from the firmware handlers**
(§17), not from MentraOS — its reference implements none of them (`0x4B` is the
only notification opcode it knows). **Not yet confirmed on hardware:** the APK
was not connected while these were written, so no frame has been through the
research log. Each is behind an explicit command, so the first real invocation
IS the confirmation — check `con glasses research tail` afterwards.

### Dismiss a pushed card — `0x4C`

```
[0x4C, msgId]        → ack [0x4C, 0xC9, …]
```

`msgId` is the same byte the card was pushed under in `0x4B` (§9) — byte[1] of
the push packet and `ncs_notification.msg_id` in its JSON. The POST dispatcher
copies `payload[1..]` (exactly this one byte) through to the other core and
**always** answers `0xC9`, so an ok ack means "the request was delivered", NOT
"a card with that id was on screen". Sent L-then-R like every other card frame.

**The hub now allocates the msgId** (`GlassesHub.allocMsgId`, rolling 1..255)
and returns it from `POST /glasses/notify` / `con glasses notify`, because the
APK used to derive it from the wall clock and never tell anyone — which is why
pushed cards lingered with nothing able to name them. An older APK still
honours the old behaviour (it falls back to its own clock-derived id if the hub
sends none), so a hub↔APK version skew degrades to "can't dismiss", not a crash.

### What's on the lens — `0x39`

```
[0x39, len_lo, len_hi, 0x00, 0x00]   → [0x39, …request bytes[0..4] echoed…, appId]
```

Bytes[1..2] are a **little-endian echo of the request's own total length** (5
for the frame above): `ble_process_get_req` compares them against the length the
BLE layer received and answers `0xFF` instead of the app id on a mismatch. Five
bytes is the smallest safe request because the handler echoes request bytes[0..4]
into the reply before writing the id at byte[5].

`appId` semantics from the handler's own log strings (`return system status to
app, current running app is %d` / `… is E_ID_SCREEN_IDLE`):

| Value | Meaning |
|-------|---------|
| `0` | idle screen (`E_ID_SCREEN_IDLE`) — nothing drawn |
| `0xFF` | firmware has no running-app id stored (also the length-mismatch answer) |
| other | the firmware's `E_ID_*` feature id — **we have not mapped these**, so Console reports the raw number rather than guessing |

**Right arm only.** The running-app id lives in the master's connection context
(§17 hardware facts: the right arm is master), and the glasses never push this
value — it has to be asked for. `GET /glasses/status` fires one query per call
(4 s budget, best-effort) and falls back to the last value in the APK snapshot
(`GlassesState.runningApp`, cleared when the right arm drops).

### Programmatic un-pair — `0x47`

```
[0x47]               → ack [0x47, 0xC9, …], then the glasses disconnect
```

Opcode only; the handler reads no payload. It acks first, then unbonds and
disconnects (`bt_conn_disconnect_by_state(handle, 0x13)`), and only if there is
an ANCS connection handle. **Human-only, and the CLI/route enforce that**
(`con glasses unpair --confirm`, body `{confirm:true}`): recovery means putting
the glasses back in the case and pairing again — there is no software undo.

Order matters in `BleManager.sendBtUnpair`: send the frame, THEN clear
`PairStore`. Clearing first would race auto-connect against a device that is
still bonded; clearing never (the earlier `unpair()` was local-only) leaves a
stale pair that makes auto-connect spin against glasses which now refuse us.

---

## 20. Native teleprompter — PUT `0x09` (`BLE_REQ_PUT_TELEPROMPTER_INFO`)

The glasses have a built-in teleprompter screen: a text block (UTF-8,
`gui_utf_draw`), a clock, a vertical progress bar, an optional "starting in N"
countdown splash with an icon, and a scroll animation. **It holds exactly one
512-byte text buffer and never pages or scrolls a longer text on its own** —
the phone app feeds it a fresh buffer per page. Console drives it with
`con glasses teleprompt <file|->` → hub `POST /glasses/teleprompt/*`
(`server/src/glasses/teleprompter.ts` paginates and pages on touchbar taps) →
APK `G1Protocol.encodeTeleprompterPage` / `BleManager.teleprompterShow`.
This replaces the "teleprompter as a `0x4E` text mirror" idea in
`g1-future-ideas.md`.

**Source and reliability.** Byte layout from the firmware handler
`ble/ble_process_put_ops_09_10.inc` (`ble_put_op9_dispatch` → `action1_single`,
`action2_mark`, `action3_7`, `action5_exit`), the `0x24`/`0x25` side-ops in
`ble_process_put_ops_21_27.inc`, and the consumer `ui/teleprompt/
ui_teleprompter_task.c` in FreedomCoder-dev/g1-reverse (§17). The card that
opened this section pointed at the `0x21–0x27` handler — that file only holds
the **suspend** (`0x24` sub 6) and **sync** (`0x25` sub 4) side-ops; the
teleprompter's own opcode is **`0x09`**. Decompiled shipped firmware = strong
evidence, *not yet confirmed against a live capture* (no glasses were connected
when this was written — see "Live verification" below). No public SDK carries
this opcode.

### Frame (every action)

```
byte 0     : 0x09
byte 1..2  : length, LE16 — the WHOLE frame including byte 0; must equal the
             BLE write length or the packet is dropped ("teleprompter packet
             length error")
byte 3     : seq — our rolling counter, echoed in the ack, stored as the sync id
             the master forwards to the slave
byte 4     : action (table below)
byte 5..6  : total packets, LE16       ┐ actions 1 / 3 / 7 only
byte 7..8  : this packet, LE16, 1-BASED ┘ (single packet: total = 1, pkt = 1)
byte 9..11 : three parameter bytes (per action, below)
byte 12..  : UTF-8 text
last 8     : int64 LE app timestamp (ms) — ONLY on the last packet (single or
             final); intermediate packets end with text. Text length is therefore
             len-20 on a single/final packet and len-12 on the others.
```

| action | name | params (bytes 9 / 10 / 11) | text | ack |
|--------|------|-----------------------------|------|-----|
| 1 | **init** — clear state, enter the teleprompter app, show text (after the splash) | 9 = countdown seconds (int8; 0 = straight to text) · 10 = low nibble picks the splash icon (0 → bitmap `0x19`, 1 → `0x1a`), bit 7 a flag the UI stores · 11 = stored beside the mark position (use unknown) | yes | 10 B: bytes 0–8 echoed + status |
| 2 | **mark** — move the highlight position | byte 5 → stored beside the position; **bytes 6..7 = u16 position** ("MARK POSITION = %d"); timestamp still read from the frame's end (16-byte frame) | no | 6 B echo |
| 3 | **text** — replace the buffer, static redraw | 9 → stored beside the position · **10..11 = u16 mark position** | yes | 10 B: bytes 0–8 + status |
| 5 | **exit** — leave the app (master forwards to the slave: "Received exit command from master") | — (6-byte frame `[09 06 00 seq 05 00]`) | no | 6 B echo |
| 7 | **text + scroll** — as 3 but sets the flag that makes the UI run `ui_render_scroll_text_frame` | as 3 | yes | as 3 |

Acks carry **no `0xC9`/`0xCA`**: `parseAck` special-cases `0x09`
(`G1Protocol.parseTeleprompterAck`). For actions 1/3/7 the status is byte 9 —
`0` applied, `1` **packet-order error**: the assembly buffer is reset and the
whole page must be resent from packet 1 ("There is a packet order error, current
packet order = %d, expected packet order = %d"). Multipart rules: `total > 1`,
packets 1..N in order; the firmware assembles into a `0x217`-byte buffer whose
text area is **0x200 = 512 bytes** (`safe_memcpy_checked(…, 0x200)`) — anything
past that is truncated, so Console refuses pages over 512 B before writing.
Send each packet to L, await the ack, then R (§3), exactly like `0x4E`.

Side-ops in the neighbouring handler: **`0x24` sub 6 = suspend/resume**
(`[24 len len seq 06 flag …ts64]`, `flag` 1 = suspended; "SUSPEND status, app
send counter time = %d" — the app's elapsed counter rides in the trailer) and
**`0x25` sub 4 = sync** — which is the **heartbeat we already send every 8 s**
(`encodeHeartbeat` = `[25 06 00 seq 04 seq]`, `OP25_SYNC_COUNT++`). The UI task
counts down 10 s at init and re-arms to 19 s on each sync, auto-exiting at 0
("The teleprompter automatically shuts down due to disconnection"), so the
existing heartbeat is the keep-alive; no extra ticker (unlike nav §18, which
has its own sub-4 sync).

### What the UI does with it

`ui_teleprompter_task` states: **0** init → if `countdown > 0` **1** splash
(icon `0x19`/`0x1a` by the mode nibble, seconds counting down from byte 9) →
**2** text (`gui_utf_draw`, clock top-left, `gui_verticalLine_process_bar` on
the right; action 7 swaps the draw for the scroll animation) → **3** exit/fade
(also entered by the double-tap that dismisses any feature — `0xF5 0x00`
reaches the phone and Console ends its session without writing). A mark
(action 2) or text (3/7) arriving in state 2 triggers a redraw. Text wider than
the lens follows the §6 rules (the teleprompter payload is multi-line, so long
rows **wrap** and push the last row off-screen) — Console pre-wraps at 38
chars and sends **exactly 5 rows per page**.

### Console surface

| Layer | Where |
|-------|-------|
| Encoders + ack parser + limits | `G1Protocol.Teleprompter`, `encodeTeleprompterPage` (chunks ≤224 B so both packet forms stay under one 244-B write; `forceMultipart` splits a short page in two), `encodeTeleprompterMark`, `encodeTeleprompterExit`, `parseTeleprompterAck`; tests `G1TeleprompterTest.kt` (7, byte-exact) |
| BLE sequencing | `BleManager.teleprompterShow(text, init, forceMultipart)` (L→R per packet, right arm's last ack returned), `teleprompterExit` (action 5, then `0x18` as belt and braces) |
| RPC | `PushService` `teleprompterShow {text, init, multipart}` / `teleprompterExit` → `{ok, status (byte 9), ack}` |
| Hub session | `server/src/glasses/teleprompter.ts`: `paginate` (5 rows × ≤38 chars, paragraph breaks kept, ≤512 B/page), `TeleprompterController` — page 1 as INIT, taps page with TEXT (right single-tap `0xF5 0x01` = next, left = previous), double-tap `0x00` ends the session, `isActive()` silences the head-tilt HUD (`wireHud` `suppressed`); tests `glasses-teleprompter.test.ts` |
| Hub routes | `GET /glasses/teleprompt` · `POST /glasses/teleprompt/{start,next,prev,goto,exit}` (`routes/glasses.ts`) |
| CLI | `con glasses teleprompt <file|->` `[--title] [--multipart]`, `next | prev | goto <n> | exit | status` |

### Live verification — still to do

No frame has been on the wire yet. First run against real glasses, with
`con glasses research on` logging: (1) `con glasses teleprompt <file>` — does a
one-packet INIT open the app (the single-packet path posts to the UI task via the
generic command message rather than the explicit `update_persist_task_status(9,
2)` the multipart-final path calls; if the lens stays idle, retry with
`--multipart`)? (2) Does `0xF5 0x01` actually arrive on a tap while the
teleprompter runs (§8a calls single-tap "inert" — that is the firmware doing
nothing with it, which is exactly what we want; if the frame never reaches the
phone, paging needs another gesture)? (3) Is the countdown byte seconds (a
`countdown = 3` INIT should show the splash for ~3 s)? (4) Does the 8 s
heartbeat keep the session alive past 19 s? Record the answers here and in
`~/.config/console/glasses-research.log`.

Expected frames for a two-page script (timestamp trailer shown as a fixed
placeholder `00 00 00 00 98 01 00 00`; the real one is the current epoch ms):

```
INIT page 1  09 44 00 01 01 01 00 01 00 00 00 00 "Line one\nLine two\nLine three\nLine four\nLine five" <ts64>
             ^^ len=68 ^^ seq  act total=1  pkt=1  p9 p10 p11
TEXT page 2  09 2d 00 02 03 01 00 01 00 00 00 00 "Page two, row one\nrow two" <ts64>
EXIT         09 06 00 03 05 00                      (then 0x18)
ack (page)   09 <len16> <seq> <act> 01 00 01 00 00  — 10 B, byte 9: 0 ok / 1 order error
ack (exit)   09 06 00 03 05 00                      — 6 B echo
```
