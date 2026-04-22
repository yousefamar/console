# Console — Bespoke Command Center

## Before committing
Before running any git commit, check whether anything learned in this session belongs in CLAUDE.md (architecture decisions, new subsystems, non-obvious wiring, hub endpoints, build steps). If yes, update CLAUDE.md in the same commit. Ditto for the `memory/` system when the lesson is user-level or cross-project. Do not skip this step.

## What is this?
Personal command center: offline-first Gmail inbox + Matrix chat + Obsidian bookmarks + vault notes editor + RSS/Atom feeds + Google Calendar + Monzo banking + Claude Code agent sessions, unified under inbox-zero. No labels, no folders — just fast triage.

## Architecture
- **PWA** — installable standalone, works in any browser including mobile
- **Android APK** (`android/`) — thin native-Kotlin WebView wrapper for the phone (PWA install was flaky). Loads the same tailnet URL as the browser. Routes OAuth into Chrome Custom Tabs, handles `console://` deep links, in-app updater polls the hub.
- **Offline-first** — all mutations (email, chat, calendar) write to IndexedDB first, sync via queue
- **Hub server** — Node.js backend (`server/`) proxies all API calls (Gmail, Calendar, Matrix, Monzo), manages OAuth tokens, hosts agent sessions. HTTPS via Tailscale certs.
- **Sub-app isolation** — Layout subscribes only to `activePane`. Each tab component is `React.memo`'d. A chat state change never re-renders the email pane.
- **Pre-rendered panes** — all panes mounted with `display:none`, toggled on selection for instant switching

## Tech Stack
React 19, TypeScript, Vite, Zustand, Dexie.js (IndexedDB), Tiptap 3 (email compose), CodeMirror 6 + vim (notes), Tailwind CSS 4, Lucide React, Day.js, Vitest, ws (WebSocket), @matrix-org/matrix-sdk-crypto-wasm (E2EE)

## Project Structure
```
src/
  main.tsx, App.tsx, hub.ts, notifications.ts, debug-agent.ts
  db/          — Dexie schema + offline sync queue
  gmail/       — Auth (hub-based), API, sync, types
  matrix/      — Auth, API, crypto (E2EE), sync, key-backup
  calendar/    — API (hub-proxied), accounts, types, sync (offline queue)
  store/       — Zustand stores: inbox, chat, calendar, bookmarks, notes, feeds, money, agent, ui
  hooks/       — useKeybindings, useSync, useMediaQuery, useSwipeActions
  components/  — All UI components (Layout, *Tab, *View, *List, etc.)
  notes/       — Vault adapter (FSA + Hub), search index, CM6 live preview
  utils/       — Email, date, HTML helpers
server/
  src/
    index.ts         — HTTP/HTTPS + WebSocket server, route dispatch
    session.ts       — Claude CLI subprocess manager
    auth-store.ts    — OAuth token manager (~/.config/console/auth.json)
    debug-log.ts     — Debug event log file manager
    debug-protocol.ts — Debug agent protocol types
    routes/          — auth, mail, calendar, matrix, monzo, bookmarks, feeds, notes, agents, debug
cli/               — `con` CLI tool (81 commands, self-describing)
android/
  app/src/main/
    kotlin/io/amar/console/
      MainActivity.kt   — WebView + OAuth Custom Tabs + deep links + update banner
      PushService.kt    — foreground service holding WebSocket to /push, posts system notifications
      BootReceiver.kt   — restarts PushService + GlassesService after reboot / app upgrade
      glasses/          — G1 smart glasses subsystem
        G1Protocol.kt   — opcodes, chunking, CRC32-XZ (pure, testable)
        BleManager.kt   — dual-arm GATT, write queues, L-then-R ack sequencing
        PairStore.kt    — SharedPreferences-backed paired MACs (single pair)
        GlassesState.kt — process-wide StateFlow singleton
        GlassesService.kt — foreground service (type connectedDevice)
    AndroidManifest.xml                     — permissions, console:// intent filter, service, receiver
    res/                                    — adaptive icon, themes, strings
  scripts/        — build-debug.sh, build-release.sh, generate-keystore.sh
  app/build.gradle.kts                      — minSdk 26 / targetSdk 35 / applicationId io.amar.console
```

## Debugging (PRIMARY METHOD)

**Use the embedded debug agent, NOT browser DevTools or Chrome MCP tools.**

