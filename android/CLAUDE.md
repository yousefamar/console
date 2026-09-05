# Console Android app — charter for agents working under `android/`

This file is loaded whenever you touch anything under `android/`. It is the
mobile app's operating manual; the root `CLAUDE.md` covers the hub + SPA and
only points here. `BACKLOG.md` (beside this file) is the work ledger,
`FEATURES.md` the 1,321-entry SPA parity inventory.

## What this is

A **fully native Kotlin + Jetpack Compose** Android app (since v39, 2026-07-18;
replaced a WebView wrapper). Own codebase, boundary at the **hub API**
(`server/`), offline-first: open reliably offline → cached data; act offline →
durable outbox → flush on reconnect (the WhatsApp model). Also an optional
Android **launcher** (MAIN+HOME intent filter; the grid is the home screen).
Yousef daily-drives it — it replaces WhatsApp, Gmail and Calendar on his phone,
so regressions are felt within the hour.

## Working agreement (Yousef's, non-negotiable)

- **File → build → batch → ship on command.** Bugs/features are implemented and
  committed as they come into `BACKLOG.md` → "Built, awaiting release". A
  release is cut ONLY when Yousef says "ship"/"release"/"cut" (or when a card
  explicitly asks for one). Never rebuild the APK per item.
- **APK-only rule.** Hub/SPA changes deploy immediately (`con hub restart`,
  Vite HMR) — batching applies to the APK alone. A change touching both lands
  the hub part right away and the APK part in the batch.
- **Release = bump + build + roll the backlog:** edit `val vCode = N` in
  `app/build.gradle.kts` (versionName tracks it), run
  `./scripts/build-release.sh` (signs, copies to `~/.config/console/apk/`,
  rewrites `latest.json` → the in-app updater offers it), then move the "Built,
  awaiting release" block under a new `### vN (date)` heading in `BACKLOG.md`,
  commit, push. Every entry explains root cause, not just the symptom — the
  backlog IS the engineering log.
- **Ship whole scope.** Items you list for a batch all land in that batch.
- **`BACKLOG.md` is contended** — several sessions/forks edit it concurrently.
  Re-read before editing; anchored edits only; if your anchor fails, re-read (an
  entry may already be shipped or duplicated by a sibling).

## Repo map

```
android/
  app/build.gradle.kts            vCode/versionName, minSdk 26, targetSdk 35, applicationId io.amar.console
  scripts/build-release.sh        signed release → ~/.config/console/apk/ + latest.json (the update channel)
  scripts/build-debug.sh          debug APK (applicationId suffix .debug — coexists with prod)
  app/src/main/kotlin/io/amar/console/
    ConsoleApp.kt                 Application; builds di/AppGraph (manual DI — no Hilt)
    MainActivity.kt               Compose host, deep links (console://…), launcher HOME handling, share target
    PushService.kt                foreground service: /push WS → system notifications, PTT, background-sync kicks
    HubTokenStore.kt              bearer (EncryptedSharedPreferences; plain prefs fallback in JVM tests)
    BootReceiver.kt / NotificationActionReceiver.kt
    core/       HubConfig (endpoints, NO hardcoded URLs), HubClient (bearer REST), HubPrefs (/config mirror),
                AppLifecycle (foreground signal), Connectivity, Dictation (/stt WS), DebugAgent, Updater,
                DraftStore, InstalledApps (launcher app registry), OngoingNotif
    sync/       SyncBusClient (port of src/sync-bus.ts), Reconciler (debounced single-flight),
                SyncEngine (foreground WS lifecycle + background borrow), SyncWorker/PruneWorker (WorkManager),
                outbox/ (Room-backed durable mutation queue + OutboxWorker)
    data/db/    Room `console.db` — entities + DAOs (schemas exported to app/schemas/; MigrationTest replays them)
    data/<domain>/  one repository per domain: chat (Matrix via hub, E2EE media), mail, agents, spaces
                (boards via hub BoardOps), notes (+blog), cal (+flights), feeds, inbox, longtail (map/home/…)
    ui/nav/AppNav.kt   Pane enum + route contract: grid (L0) → app root (L1) → detail (L2)
    ui/shell/   AppShell (NavHost, sync chip, UndoHost toast), GridScreen (launcher + app drawer), Banners
    ui/components/  Composer (all free-text input; dictation), DictatedTextField, HtmlWebView, NetworkIcons…
    ui/<domain>/    screens per pane (spaces/ is the eventual Notes+Agents replacement — see below)
    glasses/, glasses/mirror/, pen/   G1 glasses + Neo pen BLE stacks (pure codecs unit-tested)
  app/src/test/   Robolectric JVM tests (~56 files): outbox/reconciler/WS semantics, DAOs, codecs, parity helpers
```

