# Android app backlog

Working agreement: Yousef files singular bugs/features here (via any Claude session);
they get implemented + committed as they come, but a **release is cut only when
there's significant meat** — no rebuild per item. Committed-but-unreleased work sits
in "Built, awaiting release" until a version ships, then moves under that release.

## Open (not yet built)

_(empty)_

## Built, awaiting release

- Chat unread counts disagreed (grid badge 4, header 2, room pills 3): three
  different formulas. Now ONE: unhandled CONVERSATIONS = unread, not muted, not
  low-priority, not snoozed — pinned included (grid DAO query gained the
  low-priority filter; the header now adds unread pinned rooms instead of
  ignoring them). Per-room pills still show message counts within a room.

## Shipped

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