The app has a built-in debug agent (`src/debug-agent.ts`) that streams all console output, network requests, and errors to the hub in real-time. Claude Code observes via HTTP endpoints:

```bash
# See recent events (console logs, network requests, errors)
curl -sk https://localhost:9877/debug/log?n=30

# Filter for errors
curl -sk https://localhost:9877/debug/log?n=100 | jq '.[] | select(.cat=="error")'

# Filter for failed network requests
curl -sk https://localhost:9877/debug/log?n=100 | jq '.[] | select(.cat=="net" and .status >= 400)'

# Execute JS in the browser (replaces Chrome MCP javascript_tool)
curl -sk -X POST https://localhost:9877/debug/eval -H 'Content-Type: application/json' -d '{"code":"document.title"}'

# Get Zustand store state
curl -sk https://localhost:9877/debug/state

# Check if debug agent is connected
curl -sk https://localhost:9877/debug/status
```

The debug agent:
- Captures from page load (imported first in `main.tsx`)
- Survives navigation (WebSocket auto-reconnects)
- Works across all tabs/devices (all stream to same hub)
- Logs to `~/.config/console/debug.log` (NDJSON, auto-rotated at 5K lines)
- `window.__console` (dev-only) exposes Zustand stores + Dexie db for browser console access

## Key Patterns

### Auth
- **Hub-managed OAuth** — all tokens stored server-side in `~/.config/console/auth.json`. Frontend bootstraps via `GET /auth/token`. Sign-in opens hub's `/auth/google/start` in a popup.
- **Multi-account** — hub stores multiple Google accounts. Calendar sidebar can add accounts via OAuth flow.
- **Token refresh** — hub proactively refreshes tokens 5min before expiry. Frontend re-fetches from hub on 401.

### Offline Sync Queue
- **Shared queue** — `src/db/sync-queue.ts` provides `enqueue()`, `markDone()`, `markFailed()` for all services
- **Action types** — email (`archive`, `send`, etc.), chat (`chatSend`, `chatMarkRead`), calendar (`calCreate`, `calUpdate`, `calDelete`, `calRsvp`, `calReminder`, `calLocation`)
- **Pattern** — optimistic IDB write → `set()` for instant UI → `enqueue()` → background processor flushes within 500ms
- **Retry** — 3 retries before marking `failed`. Queue survives page reload.
- **Undo** — delete actions show 5-second undo toast. Undo removes from queue + restores IDB.

### Email
- Optimistic archive/snooze with undo. Auto-archive on reply. Pre-rendered iframes. CID inline images.
- Snooze is local-only (Gmail has no snooze API). Conflict detection before sending queued replies.
- Send-as aliases fetched during sync. Calendar invites parsed from `text/calendar`.

