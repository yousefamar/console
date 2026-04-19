# G1 on Console — Future ideas

Captured during the initial scoping conversation (2026-04-18). These are
**not** part of the v1 glasses integration — v1 is intentionally a dumb
pipe (text / BMP / notification / mic / touchbar) exposed to hub, SPA, and
`con` CLI. This file records the ambient ideas so we don't lose them.

## Feature catalog (unordered)

- **Notifications mirror** — Matrix DMs, Gmail new mail, Calendar reminders,
  Monzo webhook. Uses the existing push pipeline; sink becomes "glasses"
  alongside the Android system notification.
- **Agent glance card** — current agent turn, AskUserQuestion prompts,
  ExitPlanMode prompts surface on the lenses with touchbar y/n.
- **Calendar next-up** — permanent idle card showing next event time/title,
  refreshing on the minute.
- **Now-playing / context card** — whatever Console considers "current
  context" for an idle state.
- **Inbox glance** — unread count per source.
- **Teleprompter** — long-form text paginated by touchbar, 5 lines at a time.
- **Walking nav** — next-turn chevron once Console has a live route source.
- **Stopwatch / timer / alarm** — simple HUD utilities.
- **SSH / terminal mirror** — port `g1-term` ideas in as a Console pane;
  see `docs/g1-ssh-client-recipe.md`.
- **Notes-on-lenses mode** — *shipped 2026-04-19.* Toggle in Glasses
  settings ("Mirror Notes to lenses (follows cursor)"). The CM6
  `updateListener` in `src/components/NotesEditorCore.tsx` fires on doc
  or selection change, computes a 5-line window (cursor-line = last line
  if at EOF, else penultimate), and calls `sendText()` in
  `src/glasses/notes-mirror.ts`, which hits `ConsoleNative.glassesSendText`
  directly — no hub. 30 ms debounce with coalescing (stale updates
  dropped). `GlassesService` keeps BLE alive with the phone screen off so
  HW-keyboard-on-phone typing works with the display off. Persisted via
  localStorage key `console:glasses:notesMirrorEnabled`.
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

- G1 battery opcode (candidate sources: community Python `even_glasses`,
  sniffed Even Realities app traffic, `i-soxi/even-g2-protocol`).
- Firmware version query.
- Whether `rnnoise` (bundled but unused in EvenDemoApp) is useful for us.
- Whether multi-page AI scroll modes (`0x30` / `0x40` / `0x50`) give us
  cheaper pagination than manual re-sends.
