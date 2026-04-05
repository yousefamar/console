# Console — Bespoke Command Center

## What is this?
A personal command center: offline-first Gmail inbox + Matrix chat + Obsidian bookmark browser + Obsidian vault note editor + RSS/Atom feed reader + Google Calendar + Monzo banking + Claude Code agent sessions, unified under inbox-zero. Every email is triaged (archived, snoozed, or replied to). Every chat with unread messages appears until responded to or marked read. Bookmarks are browsed, searched, and triaged (keep/delete/tag). Notes are edited with vim keybindings and live markdown preview via CodeMirror 6. Feeds are synced offline with unread tracking and inbox-zero triage. Calendar shows week/day views with full CRUD, RSVP, and multi-calendar support. Agent sessions run Claude Code from the browser via a local server. No labels, no folders — just fast triage.

## Architecture
- **Pure web app (PWA)** — installable standalone app, works in any browser including mobile
- **Offline-first** — all mutations happen locally first, sync when online
- **Stateless post-sync** — app state derived from synced data + local queue
- **Sub-app isolation** — Layout subscribes only to `activePane`. Each pane (MailTab, ChatTab, BookmarkTab, NotesTab, FeedTab, CalendarTab, MoneyTab, AgentTab) owns its own store subscriptions. A chat state change never re-renders the email pane and vice versa.
- **Pre-rendered panes** — all email threads and chat rooms mounted with `display:none`, toggled on selection for instant switching. Chat rooms use deferred re-renders (ref for hidden, state for visible).
- **Live queries in leaves** — Dexie `useLiveQuery` calls live in leaf components (ThreadList, ChatRoomList, SyncStatus), never in parent Layout. ThreadView split into 3 isolated siblings (Header, Messages, Compose).
- **Cloudflare Pages** — SPA from CDN + two Pages Functions for OAuth token exchange/refresh
- **No backend** — Gmail API + People API + Matrix CS API directly from browser; Cloudflare Worker only holds `client_secret` for OAuth

## Tech Stack
React 19, TypeScript, Vite, Zustand, Dexie.js (IndexedDB), Tiptap 3 + tiptap-markdown, CodeMirror 6 + @replit/codemirror-vim (notes editor), DOMPurify, Tailwind CSS 4, Lucide React, Day.js, fzf (fuzzy filename search), MiniSearch (full-text search), Vitest, Cloudflare Pages + Wrangler, @matrix-org/matrix-sdk-crypto-wasm (E2EE), diff (word-level diffs for message edits), rss-parser + fast-xml-parser (feeds), @mozilla/readability + linkedom (full-text extraction)