### Chat (Matrix)
- Direct REST API (no matrix-js-sdk). E2EE via OlmMachine WASM. Long-polling sync.
- Local echo with `~timestamp.random` IDs. Bridge detection (WhatsApp, LinkedIn, Slack).
- Pre-rendered room views. Pinned favourites grid. Edit/delete diffs via `diffWords`.
- **Send failures surface in the UI**: Beeper bridges emit `com.beeper.message_send_status` events referencing the original encrypted event. Browser-side `src/matrix/sync.ts` flips `sendFailed` on the local echo and fires a notification. SUCCESS status clears any prior fail marker. Root cause of FAIL_RETRIABLE is almost always the hub device not being cross-signed — run `POST /matrix/keys/restore-cross-signing` (see Matrix recovery workflow below).
- **Force-rotate Megolm**: `matrix.rotateRoomKey({roomId})` RPC (→ `HubMatrixCrypto.invalidateRoomKey`) throws away the outbound session so the next send re-keys from scratch. Useful when a bridge gets into a wedged state. Note: `invalidateGroupSession` only touches the in-memory session, so we pre-load by calling `shareRoomKey(roomId, [], …)` first — otherwise after a hub restart the persisted stale session stays live.
- **Resume semantics (gap recovery)**: the hub runs one /sync loop and broadcasts `matrix.delta` over SyncBus — fire-and-forget, no per-client buffer. Reconciliation uses Matrix's **native** resumable-sync primitive: the client persists `next_batch` from every ingested delta (in `meta` table under `matrix:lastBatch`), and hands it back to the hub via `matrix.resume({since})` RPC on any wake signal. Hub calls `/sync?since=<token>&timeout=0`, decrypts, returns the delta directly (point-to-point, not broadcast). Trigger points all converge on a single debounced `reconcile()` in `src/hooks/useSync.ts`: (1) `hubBus.onConnect`, (2) `document.visibilitychange → visible` (critical for APK — the WebView pauses while backgrounded so WS stays "up" from JS's perspective and onConnect never fires), (3) `window.online`. `bulkPut` on event_id makes re-ingestion idempotent, so racing live-delta + resume is safe. If the homeserver rejects the `since` (expired), hub falls back to initial sync and flags `isInitial` on the response. `processJoinedRoom` gates `lastMessageBody`/`lastMessageTime` behind `advancesPreview` (newest-by-timestamp > existing) so out-of-order resume ingestion can't roll a room preview back to an older message.
- **Limited-timeline backfill**: Matrix `/sync` caps each room's timeline at ~10 events and sets `limited: true` + `prev_batch` when more happened during the gap. The APK WebView gets paused while backgrounded — on resume, its `since` token is far behind and sync returns many truncated rooms, so without backfill the local cursor jumps past real messages. Hub-side `backfillLimitedTimelines()` in `server/src/matrix/sync.ts` walks `/rooms/{id}/messages?from=prev_batch&dir=b` (limit 100) for each limited room, reverses to forward order, decrypts, and **prepends** the gap events before broadcasting the delta. Runs on both `resume()` (skipped on `isInitial`, since the full initial sync has no gaps) and `tick()` (live loop). Idempotent via `bulkPut(event_id)` client-side.
- **Redaction tombstones (bridges)**: WhatsApp / Signal delete events come through as `m.room.encrypted` with `content: {}` (the original ciphertext stripped) plus `unsigned.redacted_because.{sender,type:"m.room.redaction"}`. Without special handling they render as "🔒 Encrypted message" placeholders. Fix lives in `src/matrix/sync.ts`: `eventToMessage` returns `null` for tombstones, and `processJoinedRoom` has a pre-loop guard that flips any existing row's `isDeleted=true` + `deletedBy=<redactor>` when a tombstone for it arrives. Detect via `event.type === 'm.room.encrypted' && typeof event.content?.ciphertext !== 'string'`.
- **Hub Megolm backup upload (auto)**: on every boot, `server/src/index.ts` calls `hubMatrixCrypto.activateBackupUpload(homeserver, token)` which GETs `/room_keys/version`, extracts the public key, and calls `enableBackupV1(pub, ver)` — encryption-only, no recovery key needed. From that point on every new Megolm session the hub receives via to-device is auto-uploaded through `processOutgoingRequests` → `/room_keys/keys`, so a later hub re-init can restore everything. A one-shot `backupPendingRoomKeys()` sweep runs after activation to upload any sessions imported from the local M0 backup or received while backup was inactive. Boot log line: `[hub-crypto] backup upload activated (version N)` followed by `[hub-crypto] backed up N pending room keys` if any were outstanding.

### Calendar
- **Hub-proxied** — all API calls go through hub (`/cal/*`), which handles tokens server-side
- **Offline-first** — all mutations (create, update, delete, RSVP, reminder, location) are optimistic with sync queue
- **Temp IDs** — created events use `~timestamp.random` IDs, replaced with real Google IDs after queue processes
- Custom week/day grid. Drag-to-create/move/resize. Recurring event dialog. Event merging across calendars.

### Bookmarks
- 977+ `.md` files in Obsidian vault. Hub parses + caches. Browse mode + Tinder-style triage mode.

### Notes
- CodeMirror 6 with vim mode. Obsidian-style live markdown preview. FSA or hub adapter.
- Quick Switcher (fzf fuzzy + MiniSearch full-text). Multi-file tabs. No auto-save.

### Feeds
- Server-side RSS/Atom fetching. Offline reading via IndexedDB. OPML import/export.
- Optional full-text extraction via Readability. 15-min refresh interval.

### Money (Monzo)
- Hub proxies Monzo API. Single-use refresh tokens. Server-side transaction cache.
- SCA required after OAuth. Webhook for real-time transaction notifications.

### Agents (Claude Code)
- Hub spawns `claude` CLI subprocesses. NDJSON protocol over stdin/stdout.
- WebSocket relay to browser. Auto-approve all tools except AskUserQuestion.
- Session persistence across hub restarts. Message replay for late-joining clients.
- Al (personal AI) connects on `/al` WebSocket path.

