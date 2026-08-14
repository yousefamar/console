# Android app backlog

Working agreement: Yousef files singular bugs/features here (via any Claude session);
they get implemented + committed as they come, but a **release is cut only when
there's significant meat** — no rebuild per item. Committed-but-unreleased work sits
in "Built, awaiting release" until a version ships, then moves under that release.

## Open (not yet built)

_(empty)_

## Built, awaiting release

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

## Shipped

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