## Project Structure
```
src/
  main.tsx, App.tsx, index.css, hub.ts, notifications.ts
  __tests__/           — Vitest tests (335 tests, 17 files)
  db/
    index.ts           — Dexie v7: threads, messages, attachmentData, chatRooms, chatMessages, feedItems, feedRead, calendarList, calendarEvents, queue, meta
    sync-queue.ts      — Offline mutation queue (email + chat actions), immediate flush on enqueue
  gmail/
    types.ts           — Gmail API + DB types (DbThread, DbMessage, QueuedAction, etc.)
    auth.ts            — Google OAuth2 code flow (popup → backend exchange → refresh token in IndexedDB)
    api.ts             — Gmail REST + People API wrapper
    sync.ts            — Full + incremental email sync, queue processing, snooze checks
  matrix/
    types.ts           — Matrix API + DB types (DbChatRoom, DbChatMessage)
    auth.ts            — Matrix password login, .well-known discovery, localStorage session
    api.ts             — Matrix CS REST API (sync, send, send encrypted, read receipts, typing, media URLs, pagination)
    crypto.ts          — E2EE via OlmMachine WASM: init, decrypt, encrypt, key sharing, outgoing request routing, cross-signing bootstrap & device verification
    key-backup.ts      — SSSS recovery key restore: base58 decode, HKDF, AES-CTR decrypt, importExportedRoomKeys, cross-signing key import from SSSS
    decrypt-media.ts   — AES-CTR-256 decrypt/encrypt for Matrix encrypted attachments
    sync.ts            — Full + incremental Matrix sync, chat queue, bridge detection, E2EE-integrated event processing
  store/
    inbox.ts           — Email: thread list, selection, archive, snooze, reply, send, undo
    chat.ts            — Chat: room list, selection, mark read, send, snooze, pagination, undo
    compose.ts         — Email compose/reply state, file attachments (base64), quotedHtml
    bookmarks.ts       — Bookmarks: list, selection, filtering, triage mode, tag editing
    notes.ts           — Notes: vault adapter, file tree, open files, search, dirty tracking
    feeds.ts           — Feeds: subscriptions, items, unread tracking, IndexedDB hydration, hub sync
    calendar.ts        — Calendar: calendars, events, view state, CRUD, RSVP, optimistic updates
    money.ts           — Money: Monzo banking, balance, transactions, pots, spending
    ui.ts              — Modals, dark mode, sync status, active pane (email/chat/bookmarks/notes/feeds/calendar/agents)
  hooks/
    useKeybindings.ts  — Pane-aware vim-style shortcuts (dispatches to email or chat store)
    useSync.ts         — Dual sync loop (email + Matrix), live queries, preload chain
    useMediaQuery.ts, useSwipeActions.ts
  components/
    Layout.tsx         — Mail/Chat tab toggle, split pane, pane-aware footer hints
    ThreadList.tsx, ThreadListItem.tsx, ThreadView.tsx, MessageView.tsx
    ChatRoomList.tsx, ChatRoomListItem.tsx, ChatRoomView.tsx, ChatMessageBubble.tsx, ChatComposeInput.tsx
    MatrixLoginModal.tsx — Connect Matrix account (homeserver + credentials + password visibility toggle)
    AccountModal.tsx   — Account management, Matrix key backup restore via recovery key, device verification via cross-signing
    AgentTab.tsx          — Agent session list + session view container
    AgentSessionView.tsx  — Message stream, status bar, tool approval, prompt input
    AgentMessageBlock.tsx — Renders text/thinking/tool_use/tool_result/error/result blocks
    AgentToolApproval.tsx — Tool approval + AskUserQuestion UI (interactive question/answer with options)
    AgentPromptInput.tsx  — Prompt input with send, new session, interrupt
    BookmarkTab.tsx       — Bookmark tab container (browse/triage modes)
    BookmarkList.tsx      — Scrollable bookmark list with search + stats
    BookmarkListItem.tsx  — Single bookmark row (title, domain, tags)
    BookmarkTagTree.tsx   — Hierarchical tag sidebar with expand/collapse
    BookmarkDetail.tsx    — Detail view with tag editing + iframe preview
    BookmarkTriageView.tsx — Tinder-style triage with keep/skip/delete
    NotesTab.tsx          — Notes tab container (vault connection + split pane)
    NotesFileBrowser.tsx  — Recursive file tree sidebar with expand/collapse
    NotesEditor.tsx       — Editor with tab bar, dirty indicators, status bar
    NotesEditorCore.tsx   — CodeMirror 6 wrapper with vim mode + live preview
    NotesQuickSwitcher.tsx — Fuzzy file finder modal (fzf-powered)
    FeedTab.tsx           — Feed reader tab (3-col desktop, single-view mobile)
    FeedFolderTree.tsx    — Feed folder tree sidebar with unread badges
    FeedItemList.tsx      — Feed item list with search + unread toggle
    FeedItemListEntry.tsx — Single feed item row
    FeedItemView.tsx      — Article viewer (DOMPurify HTML + YouTube embeds)
    FeedAddModal.tsx      — Add feed URL or import OPML
    CalendarTab.tsx       — Calendar tab container (sidebar + grid)
    CalendarGrid.tsx      — Custom week/day time grid with event rendering and overlap handling
    CalendarSidebar.tsx   — Mini month picker + calendar list with visibility toggles
    CalendarEventPopover.tsx — Event detail popover with RSVP, edit, delete
    CalendarEventForm.tsx — Create/edit event modal
    CalendarLocationPicker.tsx — Working location picker (Home/Office/Custom)
    ComposeEditor.tsx, ContactAutocomplete.tsx, AttachmentBar.tsx, CalendarEventCard.tsx
    DateTimePicker.tsx, SearchOverlay.tsx, SnoozePicker.tsx, KeybindingHelp.tsx
    MoneyTab.tsx          — Monzo banking tab (sidebar + tx list + tx detail)
    EmailFrame.tsx, SyncStatus.tsx, InboxZero.tsx, UndoToast.tsx, AuthScreen.tsx
  calendar/
    types.ts             — CalendarInfo, CalendarEvent, DB types
    api.ts               — Google Calendar REST API wrapper, multi-account (accountEmail param on all calls)
    accounts.ts          — Multi-account OAuth token manager (primary delegates to gmail/auth, additional accounts have own tokens)
  notes/
    vault-adapter.ts     — VaultAdapter interface + FSA + Hub implementations
    search-index.ts      — MiniSearch full-text + fzf filename fuzzy search
    live-preview.ts      — CM6 ViewPlugin for Obsidian-style live markdown rendering
    editor-theme.ts      — CM6 theme matching Console design system
  utils/
    email.ts, email-cache.ts, attachment-cache.ts, date.ts, html.ts
server/                  — Local Node.js backend (REST + WebSocket)
  src/
    index.ts             — HTTP + WebSocket server setup, route dispatch
    session.ts           — Claude CLI subprocess manager (spawn, stdin/stdout NDJSON)
    bookmarks.ts         — Bookmark file parser, in-memory cache, CRUD operations
    feeds.ts             — RSS/Atom feed store: config I/O, fetch/parse, OPML import, read tracking, full-text extraction
    notes.ts             — Note file server for vault fallback (list, read, write, delete, rename)
    protocol.ts          — Shared types: ClientMessage, HubMessage, Claude NDJSON protocol
    manifest.ts          — Session manifest persistence (save/restore across restarts)
    history.ts           — JSONL session history loader + past session discovery
    projects.ts          — Claude project directory discovery + path decoding
    auth-store.ts        — Multi-account OAuth token manager (~/.config/console/auth.json)
    al-bridge.ts         — Al WebSocket bridge (translates Al protocol ↔ HubMessage)
    gmail-client.ts      — Gmail REST API client (server-side, uses auth-store tokens)
    calendar-client.ts   — Google Calendar REST API client (server-side, uses auth-store tokens)
    monzo-client.ts      — Monzo REST API client (OAuth2, form-encoded, single-use refresh tokens)
    monzo-store.ts       — Monzo transaction cache (JSON file, full + incremental sync)
    matrix-client.ts     — Matrix CS API client (server-side, uses auth-store tokens)
    routes/
      agents.ts          — WebSocket message handler for Claude Code sessions
      bookmarks.ts       — Bookmark REST endpoint handlers
      feeds.ts           — Feed REST endpoint handlers
      notes.ts           — Notes REST endpoint handlers
      auth.ts            — OAuth callback flow + Matrix login + auth status
      mail.ts            — Gmail proxy routes (threads, send, attachments, contacts)
      calendar.ts        — Calendar proxy routes (events, RSVP, location, accounts)
      monzo.ts           — Monzo routes (balance, transactions, pots, spending, webhook)
      matrix.ts          — Matrix routes (rooms, messages, send, reactions, receipts)
    __tests__/           — Session, protocol, bookmarks, notes tests (102 tests)
cli/                     — CLI tool for AI agents and power users
  src/
    index.ts             — Entry point: arg parsing, noun-verb dispatch, global flags
    client.ts            — HTTP client to hub (fetch wrapper)
    ws-client.ts         — WebSocket client for agent tail/wait, chat tail
    output.ts            — Envelope formatting, TTY vs JSON, field selection
    commands/
      registry.ts        — Command registry (81 commands) for capabilities/schema
      help.ts            — Help text for all services
      mail.ts            — Email commands (list, read, archive, send, reply, etc.)
      chat.ts            — Chat commands (rooms, messages, send, react, tail, etc.)
      bookmarks.ts       — Bookmark commands (list, get, update, delete, tags)
      notes.ts           — Notes commands (list, read, write, search, daily)
      feeds.ts           — Feed commands (items, mark-read, add, import/export)
      cal.ts             — Calendar commands (events, create, edit, rsvp, location)
      money.ts           — Money commands (balance, transactions, pots, spending, sync)
      agent.ts           — Agent commands (create, send, tail, approve/deny, wait)
      auth.ts            — Auth commands (login google/matrix, status)
      search.ts          — Cross-service search
      status.ts          — Hub health + version
      capabilities.ts    — Self-discovery for AI agents
      schema.ts          — JSONSchema introspection for any command
      util.ts            — Flag parsing utilities
functions/             — Cloudflare Pages Functions: api/auth/exchange.ts, api/auth/refresh.ts
docs/
  agent-architecture.md  — Full agent system documentation
```