### Glasses (G1)
- **Native Kotlin BLE**, not Web Bluetooth. APK-only. See `docs/g1-protocol.md` for the wire protocol (NUS UUIDs, opcodes `0x4E` text / `0x15+0x20+0x16` BMP / `0x25` heartbeat / `0x0E` mic / `0xF5` touchbar / `0xF1` audio / `0x4B` notification).
- Dual-arm: every non-BMP command goes to L, waits for `0xC9` ack, then R. BMP upload fans out L+R in parallel.
- `GlassesService` — second Android foreground service (type `connectedDevice`), sibling to `PushService`. Lives in same process so they share memory via `GlassesState` singleton; communication is free.
- **Phone is single source of truth** for connection state. Hub RPCs the phone on demand; no constant state pushes.
- Hub exposes `/glasses/*` (dumb pipe: text, bmp, clear, notify, mic, status, disconnect, scan). Phone proxies each call to BLE. Pairing happens phone-side only; scanning can be triggered from the hub too (APK v6+).
- WS RPC framing on `/push` — `{type:'rpc_request',id,method,params}` hub→APK, `{type:'rpc_response',id,ok,result|error}` APK→hub, and unsolicited APK→hub streams: `glasses_state` (snapshot), `glasses_audio` (LC3 frames while mic is on), `glasses_touch` (touchbar events), `glasses_frame` (research-log raw frames, see below), `glasses_scan_observation` (every named BLE advert seen during a scan — diagnostic, regardless of G1 regex match). Hub side in `server/src/glasses-hub.ts`; APK side in `PushService.handleHubRpc` / `bleListener`.
- CLI: `con glasses {status,text,clear,bmp,notify,mic,disconnect,scan,research}` — see `cli/src/commands/glasses.ts`.
- **Scan diagnostics (APK v6+)**: `con glasses scan start` triggers a BLE scan phone-side; `con glasses scan observations` dumps the most recent named advertisements the APK saw — use this when the UI says "no glasses" to confirm whether the G1s are advertising at all or advertising under a different name. `BleManager.scanCallback.onScanFailed` surfaces scan errors to `GlassesState.lastError`. Scan observations also echo into `glasses-research.log` with `kind: 'scan_observation'`.
- SPA: `src/glasses/bridge.ts` wraps the `ConsoleNative` JS bridge, `src/glasses/store.ts` is the Zustand store, Settings UI is in `src/components/GlassesSettings.tsx`. All no-ops in the browser (only the APK exposes the bridge).
- **App-wide mirror** (`src/glasses/mirror.ts` + `src/glasses/panes/*.ts`): single "Mirror current tab" toggle in Glasses settings renders whichever pane is active (email, chat, agents, calendar, feeds, notes, bookmarks, money) onto the lenses at 5 rows × 40 cols — row 1 is a `Pane · focus · meta` status line, rows 2–5 are per-pane body. Per-pane renderer in `panes/<name>.ts` returns `{status, body}`; `mirror.ts` pads/clips and writes via `ConsoleNative.glassesSendText`. Notes renderer keeps the cursor-follow behaviour (cursor on row 3 or 4, `|` glyph at col, wrapped with line numbers) shrunk to 4 body rows. Chat/Agents reserve row 5 for a composer echo (`> …|`) fed by `useGlassesStore.composerText` — the uncontrolled textareas in `ChatComposeInput`/`AgentPromptInput` push on every keystroke so the lens reflects what the user is typing. 30 ms coalescing debounce, frames deduped against the last send. Persisted via localStorage (`console:glasses:mirrorEnabled`; legacy `console:glasses:notesMirrorEnabled` auto-migrates). Subscriptions for all eight panes + active-pane + composerText wired once in `wireMirror()` via `wireGlassesStore()`.
- **Mirror "stealth screen"** (APK v12+ under old name, v17+ as `setMirrorDim`): turning the mirror toggle on calls `ConsoleNative.setMirrorDim(true)` which holds `FLAG_KEEP_SCREEN_ON` and sets `screenBrightness = 0.01f`. The panel looks off but the Activity stays foreground so HW-keyboard keystrokes keep reaching the WebView. SPA falls back to the old `setNotesMirrorDim` name for v12..v16 installs. Re-applied on boot in `wireGlassesStore()` when the persisted toggle is on.
- GlassesService's ongoing notification updates with connection + battery (`GlassesState.addListener`); grouped with PushService's under `console.ongoing`.
- Mic → STT path: **touchbar long-press-right auto-arms the mic** (`server/src/glasses/touch-autowire.ts` subscribes `glassesHub.onTouch`; 0x17 → `setMic(true)`, 0x18 → `setMic(false)`). `POST /glasses/mic {active:true}` is the manual path. LC3 frames fan out over `WS /glasses/mic`. Decode to PCM is a consumer concern — see `docs/g1-mic-stt-recipe.md` for the three options (hub/APK/browser).
- **Offline audio buffering**: if the hub WS dies mid-utterance, `PushService.audioBuffer` (cap 3000 frames ≈ 60 s) holds LC3 frames and drains on reconnect. Touches/state not buffered (transient). Audio-only — drops from the front when full.
- **Reverse-engineering log**: the APK forwards every inbound BLE frame (classified by `BleManager.Listener.onFrame`, kinds: `audio|touch|heartbeat|ack|unhandled|battery|wear`) except audio (too noisy) and — unless verbose — heartbeats. Hub appends NDJSON to `~/.config/console/glasses-research.log` via `GlassesResearchLog` (rotates at 5K lines). Toggle with `con glasses research on|off`, tail with `con glasses research tail [N]`. Unknown opcodes get `unknown: true` for cheap jq filtering — still the path to filling remaining gaps in `docs/g1-protocol.md` §12.
- **Battery / wear / charging-case state** (cross-referenced against the MentraOS `G1.java` reference — see `docs/g1-protocol.md` §12 / §14 and `memory/project_g1_mentraos_reference.md`). Arm battery uses `0x2C 0x01` query / `0x2C 0x66 <pct>` reply, fired once on connect then every ~10 heartbeats (~80s) by `BleManager`. On-head detection is unsolicited `0x27 0x06` (worn) / `0x27 0x07` (removed). Charging-case state rides the same `0xF5` touchbar pipe: subcmd `0x0E` = `case-charging` (byte[2] 0/1), `0x0F` = `case-battery` (byte[2] 0..100), `0x06/0x07` = removed, `0x08` = opened, `0x0B` = closed. All three surface on `GlassesSnapshot` as `worn` / `caseBattery` / `caseCharging`.
- Future card-layer architecture + feature catalog (nav, teleprompter, Al voice loop, etc.) lives in `docs/g1-future-ideas.md`. V1 is intentionally dumb pipe.
- Prior standalone SSH-on-glasses experiment: see `docs/g1-ssh-client-recipe.md` (separate repo `~/proj/code/g1-term`, not ported).

