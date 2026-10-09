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
- **An entry's lead-in is what Yousef reads on his phone.** The in-app "What's
  new" is derived, never hand-written: `scripts/changelog.py` takes each
  top-level entry's bold title (or, unbolded, the text up to the first
  parenthesis / sentence end) and `build-release.sh` embeds it in `latest.json`
  as `changelog`. So open every entry with a short bold title that states the
  change as he will see it ("Gmail labels show on Inbox mail rows"), not the
  bug ("labels were missing") and not a file name; card ids and backticks are
  stripped. The script prints the list before gradle starts — read it. Keep the
  order bump → build → roll: the build reads the block while it is still under
  "Built, awaiting release", and refuses if that block has entries but the
  vCode is already under Shipped.
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
    ui/nav/NavRequests.kt  one-shot screen-entry requests (command bar → a target with no route of its own:
                calendar day+event, feed scope, bookmark sheet, create forms); the screen takes it on entry
    ui/shell/   AppShell (NavHost, sync chip, UndoHost toast), GridScreen (launcher + app drawer; its search
                field IS the command bar — CommandBar.kt renders results, data/search/CommandBarLogic.kt ranks,
                every source Room/local so it works offline), Banners
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
- Agent transcript catch-up (`AgentsRepository.catchUpSession`) must reach
  the PRESENT, not advance by one page: follow `hasMore` (bounded), and when
  the gap exceeds the hub's 500-row window (`truncated`) jump to
  `since = totalLength − 200` — the skipped rows stay an `absIndex` hole that
  the transcript renders as a "Load N older" seam filled via
  `get_older_messages(beforeIndex)`. Rows from the hub carry their own
  `absIndex`; never derive positions from `minIndex` arithmetic (a mid-seam
  page would land below row 0). One page per `sessions_list` left every
  session on the phone ~300 rows behind a chatty fork (^prim-tern). The same
  catch-up is a SyncEngine domain (`reconcile()` over `/health`) so the
  background borrow keeps transcripts current — the agents WS is
  foreground-only. **`absIndex` is only meaningful under ONE hub counter**:
  `/clear` (from any client) resets `Session.logOffset` to 0, so a cached max
  above the hub's `messageLogLength` (+10 slack for the local echo/streaming
  rows) means the numbering restarted — drop the session's cache and re-catch
  up; a remote `/clear` `user_prompt` resets the same way (v104 looked
  "not working" on the phone because Console mobile had been `/clear`ed from
  the SPA and the phone kept the old rows on top).
- A `sessions_list` row is a whole-row Room upsert built from `SessionInfo`,
  which is a SUBSET of `AgentSessionRow` — `permissionMode` arrives only on
  `session_init`, `lastCachedIndex` is ours. `applySessionsList` inherits every
  such field from the row it replaces; defaulting them in `sessionRow` blanked
  the plan-mode badge 10 s after every `session_init`. Adding a column the hub
  does not ship in `SessionInfo` = add it to that carry-forward.
- Outbox results: `Done | Retry | Fail | Conflict | NotReady`. Transport-down is
  `NotReady` (row returns to pending, retry budget untouched) — treating it as
  `Retry` burned all 3 retries during reconnect storms and parked rows as
  terminal `failed` forever. `Outbox.retryOrNotReady(e, fallback)` classifies
  exceptions. `drain()` recovers rows leaked in `processing`. **Every terminal
  outcome (`Fail` AND an exhausted `Retry`) fires the `<type>:onFailed` hook**
  (since ^blue-bee — a 4xx used to park the row with the optimistic write
  standing). An optimistic Room-row write must carry its `before` in the
  payload and register an `:onFailed` that heals: chat rooms use
  `healRoomAfterFailedWrite` (force-applied full `chat-rooms` snapshot, else
  restore `before`) because the seq-based reconcile never sees a divergence
  the hub never saw. The first `reconcile()` per process and pull-to-refresh
  take the FULL rooms snapshot for the same reason.
