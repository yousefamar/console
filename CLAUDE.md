# Console — Bespoke Command Center

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
      BootReceiver.kt   — restarts PushService after reboot / app upgrade
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
- `android/scripts/build-debug.sh` — build debug APK → `android/app/build/outputs/apk/debug/app-debug.apk`
- `android/scripts/generate-keystore.sh` — one-time, create `~/.config/console/console-release.jks` (back it up!)
- `android/scripts/build-release.sh` — build signed release, copy to `~/.config/console/apk/`, write `latest.json` (reads `~/.config/console/apk-release.env` for passwords)
- Install on phone: `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`
- The APK loads `https://amarhp-lin.rya-yo.ts.net:5173/` directly — HMR works. Tailscale must be up on the phone.
- Web side: `isNative()` (from `src/platform.ts`) detects `window.__isConsoleAPK`. Used by `src/gmail/auth.ts` (passes `?callback=app` so hub redirects OAuth to `console://auth/done`) and `src/main.tsx` (requests `navigator.storage.persist()`).
- Remote debugging: `chrome://inspect` on the laptop while phone is USB-connected (debug builds only; `setWebContentsDebuggingEnabled(BuildConfig.DEBUG)`). The embedded debug agent also works — APK events show in `/debug/log` with UA containing `ConsoleAPK/...`.
- Push notifications: `PushService` opens a persistent WebSocket to `/push` and posts system notifications even when the WebView is backgrounded. Server sources call `pushServer.broadcast({ type, title, body, pane, id })`. Wired today: Monzo webhook (`money` channel), agent `AskUserQuestion` / `ExitPlanMode` (`agent` channel), Gmail new mail (`mail/sync.ts` — fires on `messagesAdded` deltas), Matrix room messages (`matrix/sync.ts` — fires on timeline events in rooms with notifications on), Calendar per-event reminders (`cal/sync.ts` — 30s ticker scans upcoming events, fires on `reminders.overrides` minutes-before-start with a 60s slack window, dedupes via persisted `fired` map). CLI/webhooks can emit via `POST /push/send`. Check connected clients: `curl -sk https://localhost:9877/push/status`.

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
- `/push` (WebSocket), `POST /push/send`, `GET /push/status` — push notification channel consumed by the APK's PushService

## Known Issues
- Matrix E2EE: new device needs key backup restore (Settings → recovery key) before old messages decrypt
- Matrix E2EE: device verification required before Beeper bridge accepts encrypted messages
- `bootstrapCrossSigning` overwrites server keys — always restore keys FIRST, then verify device
- WASM `UserId` objects consumed per call — create fresh instances each time
