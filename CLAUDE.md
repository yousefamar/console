# Console — Bespoke Command Center

## What is this?
A personal command center, starting with an offline-first Gmail inbox client. Inspired by Inbox by Gmail's inbox-zero philosophy: every email is triaged (archived, snoozed, or replied to). No labels, no folders, no categories, no delete — just fast triage.

## Architecture
- **Pure web app (PWA-ready)** — works in any browser, including mobile
- **Offline-first** — all mutations happen locally first, sync to Gmail when online
- **Stateless post-sync** — app state is derived from synced data + local queue
- **Cloudflare Pages** — SPA served from CDN + two Pages Functions for OAuth token exchange/refresh
- **No traditional backend** — Gmail API + People API directly from browser; Cloudflare Worker only holds `client_secret` for OAuth code exchange

## Tech Stack
- React 19 + TypeScript + Vite
- Zustand (state management)
- Dexie.js (IndexedDB wrapper for local storage)
- Tiptap 3 + tiptap-markdown (Obsidian-style live markdown compose)
- DOMPurify (safe email HTML rendering)
- Tailwind CSS 3 (styling, all tokens in tailwind.config.ts)
- Lucide React (icons)
- Vitest (testing)
- Cloudflare Pages + Pages Functions (hosting + OAuth backend)
- Wrangler (Cloudflare dev/deploy CLI)

## Project Structure
```
src/
  main.tsx            — Entry point
  App.tsx             — Auth gate + main app shell
  index.css           — CSS variables (design tokens) + base styles
  __tests__/          — Vitest tests for utils, queue, etc.
  db/                 — Dexie database schema (v3) + offline mutation queue
    index.ts          — Dexie DB (threads, messages, attachmentData, queue, meta)
    sync-queue.ts     — Offline mutation queue with immediate flush on enqueue
  gmail/              — Gmail API client, OAuth auth, sync engine
    types.ts          — All TypeScript types (DB + API, incl. AttachmentMeta, DbAttachmentData)
    auth.ts           — Google OAuth2 authorization code flow (access token in localStorage, refresh token in IndexedDB)
    api.ts            — Gmail REST API + People API wrapper (contacts search, attachment fetch)
    sync.ts           — Full + incremental sync, queue processing, snooze checks
  store/              — Zustand stores
    inbox.ts          — Thread list, selection, triage actions, per-message reply targeting
    compose.ts        — Compose/reply state, file attachments (base64), quotedHtml
    ui.ts             — UI state (modals, dark mode, sync status)
  hooks/              — React hooks
    useKeybindings.ts — Global vim-style keyboard shortcuts
    useSync.ts        — Sync loop + live queries + three-phase preload chain
    useMediaQuery.ts  — Responsive breakpoint detection
    useSwipeActions.ts — Mobile swipe gesture handler
  components/         — All UI components
    ContactAutocomplete.tsx — Email autocomplete (local DB + People API, sorted by recency)
    AttachmentBar.tsx — Attachment display with download/preview (images, PDFs)
    ComposeEditor.tsx — Tiptap compose with attachments, drag-and-drop, forward carry-over
    CalendarEventCard.tsx — Inline calendar invite rendering (parsed from ICS)
    DateTimePicker.tsx — Custom date/time picker (Monday-first, 24h)
    MessageView.tsx   — Single message with per-message reply/fwd menu (⋯ button)
    ThreadView.tsx    — All thread messages + compose, supports replyToMessage targeting
  utils/              — Email parsing, date formatting, shared helpers
    email.ts          — Parse emails, extract attachments, build MIME (multipart/mixed for attachments)
    email-cache.ts    — Pre-built blob URLs for email iframes with CID inline image resolution
    attachment-cache.ts — Attachment blob cache (IndexedDB), preload, eviction on archive
    date.ts           — Relative time (past + future), date formatting, snooze time calculation
    html.ts           — Shared HTML entity decoding (decodeEntities)
functions/            — Cloudflare Pages Functions (OAuth backend)
  api/auth/
    exchange.ts       — POST /api/auth/exchange — code-for-tokens swap
    refresh.ts        — POST /api/auth/refresh — refresh token for new access token
  tsconfig.json       — Separate TS config for Workers runtime
wrangler.jsonc        — Cloudflare Pages config
.dev.vars             — Local secrets for Cloudflare dev (gitignored)
.claude/
  settings.json       — Claude Code hooks (runs tests on Stop)
```