- **A reconcile must not overwrite a row whose own edit is still queued.** A
  domain that writes optimistically and refetches the same rows from the hub
  will re-apply the pre-edit server copy for as long as the action sits in the
  outbox (seconds offline, longer on a flaky link) — the edit visibly reverts
  and then comes back. Skip those ids: `OutboxDao.inFlightEntityIds(type)` is
  the query (`money:override` is the precedent, ^warm-wren). And a DELETE-shaped
  action treats **404 as `Done`** — the thing it was told to remove is gone.
  Two corollaries, each found independently by ^loud-frog and ^busy-vole on the
  same night (so assume the next domain hits them too):
  - **The in-flight skip must exclude the row that just landed.** A handler
    normally refetches after its write, and it runs INSIDE the outbox, where
    its own row is still `processing` — so a naive "lay every queued edit back
    over the hub's reply" counts itself and keeps the optimistic row (local/temp
    id and all) on screen until some later reconcile. Pass the settling entity
    (`withInFlightLedgers(.., settled =)`) and drop its overlay, unless a LATER
    edit to it is still pending.
  - **The outbox `entityId` must be an identity that exists BEFORE the write
    lands.** A create has no hub id yet, so keying on the created row's id
    cannot match it on the way back: budgets key on the CATEGORY id (the hub's
    own upsert matches on that when no id is given), ledger entries on the
    ACCOUNT. Never send a `~`/`local_…` temp id as the hub's `id`, and deleting
    a never-synced row cancels its queued create rather than issuing a temp-id
    DELETE that 404s forever. Where the hub HONOURS a client-supplied `id`
    (finance categories + rules: `input.id ?? mint()`), mint a real one on the
    phone (`cat_<8hex>`) so the identity is final from the optimistic write and
    there is no temp-id swap at all; and because that hub upsert is
    `Object.assign(existing, input)`, an EDIT must send cleared optionals as
    `null` — omitting a field keeps the old value (^busy-goat; the SPA has that
    bug, its `undefined`s drop out of the JSON — don't port it).

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
  the desktop forever (calendars kept "un-showing"). Every consumer goes
  through `data/cal/CalVisibility.kt` `isCalendarShown` — the glasses mirror
  kept its own compound-key check for months after the screen was fixed.

**Calendar = what Google Calendar shows (^odd-bat)**
- Google OMITS `selected` from a CalendarListEntry when it is false, so
  `selected != false` shows every UNTICKED calendar — a colleague's whole
  calendar (Workspace-admin `owner` access) leaked onto the launcher tile.
  `isSelectedCalendar` (literal `true`) is the only gate; `reconcile()` keeps
  just those rows in `cal_list` and never caches another calendar's events.
  A detail-stripped event (no `summary` on a `reader`/`freeBusyReader`
  calendar) is titled "Busy" via `eventTitle`, never "(no title)". Twins: hub
  `server/src/cal/visibility.ts`, SPA `src/calendar/google-visibility.ts`.

**Boards / Spaces**
- Board reads via `GET /board/:project` (CardView incl. `nofork`/`model`,
  `defaultOwner`); ALL mutations via `POST /board/:project/{cards,move,assign,
  block,model,nofork,note,attach,edit,remove,redispatch}` (`attach` = base64
  image → the hub writes the asset AND the `![img](board/…)` line; never PUT
  the asset yourself). The hub's per-board write
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
- **Places autocomplete is billed per SESSION, so every surface owns its own
  token**: `data/gmaps/GmapsClient` is one stateless instance in `AppGraph`
  (Map + `CalendarRepository.places`), but each consumer holds its own
  `GmapsSession` — the token rides every keystroke of one run and
  `client.place()` rotates it, which is what ends the session. Sharing one
  token across two fields interleaves their runs into one bill. A new surface
  takes a `GmapsSession`, never the Map's (^busy-pony). No Maps key on the hub
  → `configured()` is false and the field stays plain, never an error.
- MapLibre Native's paint properties are not all data-driven the way GL JS's
  are: `line-dasharray` (and `line-pattern`, `fill-pattern`) take no
  per-feature expression natively. A `case`/`match` the SPA uses there must
  become filtered sibling layers on the phone (`geo-fences-line` solid +
  `geo-fences-line-unknown` dashed, ^wavy-newt).

**Theme (light + dark since ^plum-lark)**
- Never hardcode a status/link colour (`Color(0xFF4ADE80)` etc.) in `ui/` —
  the Tailwind-400s sit at ~2:1 on white. Use `MaterialTheme.accents`
  (`green/red/amber/violet/blue`, `ui/theme/Theme.kt`): dark = the 400s, light
  = the SPA's success/warning/destructive tokens. A file wanting a short name
  declares `private val GREEN: Color @Composable @ReadOnlyComposable get() =
  MaterialTheme.accents.green` — call sites read like a constant, but only
  inside composition (a `Canvas {}` draw lambda or `remember {}` body must
  hoist the value first). `MaterialTheme.isDark` for WebView CSS / basemap
  defaults; `Color.toCssHex()` for injected CSS. Theme mode lives in
  `core/AppPrefs` (device-local SharedPreferences, NOT a hub pref — the phone
  is read in sunlight); `hideLegacyTiles` is there too, mirroring the SPA's
  localStorage `console:ui:legacyTabs`. `themes.xml` stays dark: it can't see
  the in-app override, so the cold splash is dark and Compose repaints.

## Compose traps hit here

- A second `Text` in a `Row` beside a long one gets ~0 width and wraps one
  char per line into a tall blank column — put tags/suffixes INSIDE one
  `AnnotatedString`. (The "huge padding above edited messages" bug.)
- Collapse state that combines with a derived default must be a nullable
  override (`collapsed ?: allDone`), not `collapsed || allDone`.
- `AgentSessionScreen`'s outer `Column` does not scroll: anything mounted above
  the `weight(1f)` transcript (approval cards, hand-back strips) must cap its
  OWN height or it eats the transcript and pushes the composer off screen with
  nothing to scroll (^soft-orca: a 4-question AskUserQuestion). A `Column`
  measures non-weighted children with the REMAINING height, so a
  `BoxWithConstraints` there sees exactly the space left (IME-reduced via the
  screen's `imePadding()`) — cap against its `maxHeight`, not `screenHeightDp`.
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
- **Never `Regex.findAll` (or any per-match `Matcher`) over a layer-sized
  string.** Kotlin's `findAll` builds a new `Matcher` per match and Android's ICU
  copies the whole input into native memory each time — ~3,700 `_icon` matches
  over the 6 MB property layer was 21 s of main-thread CPU and a 1.8 GB RSS peak
  (v96–v98 Map ANR/crash). Use one `Pattern.matcher(s)` + `while (m.find())`
  (`countMatches`, `emojiInGeojson`). Same class: never build a kotlinx
  `JsonElement` tree of a layer string beside MapLibre's own parse.
- **`exits` is the crash tool**: `POST /debug/eval?target=apk -d '{"code":"exits"}'`
  returns Android's `ApplicationExitInfo` (Java crash, NATIVE crash + tombstone
  head, ANR + trace head, LMK). The in-app uncaught hook also persists the
  exception synchronously and replays it on the next connect. Use these before
  theorising — v96/v97 shipped two wrong "fixes" on a guess.
- `DateTimeFormatter.ofPattern("MMM", Locale.UK)` renders September as "Sept"
  (JDK 17+ CLDR en-GB); use `Locale.ENGLISH` for 3-letter months and keep
  day-before-month order in the pattern (`MoneyFormat.MONTH_LOCALE`).
- Screen-level filter/toggle state (source chip, Inbox|Feed, collapsed groups)
  is `rememberSaveable`, never `remember {}`: opening an item navigates to
  another route, the list screen leaves composition, and plain `remember` is
  rebuilt from defaults on back (^blue-pony, the Inbox chip reset; Feeds and
  LongTail screens already did it right).
- A `ModalBottomSheet` whose items dismiss it must never own the coroutine
  that does the work — the sheet leaves composition on tap and a
  `rememberCoroutineScope` inside it is cancelled with it. Take a
  `launch: (suspend () -> Unit) -> Unit` from the caller (Chat passes its screen
  scope, Inbox passes `repo.launch`) and hop to `Dispatchers.Main` for any
  toast (`ui/components/RoomContextSheet.kt`, ^pink-colt).
- `./gradlew … | grep … | tail` reports the PIPE's exit code, not gradle's — a
  "clean" compile in that shape was a missing `@OptIn`. Read the `e:` lines,
  use `set -o pipefail` / `${PIPESTATUS[0]}`, or judge the run from
  `app/build/test-results/testDebugUnitTest/TEST-*.xml` counts.

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
**`org.gradle.daemon=false` is set in `gradle.properties`** — the resident
daemon kept 3.6 GB (+1.6 GB Kotlin) after a release build on a host that runs
the whole fleet (Astera's RAM guard caught it at 0 GB free / 7 GB swap / load
25, 5 Oct 2026). If you ever start one by hand, `./gradlew --stop` may report
"1 Daemon stopped" and leave yours alive — check `ps` for `GradleDaemon` and
`KotlinCompileDaemon` (a separate process, never stopped by `--stop`) and kill
both by pid.
**The harness caps a background Bash command at 10 minutes, which is shorter
than a cold suite or release build** — those get killed mid-task with nothing
written. Launch them detached and poll the log:
`nohup setsid ../scripts/heavy.sh ./gradlew :app:testDebugUnitTest > /tmp/x.log 2>&1 < /dev/null & disown`.
A `:app:testDebugUnitTest FROM-CACHE` line is a PASS, not a skip: the cache key
is the inputs, so it restores the full `TEST-*.xml` set from a run with
identical sources — check the counts and mtimes rather than re-running.
**The forked test JVM's heap is pinned (`maxHeapSize = "3g"`, `forkEvery = 40`
in `testOptions.unitTests.all`) — never unpin it.** Without it the ceiling is
whatever the machine's default gives, so the same commit passed on forge
(64 GiB) and died on the desktop (23 GiB) the moment the suite reached 987
tests: eight `OutboxTest` cases failed with `OutOfMemoryError: Java heap space`
inside unrelated okhttp/conscrypt TLS setup, which reads as a logic regression
and is not one (8 Oct 2026 sweep — two forks had both reported green). Robolectric
keeps a sandbox + classloader per SDK/config combo for the JVM's life, so the
ceiling creeps up with every test class added; `forkEvery` is what caps the live
set. **An OOM lands on whichever class is running when the heap runs out, not on
the class that filled it** — a suddenly-failing cluster in a file nobody touched
is this, so read the exception before the diff. Corollary for the nightly sweep:
**a fork's green suite says nothing about the parent's** if they ran on different
machines; step 4 on the folded state is the only run that counts.
`SyncBusClientTest` (and `SyncEngineTest` "foreground call … never borrows",
^warm-kiwi) are known ordering flakes in the full run — re-run in isolation;
green there = fine. Headless `autowt cleanup` needs `--mode merged|all`; it can
leave an unregistered dir under `~/proj/code/console-worktrees/` — verify with
`git worktree list` before deleting.

