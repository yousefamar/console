# Console — Bespoke Command Center

## What is this?
A personal command center: offline-first Gmail inbox + Matrix chat + Obsidian bookmark browser + Claude Code agent sessions, unified under inbox-zero. Every email is triaged (archived, snoozed, or replied to). Every chat with unread messages appears until responded to or marked read. Bookmarks are browsed, searched, and triaged (keep/delete/tag). Agent sessions run Claude Code from the browser via a local hub server. No labels, no folders — just fast triage.

## Architecture
- **Pure web app (PWA-ready)** — works in any browser, including mobile
- **Offline-first** — all mutations happen locally first, sync when online
- **Stateless post-sync** — app state derived from synced data + local queue
- **Cloudflare Pages** — SPA from CDN + two Pages Functions for OAuth token exchange/refresh
- **No backend** — Gmail API + People API + Matrix CS API directly from browser; Cloudflare Worker only holds `client_secret` for OAuth

## Tech Stack
React 19, TypeScript, Vite, Zustand, Dexie.js (IndexedDB), Tiptap 3 + tiptap-markdown, DOMPurify, Tailwind CSS 3, Lucide React, Vitest, Cloudflare Pages + Wrangler, @matrix-org/matrix-sdk-crypto-wasm (E2EE), diff (word-level diffs for message edits)

## Project Structure
```
src/
  main.tsx, App.tsx, index.css
  __tests__/           — Vitest tests (296 tests, 15 files)
  db/
    index.ts           — Dexie v4: threads, messages, attachmentData, chatRooms, chatMessages, queue, meta
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
    ui.ts              — Modals, dark mode, sync status, active pane (email/chat/bookmarks/agents)
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
    ComposeEditor.tsx, ContactAutocomplete.tsx, AttachmentBar.tsx, CalendarEventCard.tsx
    DateTimePicker.tsx, SearchOverlay.tsx, SnoozePicker.tsx, KeybindingHelp.tsx
    EmailFrame.tsx, SyncStatus.tsx, InboxZero.tsx, UndoToast.tsx, AuthScreen.tsx
  utils/
    email.ts, email-cache.ts, attachment-cache.ts, date.ts, html.ts
agent-hub/               — Local Node.js server for Claude Code agent integration
  src/
    index.ts             — HTTP + WebSocket server (Hono-less, native Node)
    session.ts           — Claude CLI subprocess manager (spawn, stdin/stdout NDJSON)
    bookmarks.ts         — Bookmark file parser, in-memory cache, CRUD operations
    protocol.ts          — Shared types: ClientMessage, HubMessage, Claude NDJSON protocol
    __tests__/           — Session, protocol, bookmarks tests (84 tests)
functions/             — Cloudflare Pages Functions: api/auth/exchange.ts, api/auth/refresh.ts
docs/
  agent-architecture.md  — Full agent system documentation
```

## Design System
- Tokens in `tailwind.config.ts` (spacing, typography, animations) + `src/index.css` (CSS custom properties)
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
- **Vault path** — Configurable via `--bookmarks` flag on hub (default: `~/sync/brain/root/bookmarks`)
- **No IndexedDB** — Bookmarks fetched fresh from hub on tab activation. Vault is the source of truth.
- **iframe preview** — Detail and triage views embed bookmark URL in sandboxed iframe

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
- **Session survival** — Frontend remaps session IDs via `claudeSessionId` when hub restarts (IDs change). Messages, deltas, and activeSessionId transferred to new IDs.
- **Message replay** — Hub coalesces text/thinking deltas into complete blocks in a per-session `messageLog`. Late-joining clients receive full replay on WebSocket connect.
- **Context usage** — `input_tokens + output_tokens` from result message shown as token counts (e.g. "45k / 1M") with color coding. `total_cost_usd` is cumulative (SET not ADD).
- **Status line** — auto-derived from tool_use events (e.g., "Reading src/App.tsx...", "Running npm test...")
- **Health/discovery** — `GET /health` returns hub state; frontend auto-connects on mount, shows setup instructions if hub not running

## Keybindings (vim-style, desktop only)
j/k = navigate, e = done (mail) / read (chat), b = snooze, r = reply, R = reply all, f = forward, c = compose, / = search, ? = help, u = undo, Esc = close/interrupt/deselect (chat: drops read non-favourite rooms from list), Shift+T = dark mode, Cmd+Enter = send, Tab = cycle pane (mail/chat/bookmarks/agents)

### Bookmark-specific keybindings
e = keep (triage), d = delete, s = skip (triage), o = open URL, m = toggle triage mode, t = focus tag input, / = search, Esc = clear/deselect/exit triage

### Agent-specific keybindings
y = allow tool, n = deny tool, a = allow all (tool type), Enter = focus prompt, Esc = interrupt

## Testing
- Vitest, 245 tests across 13 files. `fake-indexeddb` for Dexie tests.
- `.claude/settings.json` hook runs `npm test` on every Stop event.
- `npm test` (single run), `npm run test:watch` (watch mode)
- `cd agent-hub && npm test` — hub tests (84 tests, 4 files)

## Commands
- `npm run dev` — Vite + Cloudflare Functions (port 5173, proxies /api/* to 8788)
- `cd agent-hub && npm run dev` — Agent hub server (port 9877)
- `npm run build` / `npm run preview` / `npm run deploy`
- `npm test` / `npm run test:watch`
- `npx tsc --noEmit` — type check SPA
- `cd agent-hub && npx tsc --noEmit` — type check hub
- `cd functions && npx tsc --noEmit` — type check Workers

## Setup
1. Google Cloud project with Gmail API + People API enabled
2. OAuth 2.0 credentials (Web application), add `http://localhost:5173` to origins
3. `.env` → `VITE_GOOGLE_CLIENT_ID`; `.dev.vars` → `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`
4. `npm install && npm run dev`
5. For Matrix chat: click "+Chat" in the app header to connect a Matrix account
6. For agent sessions: `cd agent-hub && npm install && npm run dev` — then click "Agents" tab in the app

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
