# Neo / Moleskine Pen+ (NWP-F130) — Stroke-Recovery Plan

## Why
Yousef owns a Moleskine Pen+ (a NeoLAB "Neo smartpen", model **NWP-F130**, firmware
**3.02**). The official Moleskine / Neo Notes app (v1.8.18 on his phone) is abandoned
and **can no longer sync** — the pen is months from being a paperweight. The pen still
holds his handwriting in onboard flash ("offline data"). Goal: **bypass the dead app +
cloud, talk to the pen directly over BLE, and get the strokes off.** Offline backlog
first (the rescue), then live streaming. Final home: a Console `pen/` Android subsystem
mirroring the existing `glasses/` stack.

## The key realisation
The pen's protocol is defined by its **firmware**, not the app. NeoLAB **open-sourced
their SDKs**, so the protocol is already in readable source — we don't reverse a
decompiled APK, we read NeoLAB's own client and validate against the physical pen (same
lesson as the G1 work: reading an open client beats decompiling). The downloaded
`Moleskine Notebooks 3.0.7` XAPK is the *wrong* app and is ignored; the real app (1.8.18)
is kept only as a **lazy fallback** if the SDK proves stale on the auth handshake.

## Sources (provenance)
Cloned to `/tmp/pen-research/`:
- **`NeoSmartpen/Android-SDK2.0`** (Java) — primary. `kr.neolab.sdk`:
  `bluetooth/comm/CommProcessor20` (ProtocolV2 parser — the N2/F130 dialect),
  `bluetooth/cmd/*` (Establish / PenStatus / SetTime / FwUpgrade…),
  `offline/OfflineByteParser` (the rescue), `bluetooth/BTLEAdt` (GATT UUIDs),
  `ink/structure/Dot`. Ports → our Kotlin `PenBleManager`.
- **`NeoSmartpen/WEB-SDK2.0`** (TypeScript) — ports ~1:1 into the hub (Node/TS).
- **`NeoSmartpen/Documentations`** — NeoLAB's own format PDFs (`NeoNote_data`,
  Caster™ Lite XML, Ncode getting-started).
