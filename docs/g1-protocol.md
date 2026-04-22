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
| 0x4B | Notification push   | → glasses | `[0x4B, msgId, maxSeq, seq, json...]`, 176-byte chunks |
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
| 0x06   | —       | Glasses removed from case (variant A) |
| 0x07   | —       | Glasses removed from case (variant B) |
| 0x08   | —       | Case lid opened |
| 0x09   | byte[2] | **Per-arm charging-pin contact:** `1` = arm sitting on its case charging pin, `0` = lifted off. Fires on each arm independently. Distinct from 0x0E (whole-case charging state). Not in MentraOS — Console finding. |
| 0x0A   | byte[2] | **Unsolicited arm battery push (0–100 %).** Fires when the arm docks onto its charging pin — complements the polled `0x2C` reply. Not in MentraOS — Console finding. |
| 0x0B   | —       | Case lid closed |
| 0x0E   | byte[2] | Case charging status; `1` = charging, `0` = not |
| 0x0F   | byte[2] | Case battery level (0–100) |

### 8c. Unclassified

| Subcmd | Status |
|--------|--------|
| 0x12   | Seen on right arm when long-press-right is triggered *while the mic is already armed* (e.g. from a prior manual `setMic(true)`). Semantics TBD — possibly "gesture rejected, feature busy". Not in MentraOS or emingenc. |

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

- `0xF5` subcmd `0x12` — fires on long-press-right when the mic is already
  armed. Exact semantics TBD.
- Firmware version query — **G1 doesn't expose one.** MentraOS `G1.java` line
  1761 explicitly states "G1 doesn't support version info requests"; `0x34`
  retrieves the serial but that's it. Treat the `firmware` slot on snapshots
  as permanently null (or drop it — Console dropped it in v0.1.16).

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
| Hub RPC          | `server/src/routes/glasses.ts`, `server/src/push/rpc.ts`           |
| CLI              | `cli/src/glasses/*.ts`                                             |
