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

## Status (updated 2026-06-25)
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