Coroutine-test trap: `advanceUntilIdle()` stops as soon as no FOREGROUND task
is pending, so a debounced job launched in `backgroundScope` silently never
runs (`LiveBufferTest` read as "second post never happened"). Hand the unit
under test the `TestScope` itself (`this`), or drive time with `advanceTimeBy`.

## Board-driven work

Cards on `projects/console/board.md` assigned to `@new-mobile-app` (or forks of
it) dispatch as forks of this role. A card that touches contended files
(`ui/spaces/SpacesScreen.kt`, `BACKLOG.md`) must rebase onto main immediately
before folding; keep both intents on conflict. Forks never cut releases — the
parent reconciles all sibling cards, runs the FULL suite on the folded state,
restarts the hub if any fork touched `server/`, then cuts.

**A fork that ran on forge folds into FORGE's main, not the desktop's**, so
"commit X on main (pushed)" on a card can be true while this checkout has
nothing (8 and 9 Oct 2026, both nights). First step of every reconcile:
`git log <last release commit>..HEAD -- android/`. If the cards' commits are
missing, `git fetch forge`, then `git merge --ff-only forge/main`; when the
desktop has commits of its own as well (the usual case — someone committed
`server/` meanwhile) a plain `git merge forge/main` with a merge commit is
right. Never `git cherry-pick`: new SHAs leave the mirror's originals unmerged
and every later console prepare is rejected (the 8 Oct sweep did this and
blocked forge for 17 h). Afterwards `git push --dry-run forge main` must print
a fast-forward. Then re-check anything a fork says it built blind because a
hub commit was not on the box.

