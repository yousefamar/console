# G1 on Console — Future ideas

Captured during the initial scoping conversation (2026-04-18). These are
**not** part of the v1 glasses integration — v1 is intentionally a dumb
pipe (text / BMP / notification / mic / touchbar) exposed to hub, SPA, and
`con` CLI. This file records the ambient ideas so we don't lose them.

## Feature catalog (unordered)

- **Notifications mirror** — *shipped 2026-06-27 (v0.1.36).* Every hub push
  (mail / chat / calendar / agent / Monzo) forwards to the lenses as a native
  `0x4B` firmware card, gated by `GlassesConfig` (master + per-source toggles)
  and the global DnD pref. Hub-driven (`pushServer.onBroadcast` →
  `notify-forward.ts`), so it fires even when Console is backgrounded. Required
  the `0x04` app-whitelist (firmware drops `0x4B` otherwise).
- **Agent glance card** — current agent turn, AskUserQuestion prompts,
  ExitPlanMode prompts surface on the lenses with touchbar y/n.
- **Calendar next-up** — *shipped 2026-06-27 (v0.1.36)* as part of the idle
  HUD (head-tilt up). The hub-side HUD (`hud.ts`) renders time + battery, next
  event, and unread counts (mail / chat / agent); refreshes every 30s while
  held up. Triggered by `0xF5 0x02` head-up, cleared on `0x03`.
- **Now-playing / context card** — whatever Console considers "current
  context" for an idle state.
- **Inbox glance** — unread count per source.
- ~~**Teleprompter**~~ — BUILT on the firmware's native `0x09` teleprompter (protocol §20, `con glasses teleprompt`), not as a `0x4E` mirror: 5-line pages, touchbar next/prev.
- **Walking nav** — next-turn chevron once Console has a live route source.
  *Firmware has a NATIVE handler for this* (`BLE_REQ_PUT_NAVIGATION_INFO`:
  direction, x/y, road name, remaining km/time, panoramic + overview map
  chunks — protocol §17), as it does for **countdown timer**
  (`PUT_COUNTDOWN_TIMER`) and **teleprompter** (`PUT_TELEPROMPTER_INFO`).
  Byte layouts are one per-handler read away in g1-reverse — cheaper than
  re-implementing these as `0x4E` text mirrors.
- **Stopwatch / alarm** — simple HUD utilities. (The **countdown timer** is DONE natively — `con glasses timer`, protocol §21, ^wavy-crow.)
- **SSH / terminal mirror** — port `g1-term` ideas in as a Console pane;
  see `docs/g1-ssh-client-recipe.md`.
- **App-wide mirror** — *generalized 2026-04-22 (v0.1.17).* Single
  "Mirror current tab" toggle in Glasses settings renders whichever pane
  is active onto the lenses: row 1 = status (`Pane · focus · meta`),
  rows 2–5 = per-pane body built by a renderer in
  `src/glasses/panes/<name>.ts`. Notes keeps the cursor-follow behaviour
  (line numbers + `|` glyph at the column) shrunk to 4 body rows. Chat
  and Agents reserve row 5 for a composer echo (`> …|`) driven by
  `useGlassesStore.composerText`. 30 ms coalescing debounce, same
  zero-hub path via `ConsoleNative.glassesSendText`. Persisted via
  localStorage (`console:glasses:mirrorEnabled`; the old
  `notesMirrorEnabled` key auto-migrates).
- **Voice → Al → glasses reply** — long-press temple, speak, live STT on
  the lenses, Al answers in-place. Closes the loop.
- **Live translation / transcription** — STT + translate, shown on the
  lenses during conversation.

## Architecture sketch for "cards" layer (future)

If/when we add higher-level semantics on top of the dumb pipe, the model
that fits naturally is a **card queue** owned by the hub:

- Each card has `{id, source, priority, ttlSec, renderer: "text"|"bmp", body}`.
- Hub maintains a priority queue per connected phone.
- One card displayed at a time; dismissal (touchbar double-tap → pane) pops
  to the next.
- Renderer: "text" sends via `0x4E`, "bmp" rasterises in the SPA then sends
  via `0x15`.
- Sources register cards via `POST /glasses/cards` and update/dismiss via
  `PATCH` / `DELETE`.
- Idle state: show the highest-priority idle card (calendar next-up by
  default) with no TTL.

This layer would live entirely in the hub; the phone/native side stays
dumb.

## Touchbar routing philosophy

Events (`0xF5` subcmds) should route to the "active pane on glasses" —
i.e. the last source to push content. Concrete mapping to revisit later:

- Single-tap: "advance" within current pane (next notification, next
  teleprompter page, paginate e-book, next event).
- Double-tap: dismiss current pane → revert to idle card.
- Triple-tap: quick pin (promote current card to a pinned idle card for
  the next 10 minutes).
- Long-press start: mic on, Al listening.
- Long-press release: mic off, Al replies.

## Mic input path — planned but not wired

- Glasses emit `0xF1 seq <200B LC3>` every 20 ms.
- Phone decodes LC3 → PCM S16LE 16 kHz via bundled `liblc3` JNI.
- Phone streams PCM to hub as WS event frames (base64 or binary frames).
- Hub pipes into existing `/stt` endpoint (external STT).
- Hub streams partial transcripts back to phone → glasses via `0x4E`,
  so the user sees the transcript live on-face.
- On completion, hub dispatches the transcript to Al; Al's reply comes back
  as a normal glasses text send.

## Constraints / non-goals for v1

- **Not multi-device.** Single pair of G1s belonging to the user.
- **Not cross-platform.** APK only. PWA glasses support is not planned.
- **No privacy redaction.** The lenses are seen only by the user.
- **No battery UI yet** — opcode unknown (see `g1-protocol.md` §12).

## Open protocol questions to investigate later

- ~~G1 battery opcode~~ — `0x2C` (protocol §12), long resolved.
- ~~Firmware version query~~ — **resolved 2026-09-07**: it is IN the `0x2C`
  reply (bytes [7..12], master/slave triples; v1.6.6 on our pair). Firmware
  source in protocol §17. Android parity (re-populate `GlassesState.firmware`)
  is a BACKLOG Open entry for the Mobile agent.
- Whether `rnnoise` (bundled but unused in EvenDemoApp) is useful for us.
- Whether multi-page AI scroll modes (`0x30` / `0x40` / `0x50`) give us
  cheaper pagination than manual re-sends.
