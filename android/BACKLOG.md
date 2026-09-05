# Android app backlog

Working agreement: Yousef files singular bugs/features here (via any Claude session);
they get implemented + committed as they come, but a **release is cut only when
there's significant meat** — no rebuild per item. Committed-but-unreleased work sits
in "Built, awaiting release" until a version ships, then moves under that release.

## Open (not yet built)

Each entry = the gap + the phone equivalent. Filed by the weekly parity sweep
(`android/CLAUDE.md` → "Weekly parity sweep") or by SPA forks as they ship.

- Money pane — SPA mobile bottom bar includes Money (Cashflow / Net worth /
  Budgets / Scenarios / Transactions; `src/components/money/*`, hub `/money/*`).
  Android `AppNav.kt` marks it out of scope and `money` pushes land on Home.
  Plan: a Money tile → RunwayCard + net-worth line + recent transactions list
  (read-only first; budgets/scenarios later), `data/money/MoneyRepository`
  mirroring `/money/summary` + `/money/transactions` into Room.

- Home: Costs sub-tab — SPA `CostsCard.tsx` (`GET /dashboard/costs`, per-day
  stacked bars by person + $/day). Android `HomeSubTab` = Alerts/Servers/Blog/
  Canvas. Plan: fifth sub-tab, Compose Canvas bars, same endpoint.

- Map: Google Maps place search + "Open in Google Maps" — SPA `GmapsPanel`/
  `PlaceDetailPanel` over hub `/gmaps/*`. Android `MapScreen.kt` has no gmaps
  at all (the mobile ask in root CLAUDE.md is exactly this). Plan: search box
  → `/gmaps/autocomplete` → pin + detail sheet → `geo:` deep link.

- Feeds: Reddit comments — SPA `RedditComments` via `/feeds/reddit-comments`;
  Android renders the HN tree only (`FeedsLogic.kt`). Plan: flat comment list
  under Reddit items, same endpoint, reuse the HN row.

- Spaces: area contents = tagged-post history + New post (SPA ^loud-colt
  `AreaDevlog`, `GET /blog/area/:slug/posts`, `createDraft({area})`). Android
  `SpaceDetailScreen` gives areas only Agents. Plan: a Devlog tab for areas
  (posts + drafts + New-post FAB seeding `tags: [<area>]`).

- Spaces: project devlog strip + New post in Docs (SPA ^prim-moth/^bold-hawk:
  drafts then `postsByProject` above the tree). Android `SpaceDocsList` is a
  flat path-prefix list, `log/<ts>.md` posts absent. Plan: Drafts/Posts
  section above the tree + New post → `createDraft(project)`.

- Spaces: quick switcher (SPA `SpacesQuickSwitcher.tsx`, `/`) — Android has
  none (Notes has one). Plan: top-bar search over spaces + live sessions.

- Inbox: routing-override management (SPA `RouteOverrides`, InboxTab.tsx:517
  — clearable per source). Android has only the per-row `→ feed/→ inbox`
  toggle. Plan: "Routing rules" sheet from the top bar, ✕ per override,
  writes `/inbox/rules`.