- **`NeoSmartpen/Ncode-SDK2.0`** — dot-pattern / coordinate spec, for Phase 3 page mapping.
- Cross-reference: `Windows-SDK2.0` (C#), `IOS-SDK2.0` / `iOS-SDK3.0`.

## Hardware / context
- Pen: **NWP-F130, fw 3.02** (Neo smartpen N2 family → **ProtocolV2 / `CommProcessor20`**).
- Notebook: Moleskine Smart Cahier Pocket Ruled, Ncode notebook id **727**.
- Phone: Ulefone Armor Mini 20 Pro, Android 15. App 1.8.18(825) installed but cloud sync dead.
- Laptop: working BLE 5.1 adapter (`hci0`) — can drive the pen directly for fast iteration.

## Safety invariant (non-negotiable)
Some Neo firmware **erases offline data from flash once a page transfer is acked**. So:
1. The official app **can't sync**, so it is *not* a delete threat. Good.
2. The only erase risk is **our own** client tripping the firmware's transfer-success erase.
3. → **Never read the real backlog until we've proven non-destructive on disposable test
   strokes.** Resolve the auto-erase question (in `OfflineByteParser` + the offline
   command/ack flow, and empirically) before touching anything irreplaceable.
4. Persist raw frames + decoded strokes to disk **before** sending any ack that could
   trigger erase.

## Phases
**Phase 0 — SDK study & protocol extraction** *(in progress)*
Read the SDK; write `docs/neo-pen-protocol.md` (provenance-headed, mirrors
`docs/g1-protocol.md`): GATT UUIDs, frame format (start/end/escape, cmd, LE length,
payload, checksum), auth/password handshake (`EstablishCommand`), dot-stream events +
coordinate encoding (`Dot`, fractional `fx/fy`), offline list/read/delete commands +
**erase semantics**. Output: opcode table + frame spec from source.

**Phase 1 — Live stroke decode (read-only)**
Laptop `bleak` scratch client (fast loop): connect → auth → subscribe notify → read live
dots → decode coords by writing known shapes (dot, line, X). Then port decode into a
pure, unit-tested `PenProtocol.kt`. Non-destructive by nature.

**Phase 2 — Offline rescue (3-step gate)** ← the win
1. Implement offline-list + offline-read from SDK (never send delete).
2. **Prove non-destructive on disposable dots** — write throwaway strokes, read them,
   re-list, confirm survival; settle the auto-erase question.
3. Dump the real backlog → `~/.config/console/pen/offline/*.json`, persisting before any ack.

**Phase 3 — Ncode page mapping** *(stretch)*
Raw dot coords → real page coordinates via the Ncode address (section/owner/note/page)
for notebook 727. Default deliverable is raw strokes + page address; full registration
is follow-up.

**Phase 4 — Productionise as Console `pen/` subsystem**
Mirror `glasses/`: `android/.../pen/` (`PenProtocol.kt` pure, `PenBleManager.kt` w/
**MTU 247 before `discoverServices`**, `PenStore`, `PenState` StateFlow, `PenService`
foreground `connectedDevice`); `PushService` RPC framing (`pen_state` / `pen_frame` /
offline-pull); hub `server/src/pen/` (RPC pipe + `pen-research.log` NDJSON + `/pen/*`
routes); `con pen …` CLI; SPA store + strokes viewer (SVG/JSON, vault integration).

## Tooling
Present: `adb`, Android SDK, Java 17, BLE `hci0`. To install: `python3-bleak` (scratch
client). **Not needed unless the auth-handshake contingency triggers:** `jadx` + the
correct 1.8.18 APK.

## Risks / kill-criteria
- **Auth/registration handshake** stale vs fw 3.02 → fetch 1.8.18 APK, jadx just the
  handshake. The only real escalation path.
- **Auto-erase on transfer** → mitigated by the disposable-data gate.
- Backlog is safe on flash now; the urgency is the *app*, so we have time to be careful.

## Status (updated 2026-09-10)
- **Support saga, latest:** Moleskine's replacement app (Notebooks 3.0.15, `com.moleskine.notes`
  beta track) did NOT fix the empty-offline-index bug. Sandra (Moleskine Digital Support; threads
  `19ff4de81707479f` + `1a065ffae697b7a4`, the latter spawned by the in-app ticket) **retracted
  the 3.03 firmware on 2026-09-03: 3.02 is current**, the update nag is an app bug — so there is
  no firmware image to chase and the FW_FILE flash route (`0x31`/`0x32`) is moot. She also
  stated Moleskine has **no recovery path** for data the pen no longer transfers; a full reset
  clears it. Her last suggestion: **soft reset (hold power ~15 s) → retry transfer in Notebooks**,
  or wait for the next app update (no release date). Ball is Yousef's; untried as of 2026-09-10
  (threads silent since 3 Sep, Play Store stable still 1.8.18 of Aug 13, no mirror above 3.0.15).
  Full chronology: `memory/project_neo_pen_re.md`.
- **Phase 0 ✅** protocol extracted. **Phase 1 ✅** live stroke capture works on the real
  pen (NWP-F130 "Smart Pen", V5 GATT UUIDs not 0x19F1, password `1551`, decoded x/y/force).