## Design System
- **All design tokens live in two places:** `tailwind.config.ts` (spacing, typography, animations) and `src/index.css` (CSS custom properties for colors)
- **Dark mode:** Toggle via `dark` class on `<html>`. Email iframes have a separate dark mode toggle.
- **Email dark mode:** Uses CSS `filter: invert(1) hue-rotate(180deg)` injected via DOM (no iframe reload). Forces `color-scheme: only light` via meta tag so emails always render light variant before inversion.
- **Philosophy:** Dense, monochrome, minimal. Sharp corners. System fonts. 100ms max transitions.

## Key Patterns
- **Optimistic mutations:** All triage actions (archive, snooze) update local state immediately, then queue for Gmail sync
- **Immediate queue flush:** When actions are enqueued, processQueue fires within 500ms (debounced). No waiting for next sync interval.
- **No delete:** User never deletes emails. Only archive (done) and snooze.
- **Auto-archive on send:** Replying/forwarding auto-archives the thread (inbox-zero: dealt with = done). Undo available for 5s.
- **Undo:** 5-second toast with undo for archive. Undo removes pending archive from queue and enqueues unarchive.
- **Conflict detection:** Before sending a queued reply, check if new messages arrived in the thread.
- **Sync race protection:** Incremental sync won't remove threads that have pending unarchive/unsnooze in the queue.
- **Tinder UX:** After archiving/snoozing, the next thread auto-selects
- **Pre-rendered iframes:** All email iframes for all inbox threads are mounted in DOM (display:none for non-selected). Switching threads is instant CSS toggle.
- **CID inline images:** Resolved during email preload by fetching attachment data and replacing cid: URLs with blob URLs.
- **Email iframe dark toggle:** Injects/removes style element via contentDocument — no iframe reload on toggle.
- **Three-phase preload:** sync → email iframes (with CID) → attachment data. Each yields between items.
- **Attachment eviction:** Cached attachment blobs evicted from IndexedDB on archive to keep storage lean.
- **Auth code flow:** Uses Google's `initCodeClient` (popup mode) to get an authorization code, exchanged for access + refresh tokens via Cloudflare Pages Functions backend. Refresh token stored in IndexedDB (`meta` table, key `'refresh_token'`). Access token refreshed silently via `/api/auth/refresh` — no popups, no user interaction. Proactive refresh 5 min before expiry via `scheduleTokenRefresh`. On 401, auto-retries with refresh before logging out. Only truly revoked refresh tokens trigger re-auth banner.
- **Snippets:** Gmail API snippets contain HTML entities — decoded via `decodeEntities` in `utils/html.ts` (shared by ThreadListItem and MessageView).
- **Thread labelIds:** Merged from ALL messages in thread (not just latest) so threads show in inbox if any message has INBOX label.
- **Thread sender:** Uses first message (OP) sender, not latest message sender.
- **No drafts:** Drafts are intentionally not supported. This is an inbox-zero tool — compose and send immediately, or snooze and come back later. No half-written replies. See `docs/drafts-architecture.md` for how drafts previously worked.
- **Double-send guard:** `handleSend` in ComposeEditor uses a `sendingRef` to prevent duplicate invocations.
- **Snooze is local-only:** Gmail API has no snooze endpoint. Snooze = archive on Gmail + local timer. `checkSnoozedThreads` in sync loop unarchives threads when snooze expires. Sync preserves snoozed threads: incremental sync checks `snoozedUntil` before deleting non-inbox threads, full sync excludes snoozed from bulk delete, and Ctrl+click resync saves/restores snoozed threads across the clear.
- **Undo re-selects:** After undoing an archive/delete, the restored thread is re-selected and its messages reloaded. Prevents accidentally triaging the wrong thread.
- **Keybinding modifier guard:** Single-key shortcuts (e/b/r/c etc.) ignore Ctrl/Cmd/Alt modifiers to avoid hijacking OS shortcuts like Ctrl+C.
- **Calendar invite parsing:** Inline `text/calendar` parts extracted from `multipart/alternative`, parsed into structured `CalendarEvent` data (ICS parser in `utils/email.ts`), rendered as a card above the email body. Attachments inside `multipart/alternative` are skipped by `getAttachments` to avoid duplicate ICS files.
- **Send-as aliases:** Fetched from Gmail `/settings/sendAs` during full sync, cached in `meta` table. `pickFromAddress` auto-selects the best alias: exact match (alias in To/Cc) → domain match → default. From dropdown shown only when multiple aliases exist, sorted by recency of received email.
- **DRAFT filtering:** Gmail API returns draft messages as part of threads. Sync filters out messages with DRAFT label so they don't appear as regular messages.