- Notes: live-buffer mirror (SPA ^tame-hare posts the active buffer to
  `POST /notes/live` so the Curator's `con notes live` sees it). Android:
  none — the Curator is blind to phone drafts. Plan: debounced POST from
  `NoteEditor` while a writing file is active (path, content, cursor line).

- Agents: "Allow all <tool>" on the approval card (SPA `AgentToolApproval`);
  Android `ApprovalCard.kt` is Approve/Deny only. Low — tools auto-approve.

- Theme: light mode — SPA Shift+T; Android `Theme.kt` is dark-only (map has
  its own light toggle). Plan: follow the system theme.

- Grid: `legacyTabs` hide pref — SPA hides Mail/Chat/Feeds/Notes tabs once
  the Inbox/Spaces absorb them; Android grid always shows the tiles. Plan:
  read the hub pref and hide those tiles when set.

## Desktop-only (considered, not gaps)

Inbox day rail · every keybinding (j/k/e/b/p, y/n/a, Ctrl+H/L focus cycling,
Ctrl+Tab) · CodeMirror features (live table preview, vim `:e`/`:e!`, inline
wiki-link widgets, word-diff AI review — the phone shows a Reload/Keep banner
instead) · drag-to-Done track / drag between columns (swipe + sheet exist) ·
hover copy/read-aloud cluster (long-press exists) · `~vault` pseudo-space (the
Notes app covers it) · multi-tab strip vs single-buffer Docs · three-pane
layouts / rail geometry · Home canvas iframe sandbox (WebView already) ·
AccountModal cross-origin IndexedDB migration + APK pairing QR · desktop
notifications · YouTube inline-vs-PiP · global `SearchOverlay` (per-pane search
exists) · Music drawer-from-any-pane (tile instead) · per-space remembered
view (the phone's Board > Agents > Docs landing is deliberate) · Notes tabs /
view-mode hub-sync (Room meta is fine on one device).

## Built, awaiting release

(empty)

## Shipped

### v93 (2026-09-05)
- **Mobile parity sweep batch** (^neat-toad, 2026-09-05 — a deep SPA-vs-app
  audit; the leftovers are the Open entries above):
  - Inbox: snooze ANY source via the shared `SnoozeSheet` (agents included;
    mail/chat on the hub, feed/agent locally by item key — Room v14
    `item_snooze` replaces `feed_snooze`, rows migrated as `feed:<id>`), 5 s
    undo on every done/snooze (via UndoHost — swipe-done had none), "N
    snoozed" Clock toggle listing everything snoozed soonest-due first
    (swipe right = unsnooze), source chips on the Inbox list, platform chips +
    glyphs + 16:9 thumbnails on the Feed list (`FeedKind.kt` port of
    `src/feeds/feed-kind.ts`; `FeedRow.imageUrl` for plain-RSS favicons),
    ClipboardCheck glyph on rows whose `@key` owns an Under Review card.
  - Agent session: "Under review · project · text · Approve → Done" strip per
    owned review card (`reviewHandbacksFor` port; `SpacesRepository.reviewCards`
    /`doneColumn` from `/blog/spaces`, `moveCardByQuery`).
  - Spaces: Curator hoisted above AREAS (lineage-based, its forks nest under
    it, skipped from area badges — ^tame-hare/^zany-kiwi); `~unassigned`
    pseudo-space under EVERYTHING ELSE for live sessions with no binding (they
    had NO surface since the Agents tile died); area/project draft rows +
    FileText count badge (amber unsaved beats blue draft — ^tidy-swan/
    ^sly-deer); `+ New project` on the PROJECTS header (^pale-otter); rail
    badge order kanban-left-of-Bot with amber = working (^blue-eel); card
    assignee chip coloured by the session's state (^plum-ibis); crowned-Bot
    owner glyph in the row's state colour replaces ★ (^shy-ibis); "Relocate to
    <space cwd>" in the session sheet for strays (^spry-seal); card image thumbs
    open a shared `ImageLightbox` with ‹ › paging (^spry-koi).
  - Notes: "Changed on disk / Edited by an agent — Reload | Keep" banner when
    the file under an open buffer moves (subscribes SyncBus `notes.file_changed`
    + `agent_edit`; the phone twin of the SPA's inline review — ^wavy-yak/
    ^spry-fox); dirty buffers mirrored to Room meta and restored on open so
    typing survives process death (^red-ibis); `con notes open` opens the note
    on the phone too (`notes.open_file`). The `baseMtime` conditional save +
    409 conflict banner turned out to be ALREADY built — entry retired.
  - Agents: transcript `![alt](/abs/path.png)` renders via the hub media
    bridge (`/agents/local-file`, tap → lightbox gallery); ```html fences are
    a collapsed card with Render (JS-enabled WebView, no base URL) / Source;
    long-press Send queues the prompt for the end of the turn
    (`queue_message`), a chip above the composer shows/edits/cancels it
    (`session_queued` + `SessionInfo.queuedMessage`).
  - Calendar: **bug** — "Add account" omitted `add=1`, so Google silently
    re-linked the signed-in account instead of adding one; recurring delete
    offers This / This-and-following / All (`calDeleteFollowing` outbox action:
    master delete or RRULE `UNTIL` truncation, `truncateRecurrence` port);
    declined events render struck-through at 45 % alpha in both grids.
  - Feeds: hidden-folder (X) items no longer leak into the legacy Feeds "All"
    scope or the grid tile count.

- **Fix: new space agents landed in the hub's cwd; strays now flagged**
  (3716ec9e, ^spry-seal): `NewSpaceAgentSheet` defaulted cwd to a hardcoded
  `/home/amar`, and the NoteEditor/ProjectPanel "start agent" paths built
  `$vault/projects/<slug>` without binding the session to the project. All
  three now send no cwd (blank field = hub default: the vault project dir /
  vault root) and create keyed + project-bound; the sheet prefills from the
  space's new `/blog/spaces` `cwd` field. `AgentsRepository.createSession`
  takes `cwd: String?` and omits it when blank. `SpaceSummary.cwd` parsed
  (null on an older hub). Not yet ported: the SPA's amber stray glyph on
  agent rows + cwd in the session status bar.

### v92 (2026-09-04)
- **Approval card: dictate the answer** (89f49d96, ^lime-newt): the
  AskUserQuestion "Other…" field and the plan-review comment field are
  `DictatedTextField`s (`ui/components/`) — a mic per field, live transcript
  in the field, commit on stop. Dictations are OWNED (`Dictation.start(owner)`,
  `Commit.owner`): the on-screen Composer ignores owned commits and shows a
  plain Mic, so a dictated answer never also lands in the composer draft;
  tapping either mic takes the mic over from the other. SPA parity in the
  same commit.

- **Inbox: a swipe whose action doesn't drop the row snaps back** (5805b3f1,
  ^quick-ram): rows swiped "done" froze on the Done hint — they were READ
  overdue DMs, so mark-read was a no-op and the entry never left the derived
  list while `SwipeToDismissBox` sat dismissed. `InboxScreen` now resets the
  swipe state if the row is still composed 1.5 s after a confirmed swipe (a
  no-op action reads as a bounce). The semantic half is ^neat-bass below.

- **Inbox: overdue only escalates UNREAD chats** (^neat-bass): `isOverdue` in
  `InboxLogic.kt` now requires `isUnread || manualUnread`, and `roomIsLive`
  lost its overdue re-admission — a READ-but-unanswered DM no longer
  reappears in the Inbox as overdue (Yousef: read = "seen, chose not to
  reply"). SPA parity in the same commit.

- **AL rename** (^green-seal): user-facing strings say "AL" (Release mic to
  AL, Message AL…, AL suggests you talk to…). The `isAl`/`id == "al"`
  identity checks are slug-based and unchanged; the hub now names the session
  `AL` so anything showing `session.name` follows automatically.

- **Inbox: agent ordering tiers** (^lean-deer, SPA parity): `InboxLogic.kt`
  bands agents attention → review hand-back (turn ended + `agentKey` owns an
  Under Review card) → chat+mail → finished-unread → still-running-unread.
  `InboxRepository` gains a `reviewKeysFlow` (AppGraph maps
  `SpacesRepository.spaces` → union of `reviewAgentKeys`).

- **Inbox grid tile: red attention dot** (^blue-wren): the Inbox tile now
  shows the same red dot as Spaces when an attention-flagged agent session
  sits in the inbox list (`inboxLists.inbox.any { it.attention }`); the tile
  only had the count pill before.

- **Session sheet: "Set/Unset as project owner"** (^lime-dove): long-press a
  session in a PROJECT space's Agents list → toggles the board's frontmatter
  `default_owner:` via `POST /board/:project/owner` (`SpacesRepository.
  setDefaultOwner`); the existing ★ default-agent marker flips on the board
  reload. Hidden for area spaces and keyless sessions (SPA parity).

- **Fleet model picker: add Fable 5.1** (^rosy-deer): `AgentDialogs.kt`
  `FIRST_PARTY`/`BEDROCK` picker lists gained `claude-fable-5-1` /
  `us.anthropic.claude-fable-5-1` (after opus-5, before fable-5), matching the
  SPA `SpacesFleetMenu.tsx` lists and the hub chains. `shortModel` needs no
  change (strips ARN/`us.anthropic.` prefixes only; the bare id renders fine).

### v91 (2026-09-01)
- **Unified Inbox app** (^cool-tern): native twin of the SPA's Inbox pane in
  its mobile mode — new grid tile (badge = inbox count, SPA tab-badge parity),
  Inbox|Feed segmented lists, tap opens the source's existing detail screen
  (chat/mail/feeds/agents — viewers reused, not rebuilt), swipe right = done,
  swipe left = snooze-until-tomorrow (agents excluded), per-row promote/demote
  writing hub `/inbox/rules` (shared with the SPA), X-only feed mode, SLA
  overdue chip (timestamps parsed from the room rawJson — no chat migration).
  Pure logic in `data/inbox/InboxLogic.kt` (port of src/inbox/route.ts, 10
  unit tests); composition over existing Room tables in `InboxRepository`
  (WhileSubscribed — an eager Room collector breaks Robolectric test
  isolation). Room v13: agent_sessions gains lastActivityAt/lastTextSnippet
  (hub SessionInfo fields), new feed_snooze table (local-only, SPA Dexie
  parity); v12-replay migration test added.

- **Fix: project-homed posts not recognised as published** (9ed3e6c):
  `isPublishedPath`/`permalinkForLogPath` in Frontmatter.kt only matched
  `log/<name>.md`, missing `projects/<slug>/log/<name>.md` (a divergence from
  the TS port) — project posts got no writing chrome and no permalink.

- **Frontmatter: YAML-escape stamped values** (^gold-swan): `Frontmatter.kt`
  gained `yamlScalar()` / `unquote()` — a title with a colon (`Foo: bar`) was
  written as a plain scalar, which is a hard YAML parse error and fails the
  Eleventy build for that post; also fixes silent coercion (`2026` → number,
  `true` → bool, `a #b` → truncated, ` padded ` → trimmed). `unquote()` only
  strips a MATCHED quote pair, so `Bruteforcing tailnet "fun names"` keeps its
  trailing quote (the old `trim('"','\'')` ate it). Parse no longer bool-coerces
  a *quoted* value, and a quoted `tags:` scalar is one tag. Kept in sync with
  `server/src/blog.ts` + `src/utils/frontmatter.ts`. 5 new unit tests.

- **Basemap: CARTO → OpenFreeMap** (^zany-koi): CARTO's raster CDN now
  requires an API key (watermarked without) — `cartoStyleJson()` replaced by
  `basemapStyleUrl(dark)` returning OFM style URLs
  (`tiles.openfreemap.org/styles/{dark,positron}`, keyless, no-limits),
  loaded via `Style.Builder().fromUri(...)`. Existing light/dark toggle and
  renderer re-attach flow unchanged; OFM styles ship their own Noto Sans
  glyphs so agent-layer labels keep rendering.

### v90 (2026-08-31)
- Board assignee filter groups by ROOT agent (^ripe-heron): filter chips per
  distinct root (SPA rootOf — live parentClaudeSessionId lineage walk; dead
  fork keys peel -fork suffix then trailing segments), labelled by live
  session name; per-ticket forks collapse under their source so chips stay
  meaningful. Cards stay ^id/text-addressed (filtering can't corrupt refs).
  Space Agents rows gain the grey cron badge (active tasks via GET
  /cron?session=). Default agent per space (SPA selectDefaultAgent): board
  default_owner → single bound non-fork → 'general' suffix → first-by-key,
  starred+bold in the Agents tab; hub BoardOps view() now exposes
  defaultOwner. +RootOfTest (lineage, dead-key peel, resolution order).

- Card sheet dispatch controls (^glad-hare): assignee meta chip is tappable —
  opens the assignee's live session (SPA openAssigneeSession; assign stays a
  separate section). New pills: nofork toggle (POST /board/:p/nofork — wake
  the role directly, no per-ticket fork), model pin haiku/sonnet/opus (POST
  /board/:p/model), and ↻ redispatch for stamped cards (POST /board/:p/
  redispatch — re-fire a dead/lost dispatch). Hub-side: BoardOps CardView/
  view() now serve nofork+model (they were parse-only — the SPA benefits
  too); all 6 inline CardView literals patched, 37 kanban tests green.

- Board card content richness (^prim-elk): image detail lines (`![img](…)`)
  render as thumbs — 48dp on the chip, 96dp scrollable in the sheet — via
  GET /notes/asset/<path> (Coil's global loader injects the bearer), and are
  stripped from the visible detail text; URLs (markdown label wins, bare URLs
  label by hostname, trailing punctuation stripped, deduped) render as
  tappable chips opening the browser; trailing `#tag` runs split off the
  title as badges. data/spaces/CardContent.kt = verbatim port of the SPA's
  cardUrls/cardImagePaths/splitTrailingTags (+5 unit tests). GOTCHA hit:
  Kotlin block comments NEST — `/*` inside a KDoc (e.g. "#model/*") opens an
  unclosed comment.

- Spaces P2 polish (^green-kite): DictatedTextField — mic (icon-only) in the
  add-card and new edit-card sheets via the shared Dictation infra, live
  transcript appended while speaking (merged with ^loud-duck's retry/busy
  state); card Edit in the sheet (line 1 = text, rest = detail, BoardOps
  edit verb); "Create board" for board-less projects (byte-identical SPA
  template via /notes/file PUT — the sanctioned new-file path); session_merged
  now reaps the fork's Room rows + todos/activity immediately instead of
  waiting for the next sessions_list; agentLabel/rootAgentKey helpers
  (data/spaces/AgentLabels.kt) — dead fork keys resolve to the root key's
  live session label on card chips + sheets (SPA labelFor parity).

- Spaces L1 alert rows as a lineage TREE + card-fork suppression + live review
  badges (^deft-mole): alerted sessions pull their ancestor chain in as
  neutral "context" rows so forks nest under parents (SPA ^of1op4); a fork
  whose @key is in the space's cardAgentKeys (new /blog/spaces field, safe
  default) is suppressed from alert rows unless needs-attention (SPA
  ^lean-ibis — its card is the affordance; the review hand-back kanban tint
  from ^teal-finch still applies); ANY boards SyncBus event refreshes the
  spaces list (1s debounce) and a WS reconnect re-reads spaces + the open
  board, so review badges track live instead of going stale.

- Board QoL (^loud-duck): swipe-right on a card = mark Done (mobile analogue
  of the SPA's drag-to-Done mini track; green check reveals, fires once past
  threshold — the Done column stays hidden from the pager). Add-card: the
  hub top-inserts (no local append assumption existed); addCard retries once
  on failure and on a double failure the sheet STAYS OPEN with the typed
  text intact ("Retry" button) — a transient hub error never eats a dictated
  card. Board mutation errors are now a dismissible sticky errorContainer
  banner above the board, never a takeover.

- **Background sync: the app stays fresh while closed** (^brisk-moth): sync
  was strictly foreground-only (WhatsApp model), so hours away = a huge
  matrix.resume gap = minutes of "Syncing…" on open. Two additions, same
  reconcile pipeline: (1) `SyncEngine.backgroundSync()` — PushService kicks it
  on every data-bearing push (before the DND gate; DND silences notifications,
  not freshness): borrows the sync WS, runs ONE reconcile pass
  (`Reconciler.runNow()`), tears the socket down; throttled to one pass per
  5 min so chat storms don't hold the socket open by proxy, skipped entirely
  when foreground (the normal WS is already up). (2) `SyncWorker` — periodic
  WorkManager backstop (15-min floor, network-constrained, `force=true`) for
  silent deltas / missed pushes / PushService dead. Battery cost ≈ seconds of
  WS per pass, only when pushes actually arrive. Tests: SyncEngineTest (borrow
  tear-down, throttle+force, unreachable-hub no-reconnect-loop, foreground
  no-borrow); `isForeground` injectable — flipping the process-wide
  AppLifecycle in Robolectric wakes the real ConsoleApp graph.

- **Fix: space Agents tab crashed the app (StackOverflowError)** (^tall-bear): `lineageOrder` in SpacesScreen.kt grouped children by the parent's *agentKey* and walked `childrenOf[s.agentKey]` — a bound chat fork with `agentKey = null` looked up the null bucket (= the ROOTS list) and recursed root→fork→root forever; duplicate agentKeys had the same shape. Now keyed by the parent's session id with a `seen` guard (SPA parity), unit-tested in `ui/spaces/LineageOrderTest.kt` (null-key fork, duplicate keys, cycles, deep chains).

- **Spaces rail: review-count on the kanban badge + review-hand-back reclassification** (ba742c0, ^teal-finch): SpaceRow shows `reviewCount` beside the ViewKanban glyph; an unread session whose agentKey owns an Under-Review card moves its blue from the Bot badge to the kanban badge (attention red never moves). SpacesRepository parses `reviewCount`/`reviewAgentKeys` from `/blog/spaces` (older hub → 0/empty, safe defaults).


### v89 (2026-08-27)
- Spaces mobile parity round (post-v88 feedback): CardSheet scrolls as a whole
  (long agent report notes pushed Move/Assign/Open-agent off-screen) with the
  detail clamped to 8 lines + tap-to-expand; space rows gain the SPA rail-1
  indicators (Bot+count tinted by hottest alert, ViewKanban glyph when a board
  exists — dropped the "board" meta word); space Agents list ordered by
  creation (general agent first, ticket-forks trail nested) instead of
  alphabetical, rows gain SPA SessionBadges parity (amber Terminal+count,
  violet todo done/total hidden when complete, mic owner, Bedtime dormant).

- Home canvas WebView sends the APK bearer on `/hub/canvas/*` loads
  (`shouldInterceptRequest` in HomeScreen.kt) — the hub now auth-gates the
  unpublished canvas (^pink-tern leak fix), and this WebView has no session
  cookie. Without the bearer the canvas card 401s after the next hub deploy.

### v88 (2026-08-27)
- Agents tile removed — Spaces owns sessions (^deft-ant, parity with the SPA
  Agents-tab deletion): Pane.Agents gone (push pane "agents" maps to Spaces;
  the `agents/{sessionId}` detail route survives for deep links + Spaces/Home/
  Notes tap-throughs), AgentSessionListScreen/SessionTree/AgentOrgRoster/
  NewSessionDialog/QuickSwitcher/RoleInfoDialog deleted (org-roster verbs died
  hub-side 2026-08-26), grid badge/dot/urgent moved to the Spaces tile,
  FleetModelSheet + model-fallback + handoff banners now mount on SpacesScreen,
  Mic/Cron init moved there too. Spaces session↔space join now reads the
  session's own `project`/`areas` (Room v12: AgentSessionRow.project+areasCsv;
  fork glyph/depth from parentClaudeSessionId, not roles).

- Drafts relocated to log/drafts/ + projects/<slug>/log/drafts/ (beside where
  they publish): `Frontmatter.isDraftPath` widened (scratch legacy kept),
  `permalinkForLogPath` tightened to direct log/ children so drafts never
  mint permalinks (^bold-hawk + follow-up).
- "Hub disconnected" wedge needing a force-stop: a hub restart racing a
  background flip could kill the WS while its scheduled reconnect got lost —
  and start() on BOTH WS clients (sync bus + agents) was `if (wantConnected)
  return`, so every later foreground was a no-op; nothing could ever kick a
  reconnect again. start() now self-heals: want-connected but not connected →
  cancel stale reconnect job, reset backoff, re-open (generation-guarded, no
  socket duplication). SyncBusClient also gained the agents-WS stop()
  hardening (orphan callbacks via generation bump; openSocket cancels any
  prior socket).

### v87 (2026-08-20)
- Board card ^240ofe (Spaces parity M1+M2 core, per
  projects/console/spaces-parity-report.md): board I/O migrated OFF raw
  /notes/file/ markdown writes onto the hub's BoardOps API — GET
  /board/:project for reads (CardView shape), POST /board/:project/{cards,
  move,assign,block,edit,remove} for every mutation. The hub's per-board
  write queue now serializes this app against Obsidian/agents/SPA instead of
  last-writer-wins racing them; cards address by ^id (fallback: exact text →
  hub unique-substring). SyncBus `boards` service wired: changed/transition
  events for the open board re-fetch it live (the SPA doesn't even do this
  yet). Board errors surface inline instead of a silent stale view. Card
  chips gained the newline-preserved detail preview; per-ticket forks are
  excluded from assign options (SPA PillPicker parity — forks are the
  dispatch RESULT). KanbanCodec stays for isKanbanBoard/Done-column regexes
  only — clients never hand-write board files now.
- Dead delegation-tasks UI stripped (hub tore the system out 2026-08-14 for
  kanban boards): TasksSheet/TaskRow, the tasks toolbar badge, org-roster
  task counts, and AgentsRepository delegate/cancelTask/AgentTask/tasks
  stream handling are gone.

### v86 (2026-08-19)
- Board assign chips fixed per Yousef: roles BOUND to this space sort first
  (dimmed styling for the rest of the org), and chips are labelled by live
  session name → role title (rename-aware, "(fork)" stripped) instead of the
  raw @key — @key stays the wire token only. Card sheet shows "→ <name>" for
  the current assignee. Root cause of stale names is hub-side (rename_session
  never stamped the role title) — handed to the Console general session,
  which shipped the hub fix + the same SPA picker semantics (0182b1c).

### v85 (2026-08-19)
- Spaces Agents tab: fork-lineage tree — sessions render in lineage order
  (parents before their forks, DFS over role manager edges restricted to the
  space's bound set), indented 14dp per depth with the violet fork glyph;
  cycle/self-manager edges fall back to flat rather than vanishing. The same
  depth indents L1 inline alert rows.
- Spaces Agents tab: long-press a session → the SAME actions sheet as Agents
  proper (rename, mark read/unread, generate title, reload history, fork,
  merge, mic, end) — SessionActionsSheet made shared; Spaces is the
  replacement so it gets the full menu, not a subset.

### v84 (2026-08-19)
- Spaces L1 alert items are now inline ROWS under the space name (SPA
  SpaceListRail parity — v83's count badges were the wrong reading of the
  ask): each unread/attention/working session and each unsaved file renders
  as its own indented tappable row (dot colour = level, ✎ = dirty file), and
  tapping goes STRAIGHT to that session / that note — one tap from the top
  level, no drill-down hunting. Spaces with alert items sort first and bold.

### v83 (2026-08-19)
- Spaces L1 shows ALL the signal up front (no tap-hunting): per-space count
  badges instead of a single dot — red = sessions needing you, amber spinner
  = working, blue = unread, grey ✎N = unsaved local doc edits (dirty notes
  rows grouped by project). Alerted spaces bold + float first (attention >
  working > unread > dirty).
- Space detail default-tab priority per Yousef: Board above all else when the
  project has one; otherwise Agents whenever there are bound sessions or any
  unread/attention/working signal; Docs only when there's nothing
  agent-shaped to show.


### v82 (2026-08-19)
- SPACES pane v1 (project-first nav; the eventual Notes+Agents replacement,
  mobile-shaped): grid gains a Spaces app. L1 = space list (Areas, then
  Projects; alerted spaces float first with attention/working/unread dots via
  the role project:/areas: ↔ session.agentKey join). L2 = segmented
  Board | Agents | Docs. Board = horizontally-paged columns, Done hidden
  on-screen but kept in-file; tap card → sheet: move / assign @role /
  #blocked toggle / delete / jump to assignee's session; add-card per column.
  Agents = the space's bound sessions + "New agent in this space" (mints a
  durable role WITH the binding via create_session{asAgent,project,areas}).
  Docs = project-scoped file list → note editor. data/spaces/KanbanBoard.kt
  is a verbatim port of server/src/kanban/board.ts (lossless round-trip is
  the contract — the hub diffs this file for dispatch; ^blockids are NEVER
  stamped client-side); board saves PUT with baseMtime and reload on 409
  (stricter than the SPA). +7 codec tests.
- Dictation segments overwriting everything before them: the relay commits a
  turn at every ~600ms pause, so a long dictation yields MANY finals — each
  carrying only its own segment. Both native paths (Dictation.kt composer
  mic, PushService PTT) treated every final as THE whole turn and reset the
  accumulated buffer, so each pause erased all prior speech. Finals now
  append (superseding only their own segment's interims). The "one final
  carries the whole turn" rule only holds for the single post-stop final.
- Composer caret now follows dictation: the text field tracked a String, so
  externally-grown text (live transcript) left the cursor stranded mid-text.
  Switched to TextFieldValue with the selection pinned to the end whenever
  the text changes from outside the keyboard.


### v81 (2026-08-17)
- Property listing pins/pushes: two dead ends, one root cause each. (1) Tapping
  a property push notification opened a bare Map pane with no indication of
  which listing it was about — `handleGenericPush`'s tapIntent only ever built
  `console://pane/$pane`, and property pushes carry no roomId-equivalent
  `navigateDeepLink` could route on. Fix is hub-side + APK-side together: the
  per-listing push now carries a `url` field (the portal's own listing page),
  and `handleGenericPush` opens it directly via `ACTION_VIEW` when present,
  bypassing pane routing entirely — the most useful "took me somewhere"
  outcome for a notification about one specific external thing with no
  in-app detail route. (2) The map's `AgentFeaturePanel` DID open on tap (the
  generic agent-layer hit-test was fine), but rendered `url` as an inert plain-
  text row and had no dismiss action — reads as "shows nothing useful." Now
  renders `url` as a tappable "open" button (parity with the SPA's
  `LayerFeaturePanel`) and adds "not interested" when a feature carries both
  `listingId`+`searchId` (property pins only), calling the hub's new
  `POST /property/searches/:id/dismiss` then refreshing the layer so the pin
  disappears immediately. `FIELD_SPECIAL` keeps `listingId`/`searchId` out of
  the generic field rows.
- Chat message forwarding (WhatsApp flow): long-press a message → Forward →
  searchable recent-room picker → sends into the target room with a
  confirmation toast. Text forwards as a plain send (no Matrix relation —
  what bridges can carry); media resolves through the same path bubbles
  render from (local spool → decrypted E2EE cache → download) and re-sends
  as a fresh upload, so an E2EE original re-encrypts for the target room
  instead of leaking an mxc its members can't decrypt. sendAttachment's
  echo+queue tail factored into sendSpooledFile, shared by both. +1 test.
- Plan reviews take feedback (terminal parity): `PlanApprovalUi` gained a
  comment field — "Keep planning" sends the text as the deny reason (Claude
  keeps planning against it), "Approve plan" with text approves then sends the
  text as the next prompt. The session composer placeholder hints "Plan
  feedback — Claude keeps planning" while an ExitPlanMode approval is pending
  (the hub routes such sends into plan feedback, so no APK logic needed) and
  "Answer the question above first…" for AskUserQuestion.
- Dictation/PTT dropped the end of every utterance (and produced nothing at all
  for short ones). The STT model rejects `turn_detection`, so a transcription
  turn only ends when the client asks it to — but both native mic paths just
  closed the socket after a flat 700ms grace, which is shorter than the measured
  ~600-700ms commit→final latency, so the tail arrived after hangup and was
  discarded. `Dictation.stop()` and `PushService.pttUp()` now send
  `{type:'done'}` (relay commits immediately) and poll for the final with a 5s
  cap instead of sleeping a fixed grace. Also: the single `final` carries the
  WHOLE turn, so it now replaces the accumulated interim deltas rather than
  appending to them (was duplicating the utterance). Hub side already shipped.
- Calendar sidebar's per-account Delete now confirms first. It was the only
  single-account remove UI in either client and fired instantly, inches from
  the visibility toggles — and removing an account silently un-promotes every
  calendar it had better access to back to `reader`, which drops those
  calendars out of the new-event picker with no other symptom. The dialog
  spells that consequence out.

### v80 (2026-08-10)
- All chats frozen (stale but scrollable): after a long offline window the
  cursor'd matrix.resume grows huge — the hub walks per-room 100-event
  backfills for MINUTES (observed: 388 rooms / 20,850 events), blowing the
  APK's 120s RPC timeout. The failure left the cursor unadvanced, so every
  reconcile retried the SAME ever-growing gap forever: chats permanently
  frozen at the last synced point while previews (chat-rooms snapshot, a
  separate cheap path) stayed current. A failed cursor'd resume now falls
  back to a FRESH initial sync — the hub skips the backfill walk on isInitial
  so it's fast and bounded, and bulkPut ingestion is idempotent.


### v79 (2026-08-08)
- Mail unsnooze: the snoozed view's rows now carry an Unsnooze button — wakes
  the thread back into the inbox immediately (clears snooze + re-inbox +
  queued unarchive), instead of waiting for the timer.
- Agent task lists (SPA TodoPanel parity): the CLI's TaskCreate/TaskUpdate
  todos — hub-read off ~/.claude/tasks/<csid>/ and pushed as SessionInfo.todos
  + live session_todos broadcasts — now render natively: a collapsible
  "Tasks N/M · <current>" strip pinned above the session composer
  (auto-collapses when complete), and a violet done/total chip per sidebar
  row while a session is mid-plan (hidden when done). Transient state, SPA
  semantics mirrored exactly (ui/agents/TodoPanel.kt). Collapse state is a
  nullable override (`collapsed ?: allDone`) — as a plain Boolean with
  `collapsed || allDone` a *completed* list could never be tapped open, which
  is the state most sessions are in.
- Calendar visibility finally sticks: the shared calendar.visibleIds hub pref
  stores BARE calendarIds (the SPA's format), but the APK read/wrote
  accountEmail:calendarId compound keys — desktop-written entries never
  matched on the phone (calendars kept falling hidden) and phone toggles
  polluted the pref with compound keys the desktop ignored. All three sites
  (event filter, sidebar sheet rows, toggle) now use bare calendarIds, so one
  allow-list round-trips cleanly across devices.
- Approval/question dialogs answered on ANOTHER client (PC) lingered in the
  mobile list: v75's WS generation guard orphans the old socket's onClosed on
  a background stop, so the "clear approvals on disconnect" path stopped
  running — an approval answered while the phone was away had its
  tool_approved broadcast missed, and the stale card sat until app restart.
  stop() now clears transient approvals itself (the connect replay reliably
  re-delivers any STILL-pending one — the CLI blocks on it, so it's always
  near the log tail), and approval_required dedupes by requestId so the
  replay can't double-add one the live path already delivered.


### v78 (2026-07-28)
- Perma-"Syncing" (round three, the real one): trigger() cancelled the
  debounce job that run() executed INSIDE — a trigger landing mid-pass
  (home-press/reconnect storm) killed the running pass at its next suspension
  point, and the finally's suspending mutex.withLock throws in a cancelled
  coroutine, leaking running=true + syncing=true FOREVER: spinner stuck on,
  reconcile dead until app restart. run() now launches detached (cancel only
  coalesces waiting debounces) and the finally restores state under
  NonCancellable. Same bug class as v77's outbox drain. +1 test.
- Newest messages visible only in the room preview: with the reconciler dead
  (above), matrix.resume never ran — and live matrix deltas were advancing
  the resume cursor anyway, so the gap the WS-down window left was skipped
  FOREVER (broadcasts are fire-and-forget; resume is the only gap recovery).
  Live deltas now ingest without touching the cursor until this connection's
  resume has completed (per-connection gate, reset on connect). +1 test.


### v77 (2026-07-28)
- Outbox rows wedged in "processing" (queue clogged until hand-deleted, part
  two): the drain debounce cancelled a RUNNING drain when re-scheduled (every
  reconnect/foreground flip), aborting it after setStatus("processing") but
  before any result write — and pending() never revisits processing rows.
  Drains now run NonCancellable (debounce only coalesces waiting ones), and
  drain() itself recovers leaked processing rows at the top (it holds the
  single-flight lock, so any such row is by definition an abort leak). +1 test.
- Chat links unclickable in bridge messages: WhatsApp formatted_body carries
  URLs as PLAIN TEXT (no <a>), and AnnotatedString.fromHtml only links real
  anchors — so the HTML render path (chosen whenever formattedBody is set)
  produced dead links while plain-text messages linkified fine. New
  linkifyBareUrls post-pass adds LinkAnnotation.Url over any URL not already
  inside an anchor (HTML + markdown paths); link-preview card now also shows
  on formatted messages.
- Map: light-mode basemap toggle (sun/moon chip in the toolbar) — CARTO
  light_all vs dark_all, persisted; dark tiles are unreadable in sunlight.
  Style swap re-attaches the renderer (setStyle wipes sources/layers/images)
  so pins/track/agent layers survive the flip.
- Map: agent-layer features are now tappable (SPA popup parity) — tapping a
  where-to-move town / airport / flight-arc label opens an info panel built
  from the feature's properties, ordered by the layer's popup[] field list
  (all non-underscore props when absent), with a navigate button. Previously
  only geocache/Meetup pins were hit-tested.
- Map: navigate-out everywhere — geocache + Meetup detail panels gained a
  "navigate" button, and LONG-PRESS on any arbitrary spot shows a coords chip
  with NAVIGATE. All go through a geo: URI chooser ("Open with…" → Google
  Maps etc.), web-Maps URL fallback if no handler.


### v76 (2026-07-27)
- Switching apps no longer loses your place (launcher mode): pressing Home
  from ANOTHER app re-delivers MAIN+HOME to Console, which unconditionally
  popped to the grid — so coming back you were dumped on the wall instead of
  the chat/mail you were in. The handler now checks lifecycle state at
  onNewIntent: activity stopped (arriving FROM elsewhere) → restore as-is, no
  pop; already visible (Home pressed IN Console) → pop to grid as before,
  with saveState so re-opening a pane resumes where you left it.
- markRead (or any queued action) randomly stuck in the outbox until
  hand-deleted: transport-down returned Retry, so a drain storm during a
  reconnect (foreground + connectivity + WorkManager all fire while the WS is
  still handshaking) burned all 3 retries on "hub disconnected" and parked the
  row as terminal `failed` — it then sat there forever since terminal rows
  never re-drain. New NotReady result: transport-down means the action was
  never attempted, so it goes back to pending with the retry budget untouched
  (guards + a message classifier for the guard-then-socket-dies race, applied
  across all repos' handlers). Startup requeues rows the old behaviour already
  parked. +2 outbox unit tests.
- Edited messages rendered with a huge blank block above the text: the diff
  Text and its "(edited)" sibling shared a Row — Row gives the first child its
  full preferred (single-line) width, so beside the tag the long diff wrapped
  one character per line into a tall invisible column. The tag is now appended
  inside the same AnnotatedString (one Text, wraps normally). Same latent bug
  fixed in DeletedMessageBody's "(deleted by …)" tag.
- ONE toast style app-wide: mail's Archived/Deleted (and calendar's Deleted)
  rendered as full-width Material Snackbars while chat used a compact rounded
  bottom pill. UndoHost now renders the chat-style pill (wrap-content, rounded,
  inverseSurface, coloured UNDO text) for every undo + app toast, and chat/
  calendar's bespoke inline bars were deleted in favour of the shared host.


### v75 (2026-07-27)
- Garbled agent streamed text ("Found itFound it — …pdf, most — …pdf…"): a
  background→foreground flip leaked the OLD agents WebSocket — its late
  onClosed fired after start() flipped wantConnected back on, scheduling a
  SECOND reconnect; from then on two live sockets fed the same delta buffer
  and every streamed chunk appended twice. Fixed with the same generation
  counter SyncBusClient already uses: stale sockets' callbacks are ignored,
  open() cancels any prior socket, stop() orphans the live one.
- Own reaction showed twice: the optimistic echo recorded sender "me" while
  the round-tripped Matrix event added the real MXID — two "senders", doubled
  chip. Echo now records the real MXID; ingest reaps a legacy "me" when the
  MXID copy arrives; render-time heal for already-cached rows. +2 unit tests.
- Reaction chips: long-press now shows WHO reacted with real display names
  (member list → cached rows → localpart; you = "You"), not MXID localparts.

- Sync status redesigned for harmony: the top-center text pill ("Syncing 3…",
  "Synced 12m ago") is replaced by a compact top-RIGHT corner chip — icon (or
  11dp spinner) + a number, no sentences. States: offline = cloud-off icon
  (+ queued count and/or data age "2h"), failed = error icon + count (tap →
  outbox), flushing = spinner + count, slow reconcile = bare spinner.
  "Synced Nm ago" is GONE while connected — live deltas keep data current, so
  staleness only renders offline where it means something. Silence = live.
  It's a pure overlay (never reflows/shifts anything) and sits BELOW the 52dp
  top bar so it can't cover pane action icons either.
- Transcript duplication, SECOND path closed: v69 stamped indices on replay
  bursts, but LIVE broadcasts were unstamped, so the APK appended them at its
  local maxIndex+1 — which drifts from the hub log (echoes, missed messages) —
  and the next replay re-delivered the same tail at authoritative indices:
  everything in the tail duplicated (the triple "v74 is live" screenshot).
  Hub-side: Session.logMessage now stamps absIndex on the message object
  BEFORE broadcast (all routes reordered log-then-broadcast), so every live
  loggable message carries its authoritative index and the APK always upserts.
  One-time purge v75 clears rows duplicated by pre-fix live appends.


### v74 (2026-07-26)
- Mark-read in a chat now returns you to the chat list (inbox-zero flow:
  ✓✓ = done with this conversation).
- App drawer sorts by launch frequency (usage ledger learned from taps,
  recency tiebreak, alphabetical for never-launched; same pattern as the
  reaction ranking). Persisted; re-sorts live after each launch.
- "— New —" divider made reliable: placement is now COUNT-based (divider sits
  above exactly unreadCount messages-from-others — the same number the badge
  shows), because timestamp watermarks proved unreliable (bridges deliver
  events with origin timestamps BEHIND the read watermark; some rooms lack a
  lastReadTs entirely). Watermark kept only as the manual-unread fallback.
  unreadCount + watermark both frozen at open so racing read-receipts can't
  move the line. +3 unit tests incl. the skewed-bridge-timestamp case.


### v73 (2026-07-26)
- Permanent "Syncing…" pill: launcher mode made every home-press trigger a
  reconcile, and (a) a single wedged domain pinned the pass forever — each
  domain now has a 45s hard timeout; (b) the dirty re-run loop was unbounded
  under trigger storms — capped at 3 passes; (c) the pill now has a 3s grace
  so sub-second routine passes never flash it.
- Blank screen until lock/unlock: the earpiece-routing PROXIMITY_SCREEN_OFF
  wake lock was acquired for the WHOLE voice-message playback (any stray
  "near" — finger over the sensor — blanked the screen; a leak kept it black
  until the power button reset it). The lock is now created unheld and
  acquired ONLY while the proximity sensor reports near, released on far/stop.
  Also android:stateNotNeeded="true" on MainActivity (home apps must render
  without saved state — the standard launcher relaunch path).


### v72 (2026-07-26)
- LAUNCHER MODE: Console can be set as the Android home app (Settings →
  Default apps → Home; optional — works identically as a normal app otherwise).
  Manifest gains a MAIN+HOME intent-filter + QUERY_ALL_PACKAGES (sideloaded).
  The grid is the home screen: Console panes on top, an APPS drawer below —
  every launchable app (LauncherApps, profile-aware incl. work apps ⧉, live
  install/uninstall updates), tap to launch, long-press → system app info,
  one search box filtering panes AND apps. Home button/gesture pops to the
  grid (MAIN+HOME onNewIntent). core/InstalledApps.kt + GridScreen drawer.
- Sync freshness is now always answerable: the Reconciler exposes syncing +
  lastSyncedAt (completed-pass timestamp); the shell pill shows "Syncing…"
  during any reconcile pass and "Synced Xm ago" whenever the last completed
  pass is >2 min old — silence means connected AND fresh. (Offline/queued/
  failed states unchanged.) Agents list already shows live/offline per header.


### v71 (2026-07-24)
- Quick-react row seeds from your REAL reaction history on first open: reactions
  from any device aggregate onto cached message rows ({emoji: [senders]}), so
  RecentEmoji.seedFromHistory counts rows where your MXID reacted (verified on
  Yousef's device: 👌 ×10, 🙏 ×9, 😂 ×3 …) and merges into the frequency ledger
  (one-time, "seeded" flag). No re-training needed — 👌 leads from day one.
- Mail thread bar redesigned (was 8 cramped icons): bar = triage only
  (Archive · Delete · Unread + ⋯ overflow with Snooze / colour toggle /
  Forward); Reply + Reply-all are full-width chips after the LAST message,
  where replying actually happens (Gmail pattern).


### v70 (2026-07-23)
- Chat unread counts disagreed (grid badge 4, header 2, room pills 3): three
  different formulas. Now ONE: unhandled CONVERSATIONS = unread, not muted, not
  low-priority, not snoozed — pinned included (grid DAO query gained the
  low-priority filter; the header now adds unread pinned rooms instead of
  ignoring them). Per-room pills still show message counts within a room.
- Mail thread top bar: 8 action icons left the title slot ~zero width, so the
  subject wrapped UNDER the back arrow. Bar is now icons-only — sender/subject
  are on the message card directly below.
- Opening a feed article no longer marks it read (house rule: read state changes
  only by explicit action — SPA parity; selectItem never marks there either).
  The item screen's toggle now reflects the TRUE stored read state (repo.isRead)
  instead of assuming unread-on-open.
- Reaction picker: the quick-react row now shows YOUR most-used emoji
  (frequency+recency ranked, persisted in data/chat/RecentEmoji.kt; defaults
  only until you have history — every reaction from the sheet or an existing
  chip bumps its count), plus a "+" that expands a searchable full picker over
  the whole 2,376-emoji shortcode table (adaptive grid, 300dp max).
- Agent wake/initial message showed twice: the optimistic local echo AND the
  hub's authoritative logged copy (different rows — the echo has no absIndex).
  Echoes are now flagged localEcho and reaped when an authoritative user_prompt
  with the same content lands (live replay + REST catch-up both sweep).
- Agent images ACTUALLY render now: Coil 2.x has no data-URI fetcher, so
  AsyncImage on the data: URLs silently rendered nothing (v69's fix persisted
  the images but they still didn't show). data: URLs are now base64-decoded
  natively to an ImageBitmap.


### v69 (2026-07-22)
- Archived/Undo snackbar STILL rendered as a full-width bar at the top: UndoHost was
  mounted without a size, so its internal BottomCenter alignment was meaningless
  (wrap-content Box at the shell top). Now fillMaxSize-anchored bottom-center with
  bottom padding — small, floating, above the composer area.
- Lightbox black on enlarge: the gallery passed raw download URLs, but for E2EE
  images that URL is the CIPHERTEXT blob (renders black). The lightbox now resolves
  each image the same way bubbles do: local spool → AES-CTR-decrypted cache
  (repo.mediaFile) → plain URL, with a spinner while decrypting.
- Chat unread "— New —" divider: existed since v50s but was suppressed in practice —
  (a) the watermark freeze was gated on room.isUnread, so any read-receipt delta
  racing the room open killed it; now frozen unconditionally on first room emission
  (timestamps decide whether a divider shows). (b) The 30-message initial window was
  smaller than the unread run (e.g. 42 unread), so the true first-unread wasn't in
  the window; the window now widens to unreadCount+10 on open.
- More obfuscated/matrix sender names: the APK only read the delta's timeline
  block — member display names arrive in the delta's state.events block on
  initial/limited syncs (the SPA merges state first; that WAS the desktop fix).
  State events now ingest before the timeline. Also: unresolved names kick a
  background member fetch whose repair pass heals the rows once names arrive,
  and the cached-name fallback no longer trusts rows whose "name" is the raw MXID.
- Links in agent transcripts are now tappable: MarkdownLite painted [label](url)
  and bare URLs blue+underlined via SpanStyle only — LinkAnnotation.Url makes
  them real links (opens browser). http/https/mailto/tel only.
- Voice messages route to the EARPIECE when the phone is held to the ear
  (WhatsApp behaviour): proximity sensor watched while playing (ui/chat/
  EarpieceRouting.kt, ref-counted); near → MediaPlayer rebuilt at the same
  position with USAGE_VOICE_COMMUNICATION + MODE_IN_COMMUNICATION +
  setCommunicationDevice(earpiece), away → back to speaker; a
  PROXIMITY_SCREEN_OFF wake lock blanks the screen at the ear like calls.
- Bare "Mail" (or "Chat") notification: the group SUMMARY outlived its children —
  per-item cancels (hub cancel pushes, reconcile sweep) removed the real
  notifications but never the summary, which then rendered as an empty card.
  reapOrphanSummaries() now cancels a summary when its last child goes, on both
  cancel paths.
- Feeds: YouTube videos play (embed URL loaded directly — the iframe-wrapper page
  tripped YouTube's origin check; HTML5 video also needs a WebChromeClient).
  HN no longer grouped under a "null" folder (JsonNull.content is the STRING
  "null"). Reddit posts: the RSS thumbnail+text table now stacks vertically
  instead of a 70px image cell beside a text wall.
- Animated WhatsApp stickers animate: Coil had no animated decoder registered, so
  animated WebP/GIF rendered as the first frame only. ImageDecoderDecoder (API 28+,
  animated WebP + GIF) / GifDecoder fallback added to the global ImageLoader —
  E2EE stickers render from the decrypted full file, so animation survives.


### v68 (2026-07-22)
- Chat network badges: real brand glyphs (path data extracted verbatim from the SPA's
  react-icons set, brand colours) on a small chip that OVERHANGS the avatar circle
  bottom-right (SPA parity) — replaces the emoji lookalikes (🟢 WhatsApp etc.) that
  were also clipped by the avatar's circle mask. ui/components/NetworkIcons.kt.
- Calendar tab's app-grid button showed a calendar icon instead of the grid glyph
- Sync/offline banner → floating top-center pill OVERLAY (never shifts the layout;
  the old in-flow banner nudged the whole screen every time a sync started).
  Still tappable → outbox inspector. Update/re-auth banners stay in-flow (rare).
- Send auto-scrolls to bottom in chat + agent transcripts (immediate, not waiting
  for the local echo). Verified Enter = newline everywhere: composers are
  multi-line BasicTextFields with no ImeAction.Send/KeyboardActions send binding —
  send is exclusively the send button. (Search/URL/date fields keep Done/Go.)
- Chat sender names: group messages showed raw bridge MXID localparts
  ("whatsapp_lid-1669…"). Ported the SPA's sender enrichment (m.room.member state
  events in the delta → cached-message fallback → member cache → DM room-name
  fallback) into processEvents, + a repair pass that backfills names onto old
  cached rows whenever a room's member list loads.
- Bridge type-changing edits (WhatsApp swapping a failed sticker for a notice)
  no longer render as a red/green word-diff with a dead media box — the edit
  adopts the new msgtype/media and isn't marked "edited"; notices never diff.
- Images sent to agents now persist in transcript history (local echo stores
  data-URLs, same shape as the hub broadcast; previously they vanished on reopen).


### v67 (2026-07-21)
- Map white void: style JSON was passed to setStyle(String) which treats it as a URI —
  silently never loaded. Now Style.Builder().fromJson(...).
- Mail undo toast → shared bottom UndoHost snackbar (small, bottom, consistent);
  UndoController gained onExpire cleanup hook (attachment eviction preserved)
- Mail grid badge = inbox thread count (SPA parity: triage-left, not unread count)
- WebView zero-height class of bug FIXED: a WebView inside verticalScroll measures 0
  (UNSPECIFIED max-height) and renders nothing. New shared SelfSizingWebView
  (ui/components/HtmlWebView.kt) sizes itself from renderer contentHeight (JS off);
  mail bodies + feeds full-text now use it. This was "anything involving webviews
  seems broken" — also why the Dark/Original toggle looked broken (body was invisible).
- Home Blog tab: hub emits FLOAT mtimes; longOrNull parsed null → all ages 1970. Now
  doubleOrNull. Canvas tab: domStorageEnabled=false made the canvas shell throw on
  localStorage and blank — enabled.
- Bookmark detail: "Preview page here" — embedded WebView (420dp, zoomable) renders the
  bookmarked URL in the sheet; collapsed by default.
- ONE permanent notification: Push/Glasses/Pen FGS all share notification id 1 via
  core/OngoingNotif ("Console · <push> · <glasses> · <pen>"); idle services contribute
  no line; stop uses STOP_FOREGROUND_DETACH so survivors keep the row. Glasses/Pen
  services no longer start at all when unpaired (PairStore gate; settings Scan
  force-starts for first-time pairing).
- Email Dark/Original preference persists app-wide (SharedPreferences)
- Repeated messages in agent chats: the hub's 50-message replay burst on every
  WS reconnect carried no indices, so the APK appended it at maxIndex+1 each
  time — the transcript tail duplicated per reconnect (355 rows / 104 distinct
  on-device). Hub replay now stamps each message with its absolute log index
  (SPA ignores it); the APK upserts at that index (REPLACE on the unique
  (sessionId, absIndex)). One-time purge (meta agents:dedupPurgeV67) wipes the
  polluted cache; REST catch-up refills with authoritative indices.


### v66 (2026-07-20)
- Context meter clamp (interim estimate could exceed window: "391k / 200k")
- Composer paste-image button folded into attach long-press

### v65 (2026-07-20)
- Bidirectional inbox membership sweep (missing inbox items: failed hydrates were treated as archives)
- Sentence auto-capitalization on all free-text inputs (composers, mail subject/body, notes, event fields, prompts)

### v64 (2026-07-20)
- Durable composer drafts (SharedPreferences DraftStore per chat room / agent session)
- Dead-thread inbox sweep (threads deleted outright on Gmail's side)
- Agent-text copy button removed → long-press message for Copy/Read-aloud sheet
- Remaining "queues offline" filler text removed

### v63 (2026-07-20)
- Map completely white (MapView.onCreate never called)
- NavHost cross-fade transitions removed
- Sync banner: pending vs failed split, tappable → outbox inspector; mail 404/410 label ops treated as done
- Agent streamed-text mangling (WS delta races → single-consumer channel; tool-input accumulator per toolUseId)
- Code fences: long-press-to-copy replaces button row
- Needs-me filter persistence
- PTT hardware key: agent chat open → composer dictation, else /mic/say to mic owner

### v62 (2026-07-20)
- Full FEATURES.md parity release (560 MISSING + 191 DEGRADED built)