## Design System
- Tokens in `src/index.css` via Tailwind CSS v4 `@theme` block (spacing, typography, animations, colors) + CSS custom properties for light/dark mode
- Dark mode via `dark` class on `<html>`. Email iframes have separate dark mode toggle (CSS invert filter, no reload).
- Philosophy: dense, monochrome, minimal. Sharp corners. System fonts. 100ms max transitions.

## Key Patterns (Email)
- **Optimistic mutations** — triage updates local state immediately, queues for Gmail sync
- **Immediate queue flush** — processQueue fires within 500ms of enqueue (debounced)
- **No delete** — only archive (done) and snooze
- **Auto-archive on send** — replying auto-archives (inbox-zero: dealt with = done). 5s undo.
- **Tinder UX** — after archiving/snoozing, next thread auto-selects
- **Pre-rendered iframes** — all email iframes mounted in DOM (display:none), instant CSS toggle on selection
- **CID inline images** — resolved during preload (attachment fetch → blob URL replacement)
- **Three-phase preload** — sync → email iframes (with CID) → attachment data
- **Attachment eviction** — cached blobs evicted from IndexedDB on archive
- **Conflict detection** — checks for new thread messages before sending queued replies
- **Sync race protection** — incremental sync preserves threads with pending unarchive/unsnooze
- **Snooze is local-only** — Gmail API has no snooze. Snooze = archive + local timer. Sync preserves snoozed threads.
- **Auth code flow** — Google `initCodeClient` popup → backend exchange → refresh token in IndexedDB. Proactive refresh 5min before expiry. 401 → auto-retry with refresh → re-auth banner only if refresh token revoked.
- **Thread labelIds** — merged from ALL messages (not just latest)
- **Thread sender** — first message (OP) sender, not latest
- **No drafts** — intentional. Compose and send, or snooze. See `docs/drafts-architecture.md`.
- **DRAFT filtering** — sync filters out messages with DRAFT label
- **Send-as aliases** — fetched from Gmail `/settings/sendAs` during full sync. `pickFromAddress` auto-selects: exact match → domain match → default.
- **Calendar invites** — inline `text/calendar` parsed into structured data, rendered as card above email body
- **Snippets** — Gmail API snippets decoded via `decodeEntities` (shared by ThreadListItem and MessageView)