## Compose & Quoting
- **quotedHtml pattern:** Original email body is stored raw in `compose.quotedHtml` (never passed through Tiptap). Tiptap editor is only for the user's new text. At send time, editor HTML + quotedHtml are concatenated. This preserves complex email HTML (tables, inline styles, images) that Tiptap's schema would strip.
- **Reply quoting:** Gmail-style `On {date} at {time} {sender} wrote:` + `<blockquote>` with left border containing original body.
- **Forward quoting:** Gmail-style `---------- Forwarded message ---------` + From/Date/Subject/To header block + original body. All wrapped in `<div class="gmail_quote">`.
- **Date format:** Locale-aware date + time joined with "at" to match Gmail's style.
- **Forward attachments:** Original non-inline attachments carried over via `loadForwardAttachments` (Promise.all), batch-added to compose store via `addAttachmentFromData(array)`.

## Attachments
- **Metadata** parsed from message payload parts during sync (`getAttachments` walks payload tree, skips `multipart/alternative` children), stored on `DbMessage.attachments`
- **`hasAttachments`** flag on `DbThread` — paperclip icon in thread list (only counts non-inline attachments)
- **Blob data** cached in `attachmentData` Dexie table (keyed by attachmentId, indexed by messageId), preloaded after email iframes
- **Viewing:** Attachment bar per message with file chips. Download button for all types. Preview (overlay) for images and PDFs using browser native rendering.
- **Composing:** File picker button (Paperclip icon) + drag-and-drop on editor area. Attachment chips with filename, size, and remove (X) button. Files stored as base64 in compose store.
- **Forwarding:** Original message's non-inline attachments automatically carried over via `loadForwardAttachments` (uses Promise.all). Batch-added via `addAttachmentFromData(ComposeAttachment[])`.
- **MIME:** `buildRawEmail` produces `multipart/mixed` when attachments present, `multipart/alternative` otherwise. Header-building extracted into shared `buildHeaders` helper.

## Per-Message Actions
- Each expanded message has a `⋯` (MoreHorizontal) menu button next to the date
- Menu options: Reply, Reply all, Forward — each targets that specific message
- `inbox.replyToMessage` tracks which message is being replied to (falls back to last message for keyboard shortcuts)
- ComposeEditor uses `initRef` guard to prevent duplicate initialization (React strict mode safe)