Build + test from `android/`: `./gradlew :app:compileDebugKotlin` (fast check),
`./gradlew :app:testDebugUnitTest` (full suite, ~1–3 min warm). Run heavy
gradle in a background task and wait for the notification rather than polling.

## Debug on the REAL device — don't guess

The hub's debug agent reaches the running APK. Every hard bug this codebase has
had was root-caused from live device SQL, not from reading code:

```bash
TOKEN=$(jq -r .cli ~/.config/console/local-tokens.json)
curl -sk -H "Authorization: Bearer $TOKEN" -X POST "https://localhost:9877/debug/eval?target=apk" \
  -H 'Content-Type: application/json' -d '{"code":"sql SELECT … FROM chat_messages …"}'   # SELECT/PRAGMA only
#  other commands: state | route | nav <route> | back | reconcile | drain | help
curl -sk -H "Authorization: Bearer $TOKEN" -X POST "https://localhost:9877/debug/screenshot?target=apk" -d '{}'
#  → {"path": …png}; fails "no backing surface" when the screen is off
```

`?target=apk` is mandatory — untargeted evals hit the desktop browser. The
APK's console/network log is visible via `/debug/log`. The sync WS only lives
while the app is foregrounded (plus short background borrows), so a remote
`reconcile` on a backgrounded phone is a no-op — check `state` first.

## Architecture rules that have bitten us (each one is a shipped fix)

**Sync / cursors**
- Matrix live deltas must NOT advance the `matrix:lastBatch` resume cursor
  until this connection's `matrix.resume` has completed (broadcasts are
  fire-and-forget; resume is the only gap recovery). A cursor'd resume that
  fails falls back to a fresh initial sync (bounded) — otherwise every retry
  faces the same ever-growing gap and chats freeze while previews stay fresh.
- Hub side bounds the resume backfill walk (6 workers, 20 s budget). Unbounded
  fan-out once starved the hub event loop so hard `/health` stopped answering.
- Outbox results: `Done | Retry | Fail | Conflict | NotReady`. Transport-down is
  `NotReady` (row returns to pending, retry budget untouched) — treating it as
  `Retry` burned all 3 retries during reconnect storms and parked rows as
  terminal `failed` forever. `Outbox.retryOrNotReady(e, fallback)` classifies
  exceptions. `drain()` recovers rows leaked in `processing`.

**Coroutine cancellation (three separate incidents)**
- Never let a debounce cancel the job the WORK runs inside. `trigger()`
  cancelling the running pass killed it mid-flight, and a suspending
  `mutex.withLock` in `finally` throws in a cancelled coroutine → leaked
  `running=true`/`syncing=true` forever (perma-"Syncing", dead reconciler,
  wedged outbox). Pattern: detach the work (`scope.launch { run() }` inside the
  debounce) and do cleanup under `withContext(NonCancellable)`.

**WebSockets (two clients: SyncBusClient `/sync`, AgentsRepository `/agents`)**
- Generation counter on every (re)connect; callbacks from stale generations are
  ignored; `open()` cancels any prior socket; `stop()` bumps the generation
  (orphaning callbacks) and clears transient UI state (approvals) itself — the
  orphaned `onClosed` no longer will. Two live sockets feeding one delta buffer
  = every streamed chunk doubled.
- `start()` must self-heal: want-connected but not connected → cancel stale
  reconnect job, reset backoff, reopen. A plain `if (wantConnected) return`
  left the app "hub disconnected" until a force-stop after a hub restart raced
  a background flip.
- Agent transcripts are indexed by hub `absIndex` (stamped in
  `Session.logMessage` BEFORE broadcast) and upserted, never appended — the
  transcript-duplication class. Local user_prompt echoes carry `localEcho:true`
  and are reaped when the authoritative copy lands.

**STT relay (`/stt` WS) semantics**
- A `final` arrives per ~600 ms-pause commit and carries only ITS segment:
  append it, clearing only that segment's interims. Only the single post-stop
  final is whole-turn. Send `{type:'done'}` on stop and poll for the last final
  (≤5 s) instead of a fixed grace. Resetting the whole buffer on a mid-stream
  final made every pause erase all prior speech.

**Cross-device prefs**
- Keys must match the SPA's format EXACTLY (`calendar.visibleIds` = bare
  calendarIds, not `account:calendarId`). A mismatched shape silently fights
  the desktop forever (calendars kept "un-showing").