## Key Patterns (Chat / Matrix)
- **Direct REST API** — no matrix-js-sdk. Same architecture pattern as Gmail integration.
- **Unified inbox** — chat rooms with unread messages appear in Chat tab. Tab key switches mail/chat.
- **Inbox-zero semantics** — `e` marks room read (leaves inbox). New messages bring it back.
- **Optimistic mark-read** — Zustand `set()` fires synchronously (instant UI), DB write + queue enqueue happen in background. `optimisticallyRemoved` Set prevents Dexie live query from re-adding rooms before DB write confirms (same pattern as email inbox.ts).
- **Auth** — Matrix password login + .well-known discovery. Session in localStorage.
- **Long-polling sync** — incremental sync uses Matrix long-polling (`timeout: 30000`) for near-instant message delivery. Continuous `while (!stopped)` loop, 5s backoff on error. Full sync uses `timeout: 0`. Sync lock prevents concurrent syncs from interleaving.
- **Per-room live queries** — each `RoomMessages` component has its own `useLiveQuery` scoped to that room's messages. Avoids one giant query loading all messages for all rooms.
- **E2EE** — full Olm/Megolm decryption + encryption via `@matrix-org/matrix-sdk-crypto-wasm` (OlmMachine WASM state machine). Crypto init'd at startup, keys persisted in IndexedDB (`console-crypto-store`). Sync feeds `to_device` events, `device_lists`, and OTK counts to OlmMachine. Outgoing requests (key upload/query/claim/to-device) routed automatically. Encrypted rooms detected via `m.room.encryption` state event; messages encrypted via `shareRoomKey` + `encryptRoomEvent` before sending. Encrypted events are decrypted then dispatched by inner type (reactions, redactions, stickers, edits — not just messages). Falls back to "🔒 Encrypted message" placeholder if decryption fails.
- **Key backup restore** — SSSS recovery key (base58) → decrypt backup key → download all sessions from `/room_keys/keys` → `importExportedRoomKeys` into OlmMachine. Also imports cross-signing private keys from SSSS and self-signs device. UI in AccountModal. Clears cached messages after import to force re-decryption.
- **Cross-signing & device verification** — `bootstrapAndVerifyDevice(password)` creates new cross-signing keys, uploads to server via UIA (`keys/device_signing/upload` with `m.login.password`), self-signs this device, and verifies all other user devices. Required for Beeper bridge to accept encrypted messages. UI in AccountModal ("Verify this device"). IMPORTANT: `bootstrapCrossSigning(true)` overwrites server cross-signing keys — always verify ALL devices after bootstrap, otherwise other devices become untrusted. Cross-signing private keys are NOT persisted across page reloads by OlmMachine's IndexedDB store.
- **Image sending** — paste (Ctrl+V) or file picker. Encrypted rooms: AES-CTR-256 encrypt attachment → upload as `application/octet-stream` → send with `file` field containing key/IV/hash. Caption: `body` = caption text, `filename` = actual filename (bridges use body as caption).
- **Video rendering** — `m.video` messages rendered with `<video>` element (controls, playsInline). Encrypted videos decrypted via same `decryptAttachment` as images. Caption support same as images.
- **Send failure visibility** — local echo shows "Sending..." until sync echo confirms delivery. `sendFailed` field on DbChatMessage shows error in red. Queue retries 3 times before marking failed.
- **Local echo lifecycle** — local echo (ID starts with `~`) kept until server echo arrives via sync (matched by body content). NOT deleted on API success — bridge may reject after Matrix accepts (e.g., untrusted device).
- **Room hard-reload** — right-click a room in the list to clear its cached messages and re-fetch from server.
- **Bridge detection** — auto-detects network from ghost user IDs (`@whatsapp_*` → WA icon). Bridge bot users (`@whatsappbot:*`) filtered from room names and member counts.
- **Pre-rendered room views** — all unread room message lists mounted in DOM (display:none), toggled on selection (same pattern as email ThreadView).
- **Pinned favourites** — rooms tagged `m.favourite` shown as a 4-wide avatar grid at top of chat list, always visible regardless of read state. Unread dot indicator, ring for selected room, fallback to initial letter on broken/missing avatars.
- **Send-then-stay** — sending a message marks room read but keeps it in the sidebar. Room only drops from list when user presses Esc or switches to another room (if the previous room is read and not a favourite).
- **Unread count badges** — `notification_count` from server sync displayed as monochrome text next to timestamp. Incremented locally on new messages from others; cleared on mark-read.
- **Edit/delete diffs** — edits show word-level diffs (red strikethrough for removed, green for added) via `diffWords` from `diff` library. Deleted messages show strikethrough body + "deleted by" label. `originalBody` preserved on first edit; `isDeleted`/`deletedBy` set on redaction.
- **Unread "New" divider** — timestamp-based divider using `lastReadTs`. `backfillLastReadTs()` converts existing `lastReadEventId` to timestamp by looking up message in DB. Called in `ensureMessages` and `preloadAllRooms`.
- **Message preloading** — after Matrix sync, `preloadAllRooms()` fetches latest 20 messages for every unread room into IndexedDB. `ensureMessages()` on room select is a no-op if already cached.
- **Lazy pagination** — older messages paginated on scroll-up (30 per page) via `/messages` API with `prev_batch` token.
- **Local echo** — sent messages appear instantly with local ID (`~timestamp.random`), queued for Matrix API. Live query auto-updates view on DB write.
- **Message grouping** — consecutive messages from same sender grouped (5-min gap threshold)
- **Snooze** — same pattern as email (local timer, re-surfaces when expired). Optimistic UI, DB write in background.
- **Offline queue** — `chatSend`, `chatMarkRead` use same queue system as email (3-retry limit). Immediate flush on enqueue (500ms debounce), same as email.
- **Unread resilience** — existing rooms only re-marked unread when genuinely new messages from others arrive in sync batch. Server `notification_count` only trusted for first-time rooms. Prevents stale bridge notifications (LinkedIn, Slack) from overriding local read state.
- **Name preservation** — on incremental sync (which lacks state events), room names and sender display names are preserved from previous syncs. Sender info gaps filled from cached messages in DB.
- **Cache reset** — Ctrl+click refresh clears messages + sync token, forces full resync. Keeps room records so read/unread state is preserved.

## Compose & Quoting
- **quotedHtml** — original email body stored raw, never passed through Tiptap. Editor HTML + quotedHtml concatenated at send. Preserves complex email HTML.
- **Reply** — Gmail-style `On {date} at {time} {sender} wrote:` + blockquote
- **Forward** — `---------- Forwarded message ---------` + headers + body in `gmail_quote` div
- **Forward attachments** — original non-inline attachments carried over via `loadForwardAttachments`

## Attachments
- Metadata parsed from payload parts during sync, stored on `DbMessage.attachments`
- `hasAttachments` flag on `DbThread` (non-inline only)
- Blob data cached in `attachmentData` table, preloaded after email iframes
- View: file chips with download + preview (images, PDFs). Compose: file picker + drag-and-drop, base64 in store.
- MIME: `multipart/mixed` when attachments, `multipart/alternative` otherwise

## Per-Message Actions
- ⋯ menu on each expanded message: Reply, Reply all, Forward — targets that specific message
- `inbox.replyToMessage` tracks target (falls back to last message for keyboard shortcuts)

## Contacts Autocomplete
- Local-first (mines all addresses from IndexedDB, cached 60s, sorted by recency) + remote (People API, debounced 100ms at 2+ chars)
- Comma-separated multi-recipient, per-token autocomplete, arrow/Enter/Tab/Escape navigation

## Responsive Design
- Desktop (≥768px): split pane (thread list + detail), keyboard-first
- Mobile (<768px): single view, tap to navigate. Swipe right = archive/read, left = snooze. Bottom sheets for modals.