## Keybindings
- **Global**: `Ctrl+Tab`/`Ctrl+Shift+Tab` = switch pane, `Tab` = next pane, `?` = help, `Shift+T` = dark mode
- **Mail/Chat**: `j/k` = navigate, `e` = archive/read, `b` = snooze, `r/R/f` = reply/all/forward, `c` = compose, `/` = search, `u` = undo
- **Calendar**: `h/l` = prev/next week, `t` = today, `w/d` = week/day view, `c` = create
- **Agents**: `y/n/a` = approve/deny/allow-all, `Enter` = focus prompt, `Esc` = interrupt
- **Notes**: vim mode in editor, `Ctrl+P` = find file, `Ctrl+S` = save, `:w/:q/:wq` ex commands

## Commands
- `pm2 start "npm run dev" --name console-dev` — dev server (Vite, HTTPS via Tailscale certs)
- `cd server && npm run dev` — hub server (port 9877, HTTPS when certs available)
- `con hub restart` — **canonical way** to restart the hub after `server/src/*` changes. Wraps `pm2 restart console-server`, waits for `/health` to come back, and nudges any agent sessions that were mid-turn with a "hub was restarted, continue" prompt (via `wasRunning` in the session manifest). Idle sessions resume silently.
- `npm test` / `cd server && npm test` — tests
- `npx tsc --noEmit` — type check SPA
- `cd server && npx tsc --noEmit` — type check server
- `cd cli && npx tsc --noEmit` — type check CLI