**Boards / Spaces**
- Board reads via `GET /board/:project` (CardView incl. `nofork`/`model`,
  `defaultOwner`); ALL mutations via `POST /board/:project/{cards,move,assign,
  block,model,nofork,note,edit,remove,redispatch}`. The hub's per-board write
  queue serializes Obsidian/agents/SPA/APK. **Never write board markdown**
  through `/notes/file/` (creating a NEW board from the template is the one
  sanctioned exception). Cards address by `^id`, falling back to exact text.
  `^blockid`s are hub-stamped dispatch markers — never touch client-side.
  `data/spaces/KanbanBoard.kt` survives for `isKanbanBoard` + column regexes;
  its tests document the file grammar.
- SyncBus `boards` events (`changed`/`transition`) refresh the open board AND
  the spaces list (debounced) — the SPA doesn't subscribe yet.
- Sessions↔spaces join is client-side: role frontmatter `project:`/`areas:`
  (from `agents_list`) matched by `session.agentKey`. Per-ticket forks are
  keyed `<source>-<blockId>-fork`; `AgentLabels.kt` resolves labels and roots.

**Parity discipline**
- Every SPA agent-protocol message / hub route / `SessionInfo` field needs its
  APK twin in `AgentsRepository` (ephemeral broadcasts like `session_todos` AND
  the authoritative field in `sessions_list`). When porting SPA logic, port the
  pure helpers verbatim with tests (`CardContent.kt`, `ChatFormat.wordDiff`,
  `Frontmatter.kt`, `AgentLabels.kt` are the precedents).
- Same wire shape ≠ same rendering: check `ui/<domain>/*.kt`, not just the
  React component — e.g. map features live in `MapScreen.kt`/`MapRenderer.kt`.

## Compose traps hit here

- A second `Text` in a `Row` beside a long one gets ~0 width and wraps one
  char per line into a tall blank column — put tags/suffixes INSIDE one
  `AnnotatedString`. (The "huge padding above edited messages" bug.)
- Collapse state that combines with a derived default must be a nullable
  override (`collapsed ?: allDone`), not `collapsed || allDone`.
- Externally-grown text (dictation) needs `TextFieldValue` with the selection
  pinned to the end, or the caret strands mid-text.
- `AnnotatedString.fromHtml` only links real `<a>`; bridges send bare-URL
  `formatted_body` → run a linkify post-pass. Coil has no data-URI fetcher
  (decode base64 yourself) and needs an animated decoder registered for GIF/WebP.
- Overlays (sync chip, toasts) live in the shell `Box` after the NavHost so
  they never reflow content; the toast is ONE shared pill (`UndoHost`).
- Kotlin block comments NEST — `/*` inside a KDoc (e.g. `#model/*`) opens an
  unclosed comment with a misleading error two functions later. `\d` in a
  Kotlin string literal must be `\\d`.
- `Icons.Outlined.*` imports are explicit per icon (no wildcard) — add the
  import or you get "Unresolved reference".

## Launcher-mode specifics

`MainActivity` receives MAIN+HOME on every Home press. Coming FROM another app
(activity was stopped) → restore place, no pop; Home pressed while already in
Console → pop to the grid with `saveState`. `android:stateNotNeeded="true"`.
Proximity wake lock for earpiece playback is held only while the sensor says
near (holding it for the whole playback blanked the screen).

## Gradle contention (parallel forks)

Six parallel forks sharing one gradle cache produced 15–30 min builds, phantom
`CompilationException`/IR-lowering crashes and OOMs. If a compile error looks
impossible: `./gradlew --stop`, retry once; for real OOM
`GRADLE_OPTS="-Dorg.gradle.jvmargs=-Xmx4096m" ./gradlew … --no-daemon`.
`SyncBusClientTest` is a known flake in the full run — re-run in isolation;
green there = fine. Headless `autowt cleanup` needs `--mode merged|all`; it can
leave an unregistered dir under `~/proj/code/console-worktrees/` — verify with
`git worktree list` before deleting.

## Board-driven work

Cards on `projects/console/board.md` assigned to `@new-mobile-app` (or forks of
it) dispatch as forks of this role. A card that touches contended files
(`ui/spaces/SpacesScreen.kt`, `BACKLOG.md`) must rebase onto main immediately
before folding; keep both intents on conflict. Forks never cut releases — the
parent reconciles all sibling cards, runs the FULL suite on the folded state,
restarts the hub if any fork touched `server/`, then cuts.