## Key Patterns (Bookmarks / Obsidian Vault)
- **Data source** — 977+ bookmark .md files in `~/sync/brain/root/bookmarks/`, each with YAML frontmatter (title, url, added, archive, description, tags) + optional body
- **Hub REST API** — `GET /bookmarks`, `GET /bookmarks/:filename`, `PUT /bookmarks/:filename`, `DELETE /bookmarks/:filename`, `GET /bookmarks/tags`, `POST /bookmarks/reload`
- **In-memory cache** — Hub parses all .md files on first request, caches in memory. Invalidated on write/delete operations.
- **Hierarchical tags** — Tags use `/` as separator (e.g., `dev/frontend/react`). Tag tree sidebar with expand/collapse. `status/broken` is a special tag with visual indicator.
- **Two modes** — Browse (tag tree + list + detail split pane) and Triage (Tinder-style card-by-card review with keep/skip/delete)
- **Tag editing** — Add/remove tags with autocomplete from all existing tags. Changes saved immediately to vault .md file via PUT.
- **Vault path** — Configurable via `--bookmarks` flag on server (default: `~/sync/brain/root/bookmarks`)
- **No IndexedDB** — Bookmarks fetched fresh from server on tab activation. Vault is the source of truth.
- **iframe preview** — Detail and triage views embed bookmark URL in sandboxed iframe. Persistent iframe pool (up to 20) keeps loaded iframes alive — navigation between visited bookmarks is instant CSS `display` toggle. Preloads 2 ahead for smooth j/k navigation.

## Key Patterns (Notes / Vault Editor)
- **Dual adapter** — Primary: File System Access API (Chrome/Edge, true offline, no server). Fallback: Hub REST API (`/notes/*` endpoints). Both implement `VaultAdapter` interface (including `readFileBinary`/`writeFileBinary` for images). FSA handle persisted in IndexedDB for session reuse.
- **CodeMirror 6** — Full markdown editor with vim mode (`@replit/codemirror-vim`), syntax highlighting, line numbers, code folding, line wrapping. NOT Tiptap — CM6 keeps markdown as source of truth.
- **YAML frontmatter** — `yamlFrontmatter({ content: markdown() })` from `@codemirror/lang-yaml` wraps the document so frontmatter is parsed as proper YAML. Live preview renders frontmatter as an Obsidian-style Properties panel (key-value rows with icons, boolean checkboxes, tag pills). Cursor entering the frontmatter reveals raw YAML.
- **Live preview** — Custom `ViewPlugin` walks lezer syntax tree, creates `Decoration.replace`/`.mark`/`.widget` to render markdown inline (headings, bold, links, images, code blocks, wiki-links `[[page]]`, wiki image embeds `![[image.png]]`, checkboxes). **Cursor-aware**: decorations removed on the cursor's line to reveal raw markdown syntax.
- **Image support** — Vault-relative image paths resolved to blob URLs via FSA adapter. Both `![alt](path)` and `![[image.png]]` wiki embeds supported. Async loading with placeholder. Blob URL cache prevents re-loading. `Ctrl+V` paste saves images to `assets/images/` in the vault and inserts markdown at cursor.
- **Vim ex commands** — `:w` save, `:q` close (warns if dirty), `:q!` force close, `:wq` save and close. Registered via `Vim.defineEx()`.
- **No auto-save** — Explicit save only (`Ctrl+S` or `:w`). Dirty state = `content !== savedContent`. Dot indicator on tab for unsaved changes.
- **Multi-file tabs** — Multiple files open simultaneously. Tab bar with dirty indicators and close buttons. `gt`/`gT` (vim) or `Ctrl+Tab` to cycle. Open tabs + active tab persisted in localStorage across page refreshes.
- **File tree sidebar** — Recursive tree view of vault directories. Expand/collapse (top-level auto-expanded on load), directories first, alphabetical sort. Click to open file. New files default to `scratch/` directory.
- **Quick Switcher** — `Ctrl+P` or `/` opens fuzzy file finder (fzf-for-js). `Ctrl+Shift+F` opens in content search mode. `Tab` toggles between filename and full-text modes. Content results show highlighted snippets.
- **Full-text search** — MiniSearch inverted index built on vault load. Prefix + fuzzy matching across file contents. Updated incrementally on save. Integrated into Quick Switcher as "Content" tab.
- **Vault path** — FSA: user picks directory via `showDirectoryPicker()`. Hub fallback: `--notes` CLI flag (default: `~/sync/brain/root`).
- **Skip directories** — `.obsidian`, `.trash`, `bookmarks`, `bookmarks-meta`, `.git`, `node_modules`, hidden files (`.`-prefixed) excluded from file listing.

## Key Patterns (Feeds / RSS Reader)
- **Server-side fetching** — CORS prevents browser-side RSS fetching. Server fetches and parses RSS/Atom feeds using `rss-parser`.
- **Offline reading** — All article content cached in IndexedDB (`feedItems` table). Fully readable offline.
- **Read state** — Read item IDs stored on server (`feed-read.json`) for cross-device sync. Client mirrors in IndexedDB (`feedRead` table). An item is unread if it exists but is NOT in the read set. Read set pruned automatically: items that fall off feeds are removed during sync. Bounded by "items currently in feeds that have been read".
- **OPML import/export** — Import subscriptions from any feed reader. Export for backup. Parsed via `fast-xml-parser`.
- **Folder grouping** — Feeds organized into folders (from OPML or manual). Folder tree in sidebar with aggregate unread counts.
- **Inbox-zero semantics** — `showUnreadOnly` defaults to true. `e` marks read + auto-advances. `E` marks entire feed read.
- **Hub API** — `GET /feeds`, `POST /feeds`, `DELETE /feeds/:id`, `GET /feeds/items?since=ISO`, `GET/PUT /feeds/unread`, `POST /feeds/import-opml`
- **Retention** — 50 items per feed max in IndexedDB (~8500 total for 170 feeds). Trimmed after each sync.
- **Periodic refresh** — 15-minute interval via `useSync.ts`. Manual refresh via header button. Ctrl+click for full re-fetch.
- **Full-text fetching** — Per-feed `fullText` flag. When enabled, server fetches each article URL and extracts content via `@mozilla/readability` + `linkedom` (same as Firefox Reader View). Batched (5 concurrent), 10s timeout. Falls back to RSS content for JS-rendered SPAs.
- **Feed config** — Stored in `~/.config/console/feeds.json` (subscriptions) and `feed-read.json` (read set). Configurable via `--feeds` server flag.