### Android APK
Requires Android SDK at `$ANDROID_HOME` (default `~/app/Android/Sdk`), minSdk 26, targetSdk 35. Applicationid `io.amar.console`.
- **Always build release, never debug.** Single-user software — the in-app updater (`/apk/latest.json`) only serves the release channel, debug builds can't auto-update, and there's no QA/staging lane that benefits from a separate debug variant.
- `android/scripts/generate-keystore.sh` — one-time, create `~/.config/console/console-release.jks` (back it up!)
- `android/scripts/build-release.sh` — build signed release, copy to `~/.config/console/apk/`, write `latest.json` (reads `~/.config/console/apk-release.env` for passwords). Phone picks up the update on next launch via the in-app banner.
- `android/scripts/build-debug.sh` exists but should not be used.
- The APK loads `https://amarhp-lin.rya-yo.ts.net:5173/` directly — HMR works. Tailscale must be up on the phone.
- Web side: `isNative()` (from `src/platform.ts`) detects `window.__isConsoleAPK`. Used by `src/gmail/auth.ts` (passes `?callback=app` so hub redirects OAuth to `console://auth/done`) and `src/main.tsx` (requests `navigator.storage.persist()`).
- Remote debugging: `chrome://inspect` on the laptop while phone is USB-connected (debug builds only; `setWebContentsDebuggingEnabled(BuildConfig.DEBUG)`). The embedded debug agent also works — APK events show in `/debug/log` with UA containing `ConsoleAPK/...`.
- Push notifications: `PushService` opens a persistent WebSocket to `/push` and posts system notifications even when the WebView is backgrounded. Server sources call `pushServer.broadcast({ type, title, body, pane, id, ...chatFields })`. Wired today: Monzo webhook (`money` channel), agent `AskUserQuestion` / `ExitPlanMode` (`agent` channel), Gmail new mail (`mail/sync.ts` — fires on `messagesAdded` deltas), Matrix room messages (`matrix/sync.ts` — see below), Calendar per-event reminders (`cal/sync.ts` — 30s ticker scans upcoming events, fires on `reminders.overrides` minutes-before-start with a 60s slack window, dedupes via persisted `fired` map). CLI/webhooks can emit via `POST /push/send`. Check connected clients: `curl -sk https://localhost:9877/push/status`.
  - Chat push specifics (`server/src/matrix/sync.ts`):
    - **Mute filtering**: skip rooms where the delta's `unread_notifications.notification_count === 0` (server-side push rules muted it) OR where the room is tagged `m.lowpriority` / `m.archive` with no highlight. Mirrors the browser's unread logic.
    - **Enrichment**: hub keeps an in-memory `roomState` cache (name, avatar mxc, members with displayname+avatar) + `directRooms` set (from global `m.direct` account_data), updated on every sync tick AND from the `snapshot` RPC. `PushMessage` carries `roomId`, `roomName`, `senderName`, `senderId`, `senderAvatarMxc`, `roomAvatarMxc`, `isDirect`, `timestamp`.
  - APK rendering (`PushService.kt`):
    - Chat notifications use `NotificationCompat.MessagingStyle` with `Person` + circular avatar (fetched once via hub's `/matrix/media/thumbnail/...` proxy, cached in-memory). History keeps the last 8 messages per room.
    - Grouping: `setGroup(CHAT_GROUP_KEY)` + a single summary notification (id 100). Per-room notifId is `roomId.hashCode()` so follow-up messages update the same card.
    - Vibration debounce: max one vibration per room per 60s — subsequent messages build with `setSilent(true)` + `setOnlyAlertOnce(true)`.
    - Deep link: `console://pane/chat?roomId=<id>`. `MainActivity.handleDeepLink` parses the query param and dispatches `console:navigate` with `{ pane, itemId }`; `src/notifications.ts` listens for that event and calls `handleNotificationClick` (same path as browser notifications), so tapping a chat notification lands in the right room.
- APK update check: runs once in `onCreate` (cold start) comparing `/apk/latest.json` versionCode against `BuildConfig.VERSION_CODE`. The refresh button in `src/components/Layout.tsx` also triggers a re-check by calling `window.ConsoleNative.checkForUpdate()` — bridge exposed via `addJavascriptInterface(ConsoleBridge(), "ConsoleNative")` in `MainActivity.buildWebView`. No-op in the browser. `updateBanner` tracked so repeated calls don't stack banners.

## Setup
1. Google Cloud project with Gmail + People + Calendar APIs enabled
2. OAuth 2.0 Web Application credentials
3. Add redirect URI: `http://localhost:9877/auth/google/callback` (+ Tailscale hostname variant)
4. `npm install && npm run dev`
5. Hub: `cd server && npm install && npm run dev`
6. Set Google credentials: `curl -X POST localhost:9877/auth/google/credentials -d '{"clientId":"...","clientSecret":"..."}'`
7. Sign in via the app UI

## Hub Routes
- `/auth/*` — OAuth flow, token endpoint, Matrix login
- `/mail/*` — Gmail proxy
- `/cal/*` — Calendar proxy (events, RSVP, location, accounts)
- `/matrix/*` — Matrix proxy
- `/money/*` — Monzo proxy + webhook
- `/bookmarks/*`, `/feeds/*`, `/notes/*` — CRUD
- `/debug/*` — Debug agent log, eval, state, screenshot, toggle
- `/apk/latest.json`, `/apk/console-<versionCode>.apk` — APK update channel served from `~/.config/console/apk/`
- `/push` (WebSocket), `POST /push/send`, `GET /push/status` — push notification channel consumed by the APK's PushService. Also carries glasses WS RPC framing (see Glasses section).
- `/glasses/*` — low-level dumb pipe proxied to the APK's GlassesService over the `/push` WS: `GET /status`, `POST /text`, `POST /bmp`, `POST /clear`, `POST /notify`, `POST /mic/start|stop`, `POST /scan`, `POST /pair`, `POST /disconnect`, `GET /events` (SSE).

## Known Issues
- Matrix E2EE: new device needs key backup restore (`POST /matrix/keys/restore-from-recovery-key`) before old messages decrypt
- Matrix E2EE: hub device must be cross-signed or Beeper bridges silently drop encrypted messages with `com.beeper.undecryptable_event`. Run `POST /matrix/keys/restore-cross-signing` after a hub re-login.
- `bootstrapCrossSigning(true)` overwrites server keys — always restore keys FIRST (the route above uses `reset:false`)
- WASM `UserId` objects consumed per call — create fresh instances each time

## Matrix recovery workflow (hub-side)
The old browser "Settings → recovery key" flow was dropped in the hub-centric migration. Hub-side replacements live in `server/src/matrix/backup-restore.ts` + `secret-storage.ts`, exposed as:
- `POST /matrix/keys/restore-from-recovery-key {recoveryKey}` — decodes an `EsU…` key; tries direct `BackupDecryptionKey` match first, then SSSS unlock. SSSS path iterates **every** keyId that encrypts `m.megolm_backup.v1` — users often have the current default SSSS key point somewhere new (e.g. `RII4BrO2Ox`) while the backup secret is still encrypted under the previous key (e.g. `bXFaNVGpGwtYSl7WxkfM2aznevIvcl3z`). Decrypts all sessions via `/room_keys/keys` and imports into OlmMachine (+ persists via `saveBackupDecryptionKey`).
- `POST /matrix/keys/restore-cross-signing {recoveryKey}` — decrypts the three cross-signing private secrets (`m.cross_signing.{master,self_signing,user_signing}`) from account_data, calls `importCrossSigningKeys` then `bootstrapCrossSigning(false)`, and explicitly sends the returned device-signature upload (bootstrap requests do NOT flow through `outgoingRequests()`). Required after any hub re-login — bridges reject Olm from uncross-signed devices. Beeper's current default SSSS key `RII4BrO2Ox` ships with **no `iv`/`mac` verification block**, so the helper skips `verifySsssKey` when those are absent and relies on the secret's own MAC to reject wrong keys.
- `POST /matrix/keys/import-local-backup` — force-imports the on-disk M0 key backup into the hub's current OlmMachine. Useful after hub migrates to a new deviceId and the legacy browser-exported keys never got merged.
- `POST /matrix/decrypt-event {roomId, eventId|event}` — fetches raw event from the homeserver (or takes it inline) and decrypts via the hub's OlmMachine. Used to resurrect "🔒 Encrypted message" placeholders that the browser persisted to IDB when the hub couldn't decrypt them at sync time.

Multiple rotations of the recovery key are fine — keep older keys handy because `tryKeyAgainstVersion` walks **all** backup versions and the SSSS loop walks **all** keyIds, so any historical key that unlocks any of them still restores. Beeper's recovery keys (`EsU…` prefix) are SSSS keys, not direct `BackupDecryptionKey` seeds. Cross-signing secrets are often encrypted under a **different** (newer) SSSS key than megolm backup — the two routes accept different recovery keys on the same account.