## Contacts Autocomplete
- To/Cc fields use `ContactAutocomplete` component (uses shared `parseAddressList` from utils/email.ts)
- **Local-first:** Mines all sender/to/cc addresses from IndexedDB messages (cached 60s, sorted by recency)
- **Remote:** Google People API searches saved contacts + "other contacts" (people you've emailed)
- Local results shown instantly, remote results merged in background (debounced 100ms, fires at 2+ chars)
- Supports comma-separated multi-recipient with per-token autocomplete
- Arrow keys navigate, Enter/Tab select, Escape dismiss
- **Completed address skip:** Autocomplete suppressed when token contains `>` (i.e. already a complete `Name <email>` address)

## Responsive Design
- **Desktop (>=768px):** Split pane — narrow thread list (left) + thread view (right). Keyboard-first.
- **Mobile (<768px):** Single view — thread list OR thread detail. Tap thread to view, tap "Console" to go back to list.
- **Mobile swipe:** Swipe right = archive, swipe left = snooze tomorrow. Iframes have pointer-events:none on mobile so swipe captures work.
- **Mobile modals:** Snooze picker and compose are bottom sheets. Search is full-width from top.

## Keybindings (vim-style, desktop only)
j/k = navigate, e = archive, b = snooze, r = reply, R = reply all, f = forward, c = compose, / = search, ? = help, u = undo, Escape = close, Shift+T = toggle dark mode, Cmd+Enter = send

## Testing
- **Framework:** Vitest, configured in `vite.config.ts` with `test.globals: true`
- **Test files:** `src/__tests__/*.test.ts`
- **Coverage (148 tests, 9 files):** email parsing, date utils, attachment helpers, sync queue, compose store, inbox store (thread selection, archive, snooze, send, undo), UI store, Gmail API (with fetch mocking, 401 retry), pickFromAddress (alias selection logic)
- **Dependencies:** `fake-indexeddb` for Dexie-based tests
- **Note:** `sanitizeHtml` tests skipped (DOMPurify needs DOM env). `attachment-cache` functions tested inline (module imports browser-only deps).
- **Claude hook:** `.claude/settings.json` runs `npm test` on every `Stop` event (after Claude finishes responding)
- **Commands:** `npm test` (single run), `npm run test:watch` (watch mode)

## Setup
1. Create a Google Cloud project
2. Enable Gmail API and People API
3. Create OAuth 2.0 credentials (Web application type)
4. Add `http://localhost:5173` to authorized JavaScript origins
5. Copy `.env.example` to `.env` and set `VITE_GOOGLE_CLIENT_ID`
6. Copy `.env.example` comments to `.dev.vars` and set `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (for Cloudflare Functions)
7. `npm install && npm run dev`
8. Sign out by clicking your email address in the header. Sign back in to grant new scopes.

## Deployment (Cloudflare Pages)
1. Connect GitHub repo in Cloudflare dashboard (or use `npm run deploy`)
2. Build command: `npm run build`, output directory: `dist`
3. Set environment secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
4. Add custom domain in Pages settings
5. Push to `main` = production deploy. Other branches = preview deploys.

## Commands
- `npm run dev` — Start Vite + Cloudflare Functions concurrently (Vite on 5173 proxies /api/* to Functions on 8788)
- `npm run build` — Production build
- `npm run preview` — Preview production build locally with functions
- `npm run deploy` — Deploy to Cloudflare Pages
- `npm test` — Run tests
- `npm run test:watch` — Watch mode tests
- `npx tsc --noEmit` — Type check SPA
- `cd functions && npx tsc --noEmit` — Type check Cloudflare Functions

## UI Actions
- **Refresh button** (next to Inbox): Click for incremental sync, Ctrl+click for full cache clear + resync
- **Flush button** (in sync tooltip): Manually process pending queue items
- **Sign out:** Click email address in header
- **Per-message menu:** ⋯ button on each expanded message for Reply/Reply all/Forward targeting that message
- **Snoozed threads toggle:** "N snoozed" / "hide snoozed" link next to Inbox count. Snoozed threads render at top of list as regular items (muted, with clock icon and snooze-until time), separated by an "Inbox" divider.
- **Snooze picker:** Presets (later today, tomorrow, next week) + custom date/time picker. Desktop: inline calendar grid (Monday-first weeks, 24h time). Mobile: native `datetime-local` picker via `showPicker()`.

## Known Issues / Bugs to Fix
None currently tracked.