## Key Patterns (Calendar / Google Calendar)
- **Google Calendar API** — Direct REST API from browser, same pattern as Gmail. `src/calendar/api.ts` wraps `calendar/v3` endpoints with Bearer token and auto-refresh on 401. All API calls take `accountEmail` to route through the correct account's token.
- **Multi-account** — `src/calendar/accounts.ts` manages OAuth tokens for multiple Google accounts. Primary Gmail account delegates to `gmail/auth.ts`, additional accounts get their own tokens (localStorage + IDB). "Add calendar account" button in sidebar opens Google OAuth popup.
- **Calendar deduplication** — Shared calendars (e.g. Artanis subscribed on Gmail) display under the primary account but API calls use the owning account's token (`apiAccountEmail`). Best API account determined by: calendar ID matches account email (owner), then highest access role.
- **Week/Day view** — Custom-built time grid (no calendar library). 48px per hour, Monday-start weeks. Column-assignment overlap layout (events stack vertically when non-overlapping, side-by-side only when concurrent). All-day events as spanning rectangles. Current time red indicator line.
- **Event merging** — Duplicate events across visible calendars (same summary + start + end) merge into one block with multi-colored left stripes (one per calendar). User's own copy (calendarId matches account email) drives the block color, popover data, and RSVP.
- **Working location** — Dedicated row with MapPin icon above all-day bar. Location events (`eventType: 'workingLocation'`) rendered as subtle text labels. Click to open location picker (Home/Office/Custom). Updates use delete + create strategy (Google rejects PATCH on recurring working location instances).
- **Recurring events** — Drag-move or resize shows a dialog: "This event" (patches the instance) or "All events" (patches the master recurring event). Old→new time shown with strikethrough.
- **Google Tasks** — Events with `tasks.google.com/task/` in description detected as tasks, shown with empty checkbox icon (☐) before the title.
- **Unaccepted events** — Events where the user hasn't accepted render with dashed border and transparent background. Accepted events have solid fill.
- **Muted colors** — Google Calendar colors darkened for dark mode: dark background with colored left stripe, brighter text. `muteColor()` function.
- **Full CRUD** — Create (drag on empty slot or `c` key), edit (popover → Edit), delete (popover → Delete), RSVP (Accept/Maybe/Decline). All mutations go to Google Calendar API with optimistic IDB updates.
- **Drag interactions** — Drag-to-create (draw duration on empty slot), drag-to-move (reposition events), drag-to-resize (bottom edge handle). All snap to 15-minute grid.
- **Offline caching** — Events stored in IndexedDB (`calendarEvents` table, keyed by `accountEmail:calendarId:eventId`). Prefetch -1/+2 weeks for instant navigation. Load from IDB immediately on navigate, API fetch in background.
- **Sync strategy** — On mount: load accounts → fetch calendar list + events. Periodic: 5-minute interval via `useSync.ts`. On navigate: load from IDB first (instant), then background fetch. Ctrl+click refresh = clear IDB + full refetch (also refreshes calendar list for unsubscribed calendars).
- **Event popover** — Click event shows detail popover: title, time, location, video call link, attendees with status dots, RSVP buttons, edit/delete actions, Google Calendar link.
- **Mini month picker** — Sidebar mini calendar for quick date navigation. Click date → navigate to that week/day.
- **Sidebar** — Calendars grouped by account email. Colored checkboxes with eye icon for visibility. RSS icon for imported feeds, person icon for read-only subscribed calendars. "Add calendar account" at bottom.

## Key Patterns (Money / Monzo)
- **Monzo API** — direct REST API at `api.monzo.com`. Hub is token proxy. Confidential OAuth2 client with single-use refresh tokens.
- **Strong Customer Authentication (SCA)** — after OAuth code exchange, token has zero permissions until user approves in Monzo app. Hub polls `/ping/whoami` until `authenticated: true`.
- **90-day transaction limit** — after 5 minutes post-auth, only last 90 days accessible. Full sync fetches ALL history within this window (paginated, 100/request).
- **Server-side cache** — `~/.config/console/monzo-transactions.json` stores all transactions. Source of truth for browsing. Incremental sync fetches new transactions.
- **Amounts in minor units** — all monetary values in pennies (int64). Formatted to pounds only in display layer (`formatAmount`, `formatAmountAbs`).
- **Form-encoded writes** — Monzo API uses `application/x-www-form-urlencoded` for POST/PUT/PATCH (not JSON).
- **Single-use refresh tokens** — each refresh returns a new refresh_token. Must save atomically before using. Mutex prevents concurrent refreshes.
- **Pot operations** — deposit/withdraw require `dedupe_id` for idempotency (generated as UUID). "Added security" pots cannot be withdrawn via API.
- **Webhook** — `transaction.created` event pushed via WebSocket to browser. Exposed at `https://hub.amar.io/money/webhook?secret=xxx` (Caddy proxies only this path). Secret stored in `auth.json.webhookSecret`, auto-generated.
- **3-column layout** — sidebar (balance, pots, categories, spending) | transaction list (grouped by date) | transaction detail (merchant, notes, metadata).
- **Push notifications** — browser `Notification` API fires when app not focused or user is on a different pane. 6 sources: Monzo transactions (merchant logo icon via hub proxy), Matrix messages (avatar icon), new emails (sender + subject), agent approval requests, agent completion (name + duration + cost), calendar reminders (5 min before). Click navigates to correct pane + item. Service worker handles clicks when app backgrounded. Deduped by `tag` (tx/room/thread/event ID). Remote icons proxied through hub (`/proxy/icon?url=`) for Brave/Linux compatibility.
- **Hub security** — hub runs on `localhost:9877`, no auth needed. `hub.amar.io` Caddy config restricts to `POST /money/webhook` only (everything else → 403).
- **Centralized hub access** — `src/hub.ts` provides `getHubUrl()`, `hubFetch()`, `hubFetchRaw()`, `getHubWsUrl()`. All stores use this instead of duplicating. Single localStorage key: `console_hub_url`.