**On forge, this `android/` directory is the DESKTOP's, sshfs-mounted over the
box's clone** (because the session's cwd is mounted; measured 9 Oct 2026). Three
things follow until the hub stops doing that (console board card, `@console-general`):
`git status` in the box's `~/proj/code/console` shows dozens of phantom
"modified" files under `android/` — that is the desktop's tree against a stale
HEAD, not someone's uncommitted work (^jade-fox reported it as such); anything
written or any git command run there lands in the desktop's working tree, so
work ONLY in your own worktree; and the box's root `CLAUDE.md` is days stale
(its primary never fast-forwards), so trust this file over that one when they
disagree. Also on forge: `SyncBusClientTest` can fail in isolation too, not just
in the full run (^jade-fox, 8 Oct: 3 of 4 cases red on UNCHANGED main under CPU
contention) — compare against unchanged main on the same box before calling it
a regression.

## The Mobile agent and the nightly parity sweep

The durable session for this directory is **"Console mobile"** (agentKey
`new-mobile-app`, bound to project `console`, cwd = this `android/` dir since
2026-09-05 so this file loads natively). Cards on the console board assigned
`@new-mobile-app` dispatch as forks of it.

**Cron `gBQ18EE`** (hub scheduler, bound to that session's csid, `0 4 * * *` =
every night 04:00 local since 2026-09-19 — was weekly `tZZPux0`; guard
`~/exec/mobile-parity-guard.sh`) wakes the agent ONLY when there are hub/SPA
commits since the last sweep (Yousef: "nightly, but if there haven't been any
commits we silently ignore and don't fire a card"). `## Open` entries and
newly-Done cards are reported in the guard output for context but never wake
on their own — the Open list is rarely empty, so gating on it would fire every
night. A quiet night costs zero tokens. The woken PARENT runs the loop end to end: sweep →
group gaps into 3–6 self-contained board cards assigned to `@new-mobile-app`
(each dispatches as a fork of it, working in its own worktree) → reconcile the
folded state → full suite → cut the release (forks never cut; the parent
does — the shape that shipped v90). Inspect/retune with `con cron list | run
tZZPux0 | remove tZZPux0`; edit the guard file in place (registered as
`--guard "bash …"`, not `--guard-file`, so edits propagate). **The task can
vanish** — the original `KqtDQQU` disappeared from the scheduler between
2026-09-06 and 09-13 with no removal in the hub log (persisted-task count just
dropped across restarts), so a Sunday passed unswept. If `con cron list` has no
task on this session's csid with the parity guard, re-register: `con cron add
--session <this csid> --trigger "0 4 * * *" --guard "bash
/home/amar/exec/mobile-parity-guard.sh" --prompt "$(cat …)"` with the prompt
recovered from this session's transcript (`con agent read <s8> --grep "MOBILE
PARITY SWEEP"`), then fix the id here.

**The sweep (what each card's fork does; the parent does 1–2 for the whole
batch and 5 once everything is folded):**
1. Diff the SPA against the app since the last release: `git log
   --since=<last release date> -- src/ server/src/` for new user-facing
   features; the console board's Done cards for "Android parity not scoped" /
   "BACKLOG" mentions; the root `CLAUDE.md` feature sections vs the Kotlin
   surface under `app/src/main/kotlin/io/amar/console/{ui,data}`. Grep before
   listing anything as missing — a phone twin often already exists (the
   `baseMtime` conditional save sat in "Open" for weeks after it had shipped).
2. Each real gap → an `## Open` entry: SPA commit/section, what Android has,
   the phone equivalent in ≤3 lines. Inherently desktop-only things go in
   `## Desktop-only (considered, not gaps)`, once.
3. Implement the Open entries, highest daily-use first (Inbox → Spaces →
   Notes → Agents → Calendar → the rest), in an autowt worktree; commits land
   on `main`. Every pure-logic port gets a unit test.
4. `./gradlew :app:compileDebugKotlin` then `./gradlew :app:testDebugUnitTest`
   — both in a background task (cold runs are 10–18 min; never behind a shell
   `timeout`, which kills the run AFTER it wipes `build/test-results/`).
5. Release when anything user-visible shipped (bump + build + roll the
   backlog, per the working agreement above); a sweep card counts as Yousef's
   standing "cut" for its own batch. Then re-baseline the guard's state file
   (`~/.cache/mobile-parity-sweep.json` → current HEAD + Done-card count): the
   guard writes it at the START of a fire, so the sweep's own Done cards would
   otherwise wake the agent again the next night.
6. Hand back per the board contract: `note` bullets (gaps found / built /
   released / left Open and why), then `move … "Under Review"`. Write the note
   as `con spaces board console note "^id" "- bullets"` — a `--` separator
   before the text is a USAGE error, and the note silently never lands while
   the following `move` succeeds (five of six v95 forks hit this). **There is
   no emulator or KVM on this box** — UI screenshots come from Yousef's phone
   after it installs the release: `POST /debug/screenshot?target=apk` (see
   "Debug on the REAL device"). Say so on the card rather than skipping it.

If nothing changed and Open is empty, one bullet saying so is a valid hand-back.

**Since this went live, the phone counts as a `notes` SyncBus subscriber**:
`con notes open <path>` no longer 409s when only the app is connected — the
note opens on the phone (`NotesRepository.wireNotesEvents`). Room migrations
that rename/transform (not just add) use an `AutoMigrationSpec` —
`ConsoleDb.Migration13To14` is the pattern, with a `MigrationTest` seeding the
OLD table.

## Test-isolation gotchas
- **Repository-level Room flows must use `WhileSubscribed`, never `SharingStarted.Eagerly`** — an eagerly-collected Room StateFlow breaks Robolectric test isolation: Room silently reopens a closed DB on the next query, so one test class's corrupt-DB scenario leaks into later classes (found building the native Inbox, v91). **Same class: a repository `init {}` that launches a Room read** (a boot-time seed) — `AppLaunchTest`'s stranded-DB case closes the graph's DB, and the init coroutine reopening it made `CREATE TABLE` collide ("table already exists"). Seed on the flow's first subscription (`onStart`) instead (^dry-wolf).
- **MockWebServer in a repository test: serve responses by PATH, never FIFO `enqueue`.** `HubConfig` is process-wide and Robolectric boots the real `ConsoleApp`, so pointing the base at your server also points every background poller at it and a stray request eats your queued response (passes in isolation, fails in the full run). Use a `Dispatcher` that matches `request.path` and 404s the rest (`InboxRulesPersistenceTest`).
