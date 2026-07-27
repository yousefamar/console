# Android app backlog

Working agreement: Yousef files singular bugs/features here (via any Claude session);
they get implemented + committed as they come, but a **release is cut only when
there's significant meat** — no rebuild per item. Committed-but-unreleased work sits
in "Built, awaiting release" until a version ships, then moves under that release.

## Open (not yet built)

_(empty)_

## Built, awaiting release

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

## Shipped

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