## Key Patterns (Agents / Claude Code)
- **CLI subprocess** — Hub spawns `claude` with `--output-format stream-json --input-format stream-json --permission-prompt-tool stdio --chrome`.
- **NDJSON protocol** — Claude emits one JSON object per stdout line: `system`, `assistant` (text/thinking/tool_use), `user` (tool_result), `result`, `control_request` (tool approval), `stream_event` (deltas)
- **control_request format** — Claude CLI nests fields: `{ type: 'control_request', request_id, request: { subtype, tool_name, input, tool_use_id } }`. NOT flat.
- **control_response format** — Double-nested: `{ type: 'control_response', response: { request_id, response: { behavior: 'allow', updatedInput?: {...} } } }`. The inner `response` matches the SDK's `canUseTool` return type. Regular tools auto-approved; AskUserQuestion forwarded to frontend.
- **AskUserQuestion** — Intercepted via `control_request` where `tool_name === 'AskUserQuestion'`. Hub emits `approval_required` to frontend. Frontend renders interactive UI with options + text input. Answer sent back as `updatedInput: { questions, answers: { "question text": "selected label" } }`.
- **WebSocket relay** — Hub exposes `ws://localhost:9877` (configurable via `--host`), Console frontend connects and exchanges JSON messages. Hub URL stored in localStorage.
- **Auto-approve** — Hub auto-approves all tools except AskUserQuestion (replaces `--dangerously-skip-permissions`). Frontend also has per-session allowlist via "Allow all" button.
- **Streaming** — `text_delta` and `thinking_delta` accumulated in store, flushed on complete message
- **Multi-session** — Hub manages multiple concurrent Claude subprocesses, each with independent state
- **Session persistence** — Manifest file (`~/.claude/console-hub-sessions.json`) saves active sessions on SIGTERM, restores on startup via `--resume`. Deduplicates by `claudeSessionId` to prevent zombie sessions.
- **Session survival** — Frontend remaps session IDs via `claudeSessionId` when server restarts (IDs change). Messages, deltas, and activeSessionId transferred to new IDs.
- **Message replay** — Hub coalesces text/thinking deltas into complete blocks in a per-session `messageLog`. Late-joining clients receive full replay on WebSocket connect.
- **Context usage** — `input_tokens + output_tokens` from result message shown as token counts (e.g. "45k / 1M") with color coding. `total_cost_usd` is cumulative (SET not ADD).
- **Status line** — auto-derived from tool_use events (e.g., "Reading src/App.tsx...", "Running npm test...")
- **Health/discovery** — `GET /health` returns server state; frontend auto-connects on mount, shows setup instructions if server not running
- **Al integration** — Al (personal AI assistant, separate PM2 process at `/home/amar/proj/code/al`) connects to hub via WebSocket at `ws://localhost:9877/al`. Appears as permanently pinned chat (sessionId `'al'`, matched by `id === 'al'`) at top of Agent tab sidebar. Hub's `AlBridge` (`server/src/al-bridge.ts`) translates between Al's protocol (`al_text`, `al_tool_start`, etc.) and existing HubMessage types. Al streams text deltas and tool events in real-time. Message log persisted to `~/.config/console/al-messages.json` (survives hub restarts). Al can delegate to Claude Code agents via `con agent create`.

## Keybindings (vim-style, desktop only)
j/k = navigate, e = done (mail) / read (chat), b = snooze, r = reply, R = reply all, f = forward, c = compose, / = search, ? = help, u = undo, Esc = close/interrupt/deselect (chat: drops read non-favourite rooms from list), Shift+T = dark mode, Cmd+Enter = send, Tab = cycle pane (mail/chat/bookmarks/notes/feeds/calendar/agents)

### Bookmark-specific keybindings
e = keep (triage), d = delete, s = skip (triage), o = open URL, m = toggle triage mode, t = focus tag input, / = search, Esc = clear/deselect/exit triage