- **Phase 2 (offline rescue) BLOCKED + PARKED** — *not our bug*: a known Moleskine firmware
  issue makes the pen report its offline store EMPTY (every `0x21`–`0x24` query → 0) while
  flash is 85% full; the **official app fails identically** ("the pen does not contain any
  strokes in memory"). Confirmed across all 3 SDK generations — no alternative read command.
  Moleskine acknowledged it (Gmail support thread) and is building a fix; Yousef can't update
  firmware (known network-error). Data is safe on the pen. Full writeup + recovery routes:
  `memory/project_neo_pen_re.md`.
- **Live streaming into Notes ✅ BUILT (2026-06-25; live hardware verify pending).** Hub
  decodes `pen_frame` → assembles per-Ncode-page SVG at `scratch/pen/<note>/page-<page>.svg`
  (`server/src/pen/{page-codec,page-assembler}.ts`) + broadcasts SyncBus `pen`; Notes tab
  renders the handwriting (`PenPageRenderer.tsx`) with prev/next nav + live overlay. Tests +
  tsc green. Later: per-page OCR-via-LLM. See `memory/project_neo_pen_re.md` + CLAUDE.md Notes.
- Protocol reference: `docs/neo-pen-protocol.md`.

## Live pen pages — implementation detail (moved from CLAUDE.md 2026-09-08)

**Live pen pages** (Neo smartpen → Notes): the hub assembles live BLE strokes into per-Ncode-page **SVG** files at `scratch/pen/<note>/page-<page>.svg` and the Notes tab renders them as handwriting with prev/next page nav. **Hub-side**: the APK already forwards each event as `pen_frame{kind:'dot',hex}` over `/push`; `server/src/pen-hub.ts` decodes the hex via the pure `server/src/pen/page-codec.ts` (TS port of `PenProtocol.parseIdChange/parseDot`; `decodeEventFrame`/`renderPageSvg`/`parsePageSvg`) and feeds `server/src/pen/page-assembler.ts` (`PenPageAssembler`: `0x6B` page-change → flush+reload-existing-then-append, `0x69`/`0x6C`/`0x6A` → open/dot/close stroke; writes the SVG on pen-up via `NoteStore.write`). The lossless `PenPageDoc` (strokes with x=`X+fx*0.01`/y/force/t) is embedded in `<metadata><penpage>{json}</penpage></metadata>` (numeric JSON, no `<`/`&`, embeds raw). PenHub now takes `noteStore`+`syncBus` (built in `index.ts` before PenHub) and **broadcasts SyncBus service `pen`**: `page_open`/`stroke_delta`/`stroke_end`/`page_saved` (all carry `{section,owner,note,page}`). **SPA**: `src/components/notes/PenPageRenderer.tsx` parses the embedded strokes, draws an `<svg>` (viewBox from stroke bbox in Ncode units), and overlays live strokes from the `pen` bus (rAF-batched, filtered to the open page; on `page_saved` re-reads the durable SVG and clears the overlay). `NotesEditor.tsx` mounts it instead of `NotesEditorCore` when `isPenPagePath(activeFilePath)` (`store/notes.ts`: `scratch/pen/**.svg`); `nextPageInFolder`/`prevPageInFolder` walk siblings by page number; a module-level `pen.page_saved` subscription adds new pages to the file list (`notePageSaved`) so they appear in the tree without a rescan. **GOTCHA**: the vault file walkers list `.md` only — BOTH `server/src/notes.ts` and `src/notes/vault-adapter.ts` `walkDir` were widened to also include `.svg` **scoped to `scratch/pen/`**. Pure logic unit-tested in `server/src/__tests__/pen-page.test.ts`. **Live streaming is opt-in** (`con pen stream on|off` / the "live → Notes" toggle in pen settings; persisted in `pen-auth.json`, **default off**): the pen only streams live dots after the hub registers **AddUsingNotes** (`0x11`, payload `ffff` = all notes) post-auth — without it the pen is in offline-save-only mode and emits NO live dots (this stumped a whole debugging session). The hub sends it on connect when enabled (`pen-hub.ts onStateUpdate` → `registerLiveStream`; coexists with offline-save, so no flash backup is lost), alongside **remembered-PIN auto-unlock** (the confirmed-good unlock PIN persists in `pen-auth.json` and is auto-sent once per connect; **forgotten on any failed auto-attempt** so a wrong PIN can't burn the retry counter — `con pen forget`; the seeded PIN is `1551`). **Rendering**: fixed Pocket-Cahier page viewBox (`NCODE_PAGE_W/H` in Ncode units, 1u≈2.371mm = `56/600` inch) so the canvas doesn't grow as you write, and pressure-weighted **variable-width ribbon** strokes (`forceToWidth`/`strokeRibbonPath`, duplicated hub+client) — one filled `<path>` per stroke. **Later (not built)**: per-page OCR (rasterize SVG→PNG → `claude -p`, mirror `/blog/format`) folded into a markdown note; friendly notebook names.