### Notes-specific keybindings
j/k = next/prev tab, e = close tab, Ctrl+P = Quick Switcher, Ctrl+Shift+P = command palette, Ctrl+Shift+T = reopen closed tab, Ctrl+K = insert link, [[ = insert wiki link (insert mode), Ctrl+B/I = bold/italic, Ctrl+Shift+X = strikethrough, Ctrl+` = inline code, Ctrl+S = save, Ctrl+N = new note, / = Quick Switcher, vim mode in editor (:w save, :q close, :wq save+close, :link insert link, gt/gT cycle tabs). Right-click files in tree for rename/delete.

### Feed-specific keybindings
j/k = navigate items, e = mark read + advance, E = mark feed read, u = mark unread, o = open in browser, a = add feed, d = delete feed, / = search, Esc = deselect/clear

### Calendar-specific keybindings
h/l or arrows = prev/next week (or day in day view), t = go to today, w = week view, d = day view, c = create event, Esc = close popover/form

### Money-specific keybindings
j/k = navigate transactions, / = search, n = add note, c = cycle category filter, Esc = clear/deselect

### Agent-specific keybindings
y = allow tool, n = deny tool, a = allow all (tool type), Enter = focus prompt, Esc = interrupt

## Testing
- Vitest, 335 tests across 17 files. `fake-indexeddb` for Dexie tests.
- `.claude/settings.json` hook runs `npm test` on every Stop event.
- `npm test` (single run), `npm run test:watch` (watch mode)
- `cd server && npm test` — server tests (102 tests, 5 files)

## Debugging
- **`window.__console`** — dev-only global (from `src/debug.ts`): exposes all Zustand stores, Dexie db, and perf data. Use via browser console or MCP `javascript_tool`.
- **`window.__console.stores.inbox.getState()`** — read any store
- **`window.__console.perf.longTasks`** — array of 50ms+ blocking tasks (PerformanceObserver)
- **`VITE_STRICT_MODE=false`** in `.env` — disables React StrictMode double-renders for profiling
- **`Cache-Control: no-store`** in `vite.config.ts` — prevents stale module caching
- **react-scan** — commented out in `index.html`, causes overhead with large DOM

## PWA
- `public/manifest.json` — `display: "standalone"`, releases browser shortcuts (Ctrl+Shift+T etc.)
- `public/sw.js` — service worker for offline app shell (production only, disabled in dev)
- Install via browser address bar icon or menu
- `beforeunload` handler warns on unsaved notes, open compose, or pending queue

## Commands
- `pm2 start "npm run dev" --name console-dev` — dev server (preferred over bare `npm run dev`)
- `cd server && npm run dev` — Console server (port 9877)
- `npm run build` / `npm run preview` / `npm run deploy`
- `npm test` / `npm run test:watch`
- `npx tsc --noEmit` — type check SPA
- `cd server && npx tsc --noEmit` — type check server
- `cd cli && npx tsc --noEmit` — type check CLI
- `cd functions && npx tsc --noEmit` — type check Workers
- `con help` — CLI help (after `cd cli && npm link`)
- `con <service> <verb> [--flags]` — CLI commands (see below)

## CLI (`con`) — Agent-Accessible Interface
- **Binary:** `con` (installed globally via `cd cli && npm link`)
- **Pattern:** `con <noun> <verb> [args] [--flags]` (e.g., `con mail list --max 10`)
- **Services:** mail, chat, bookmarks, notes, feeds, cal, money, agent, search, auth
- **Aliases:** m=mail, c=chat, b=bookmarks, n=notes, f=feeds, mo=money, a=agent, s=search
- **Output:** JSON envelope `{success,data,metadata}` when piped or `--json`; human-readable tables on TTY
- **Agent mode:** `--agent` flag enables JSON output + no-input + structured errors
- **Self-discovery:** `con capabilities --json` lists all 81 commands with read/write/destructive safety tiers
- **Schema introspection:** `con schema <cmd>` returns JSONSchema for any command (e.g., `con schema mail.list`)
- **Exit codes:** 0=OK, 1=ERROR, 2=USAGE, 3=NOT_FOUND, 4=AUTH_REQUIRED, 5=HUB_UNAVAILABLE, 6=RATE_LIMITED, 7=TIMEOUT
- **Hub dependency:** CLI talks to hub server over HTTP/WebSocket. Hub must be running.
- **Auth:** `con auth login google` opens browser for OAuth. Tokens stored in `~/.config/console/auth.json` (hub-managed).
- **Streaming:** `con agent tail <session-id>` and `con chat tail <room-id>` stream via WebSocket as NDJSON.

### Hub Routes (server-side)
- `/auth/*` — OAuth flow, Matrix login, auth status
- `/mail/*` — Gmail proxy (threads, send, attachments, contacts, history, labels)
- `/cal/*` — Calendar proxy (calendars, events, RSVP, location, accounts)
- `/matrix/*` — Matrix proxy (rooms, messages, send, reactions, receipts)
- `/money/*` — Monzo banking (balance, transactions, pots, spending, sync, webhook)
- `/bookmarks/*` — Bookmark CRUD (existing)
- `/feeds/*` — Feed CRUD + items (existing)
- `/notes/*` — Notes CRUD (existing)

## Setup
1. Google Cloud project with Gmail API + People API + Google Calendar API v3 enabled
2. OAuth 2.0 credentials (Web application), add `http://localhost:5173` to origins
3. `.env` → `VITE_GOOGLE_CLIENT_ID`; `.dev.vars` → `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`
4. `npm install && npm run dev`
5. For Matrix chat: click "+Chat" in the app header to connect a Matrix account
6. For server features (agents, bookmarks, feeds, CLI): `cd server && npm install && npm run dev`
7. For CLI: `cd cli && npm install && npm link` → `con help`

## UI Actions
- **Refresh** — click for incremental sync, Ctrl+click for full resync (email: clears all data; chat: clears messages + sync token, keeps room read state)
- **Flush** — in sync tooltip, manually process pending queue (both email and chat)
- **Sign out** — click email address in header
- **Per-message menu** — ⋯ on expanded messages for Reply/Reply all/Forward
- **Snoozed toggle** — "N snoozed" link shows snoozed threads above inbox divider
- **Snooze picker** — presets + custom date/time (Monday-first, 24h). Mobile: native datetime-local.
- **Mail/Chat tabs** — in list pane header. "+Chat" shown when Matrix not connected.

## Known Issues
- Matrix E2EE: new device won't have historical Megolm session keys — messages show as "🔒 Encrypted message" until key backup is restored via Account → "Restore encrypted message keys" (recovery key required).
- Matrix E2EE: new device must be verified (Account → "Verify this device" with Matrix password) before Beeper bridge will accept encrypted messages. Key backup restore also auto-imports cross-signing keys and self-signs, but verification via password is more reliable.
- Matrix E2EE: `bootstrapCrossSigning` private keys are NOT persisted by OlmMachine across page reloads. If bootstrap runs but the page reloads before all devices are verified, the keys are lost and bootstrap must run again.
- WASM binary is ~5.6MB (1.8MB gzipped) — loaded lazily only when Matrix is connected
- Bridge rooms (LinkedIn, Slack) may have stale `notification_count` from server — mitigated by only trusting server counts for first-time rooms, not existing rooms.
- WASM `UserId` objects are consumed by each call — must create fresh instances per WASM API call (e.g., `updateTrackedUsers` and `getMissingSessions` need separate `new UserId()` calls).
- `shareRoomKeys`: bridge servers (Beeper) may reject key claims for bridge devices — `claimFailed` flag skips `shareRoomKey` to prevent WASM panic ("Session wasn't created nor shared").
