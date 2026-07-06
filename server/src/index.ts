#!/usr/bin/env node
// ============================================================================
// Console Server — Local backend for the Console command center
//
// Provides REST APIs for bookmarks, feeds, and notes, plus a WebSocket relay
// for Claude Code agent sessions.
//
// Usage:
//   npx tsx server/src/index.ts [--port 9877] [--cwd /path/to/project]
// ============================================================================

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync, writeFileSync, existsSync, unlinkSync, watch, readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { WebSocketServer, WebSocket } from 'ws'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Session, setAgentModelResolver } from './session.js'
import { ModelConfig } from './model-config.js'
import { AgentRegistry } from './agents/registry.js'
import type { ClientMessage, HubMessage } from './protocol.js'
import { BookmarkStore } from './bookmarks.js'
import { NoteStore } from './notes.js'
import { FeedStore } from './feeds.js'
import { saveManifest, saveManifestSync, loadManifest } from './manifest.js'
import { discoverProjectDirs, listDirectories } from './projects.js'
import { handleBookmarkRoutes } from './routes/bookmarks.js'
import { handleFeedRoutes } from './routes/feeds.js'
import { handleNoteRoutes } from './routes/notes.js'
import { handleBlogRoutes } from './routes/blog.js'
import { handleClientMessage, createSession, loadSessionOrder, loadCollapsedGroups, applyUserModelChange, broadcastModelState, broadcastAgentsList, broadcastTasks, delegateTask, reportTask, runTaskWatchdog, type AgentContext } from './routes/agents.js'
import { TaskStore } from './agents/tasks.js'
import { setLastReadIndex, getLastReadIndex, setReadStateLogger, flushReadState } from './read-state.js'
import { HubCronScheduler } from './cron/scheduler.js'
import { handleCronRoutes } from './routes/cron.js'
import { STT_REALTIME_URL, buildSttHeaders, buildTranscriptionSessionUpdate, translateOpenAiEvent } from './stt.js'
import { AuthStore } from './auth-store.js'
import { handleAuthRoutes } from './routes/auth.js'
import { enforce as enforceHubAuth, authEnforcementActive } from './auth-middleware.js'
import { ensureLocalTokens } from './local-tokens.js'
import { GmailClient } from './gmail-client.js'
import { handleMailRoutes } from './routes/mail.js'
import { CalendarClient } from './calendar-client.js'
import { handleCalendarRoutes } from './routes/calendar.js'
import { MatrixClient } from './matrix-client.js'
import { handleMatrixRoutes } from './routes/matrix.js'
import { AlBridge, AL_SESSION_ID } from './al-bridge.js'
import { MonzoClient } from './monzo-client.js'
import { MonzoStore } from './monzo-store.js'
import { handleMonzoRoutes } from './routes/monzo.js'
import { FinanceStore } from './finance/store.js'
import { handleFinanceRoutes } from './routes/finance.js'
import { PrefsStore } from './prefs-store.js'
import { handleConfigRoutes } from './routes/config.js'
import { DebugLog } from './debug-log.js'
import { handleDebugRoutes, handleDebugClientMessage } from './routes/debug.js'
import { handleApkRoutes } from './routes/apk.js'
import { handleOwntracksRoutes } from './routes/owntracks.js'
import { handleGeocachingRoutes } from './routes/geocaching.js'
import { GeocachingClient } from './geocaching/client.js'
import { handleMeetupRoutes } from './routes/meetup.js'
import { MeetupClient } from './meetup/client.js'
import { handleOutdoorLadsRoutes } from './routes/outdoorlads.js'
import { OutdoorLadsStore } from './outdoorlads.js'
import { handleSpotifyRoutes } from './routes/spotify.js'
import { SpotifyClient } from './spotify/client.js'
import { SpotifyStore } from './spotify/store.js'
import { SpotifyPlayerSync } from './spotify/sync.js'
import { handleMapLayerRoutes } from './routes/map-layers.js'
import { MapLayerStore } from './map-layers/store.js'
import { PushServer } from './push.js'
import { handlePushRoutes } from './routes/push.js'
import { GlassesHub } from './glasses-hub.js'
import { handleGlassesRoutes } from './routes/glasses.js'
import { PenHub } from './pen-hub.js'
import { handlePenRoutes } from './routes/pen.js'
import { handleAlRoutes } from './routes/al.js'
import { ensureAlSession, reloadAlSession, injectToAl, getAlSession, getRecordedAlSessionId } from './al/al-session.js'
import { loadUsers, setUserNotifier, ensureUserKnown, resolveUsername } from './al/users.js'
import * as alWa from './al/whatsapp.js'
import { startDeprecationShim } from './al/shim-18789.js'
import { ServersConfig, CanvasDir } from './dashboard.js'
import { handleDashboardRoutes, handleCanvasRoutes, handleCanvasIslandRoutes, handleCanvasTabRoutes } from './routes/dashboard.js'
import { CanvasPublicTokens } from './canvas-public-tokens.js'
import { handlePublicCanvas } from './routes/public.js'
import { MicState } from './mic.js'
import { handleMicRoutes } from './routes/mic.js'
import { GlassesResearchLog } from './glasses/research-log.js'
import { wireTouchToMic } from './glasses/touch-autowire.js'
import { GlassesConfig } from './glasses/config.js'
import { makeNotifyForwarder } from './glasses/notify-forward.js'
import { wireHud } from './glasses/hud.js'
import { SyncBus } from './sync-bus.js'
import { MailSync } from './mail/sync.js'
import { CalendarSync } from './cal/sync.js'
import { SerpApiClient } from './flights/serpapi.js'
import { WatchlistStore } from './flights/store.js'
import { FlightSync } from './flights/sync.js'
import { handleFlightRoutes } from './routes/flights.js'
import { KeyBackupStore } from './matrix/key-backup-store.js'
import { HubMatrixCrypto } from './matrix/crypto.js'
import { MatrixSync } from './matrix/sync.js'
import { ChatRoomsStore } from './matrix/chat-rooms-store.js'
import { MessageArchive } from './matrix/message-archive.js'
import type { DebugClientMessage } from './debug-protocol.js'

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

const DEFAULT_PORT = 9877
const port = getArg('--port', DEFAULT_PORT)
// Loopback only. Caddy (con.amar.io) is the sole external ingress — it
// reverse-proxies /hub/* and /public/* from :443. Same-host clients (CLI,
// Al, agents) hit 127.0.0.1:9877 directly with a bearer. Override with
// --host 0.0.0.0 only for debugging an emergency where Caddy is down.
const host = getArg('--host', '127.0.0.1')
const cwd = getArg('--cwd', process.cwd())
const bookmarkVault = getArg('--bookmarks', join(homedir(), 'sync', 'brain', 'root', 'bookmarks'))
const notesVault = getArg('--notes', join(homedir(), 'sync', 'brain', 'root'))
const feedsConfigDir = getArg('--feeds', join(homedir(), '.config', 'console'))

// --------------------------------------------------------------------------
// Stores
// --------------------------------------------------------------------------

const bookmarkStore = new BookmarkStore(bookmarkVault)
const noteStore = new NoteStore(notesVault)
const feedStore = new FeedStore(
  join(feedsConfigDir, 'feeds.json'),
  join(feedsConfigDir, 'feed-read.json'),
)
const authStore = new AuthStore()
// Ensure CLI + Al have plaintext bearers on disk before either client tries to
// authenticate. Safe to run on every boot — idempotent and only mints fresh
// tokens when the cached plaintext is gone or no longer validates.
try {
  ensureLocalTokens(authStore)
} catch (err) {
  console.error('[local-tokens] failed to ensure local tokens:', (err as Error)?.message)
}
const debugLog = new DebugLog(join(feedsConfigDir, 'debug.log'))
const debugClients = new Set<WebSocket>()
const gmailClient = new GmailClient(authStore)
const calendarClient = new CalendarClient(authStore)
const matrixClient = new MatrixClient(authStore)
const monzoClient = new MonzoClient(authStore)
const monzoStore = new MonzoStore(
  join(feedsConfigDir, 'monzo-transactions.json'),
  monzoClient,
)
const financeStore = new FinanceStore(feedsConfigDir)
const geocachingClient = new GeocachingClient(authStore, feedsConfigDir)
const meetupClient = new MeetupClient(feedsConfigDir)
const outdoorLadsStore = new OutdoorLadsStore()
const mapLayerStore = new MapLayerStore()
const prefsStore = new PrefsStore(join(feedsConfigDir, 'prefs.json'))
// Runtime agent-model config + fallback chain. Inject the resolver into Session
// NOW, before any session is spawned (restore loop, Al, fresh) so every spawn
// resolves the configured model rather than a hardcoded const.
const modelConfig = new ModelConfig(join(feedsConfigDir, 'agent-model.json'), (m) => log(m))
setAgentModelResolver(() => modelConfig.getModel())
// Durable agent roles / org chart. Loaded before any session spawn so charter
// injection (createSession) can resolve a restored session's role.
const agentRegistry = new AgentRegistry(join(feedsConfigDir, 'agents'), (m) => log(m))
const taskStore = new TaskStore(join(feedsConfigDir, 'agent-tasks.json'), () => Date.now(), (m) => log(m))
const dashboardServers = new ServersConfig(join(feedsConfigDir, 'dashboard-servers.json'))
const canvasDir = new CanvasDir(join(feedsConfigDir, 'canvas'))
const publicCanvasTokens = new CanvasPublicTokens()
const pushServer = new PushServer((msg: string) => { log(msg) })
const glassesResearchLog = new GlassesResearchLog(
  join(feedsConfigDir, 'glasses-research.log'),
)
const glassesHub = new GlassesHub(pushServer, (msg: string) => { log(msg) }, glassesResearchLog)
const glassesConfig = new GlassesConfig(join(feedsConfigDir, 'glasses-config.json'))
// Neo smartpen — same `/push` WS RPC pipe as glasses, single-device, reusing the
// shared research log (frames tagged `arm: 'pen'`). Register the pen inbound
// handler BEFORE glasses: glasses' handleMessage returns true for ANY
// rpc_response (even ids not in its pending map), which would otherwise swallow
// pen's responses; pen returns false on an unknown id so glasses' own responses
// still fall through to it.
const syncBus = new SyncBus((msg: string) => { log(msg) })
const penHub = new PenHub(pushServer, (msg: string) => { log(msg) }, glassesResearchLog, noteStore, syncBus)
pushServer.onInbound((ws, frame) => penHub.handleMessage(ws, frame))
pushServer.onInbound((ws, frame) => glassesHub.handleMessage(ws, frame))
// Auto-arm mic on right long-press (see docs/g1-mic-stt-recipe.md). Subscriber
// lives for the process lifetime; no unsubscribe needed.
wireTouchToMic(glassesHub, (msg: string) => { log(msg) })
setReadStateLogger((m: string) => { log(m) })

// Watch canvas dir + islands subdir as two separate non-recursive watchers
// because fs.watch with `recursive: true` on Linux silently stops firing
// for root-level changes once a subdir event has been delivered.
//
// On any change we debounce ~200ms then:
//  - If the islands set has items, recompose index.html (overrides any
//    direct write to index.html — the islands-mode invariant).
//  - Broadcast `dashboard.canvas_changed` so the SPA iframe live-reloads.
{
  let pending: ReturnType<typeof setTimeout> | null = null
  // Only broadcast when the served index.html actually changed. This kills the
  // flash loop: composeIndexHtml writes index.html → fires the root watcher →
  // re-tick → compose yields identical html → no broadcast. (fs.watch emits ~2
  // events per write, so a one-shot suppression flag wasn't enough.)
  let lastBroadcastHtml = canvasDir.readIndexHtml()
  const schedule = (_source: string, _filename: string | null) => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      // Re-check at tick time, not at event time — event-time hasIslands()
      // can race with the FS write that triggered the event.
      if (canvasDir.hasIslands() || canvasDir.hasTabs()) {
        canvasDir.composeIndexHtml()
      }
      const html = canvasDir.readIndexHtml()
      if (html === lastBroadcastHtml) return // no real change → no reload, no flash
      lastBroadcastHtml = html
      syncBus.broadcast('dashboard', 'canvas_changed', canvasDir.metadata())
    }, 200)
  }
  try {
    watch(canvasDir.dir, { persistent: false }, (_evt, filename) => {
      schedule('root', typeof filename === 'string' ? filename : null)
    })
    log(`[dashboard] watching canvas root: ${canvasDir.dir}`)
  } catch (e) {
    log(`[dashboard] canvas root watch failed: ${(e as Error).message}`)
  }
  try {
    watch(canvasDir.islandsDir, { persistent: false }, (_evt, filename) => {
      schedule('islands', typeof filename === 'string' ? filename : null)
    })
    log(`[dashboard] watching canvas islands: ${canvasDir.islandsDir}`)
  } catch (e) {
    log(`[dashboard] canvas islands watch failed: ${(e as Error).message}`)
  }
  // Tabs watcher — recursive so per-tab content edits trigger a recompose +
  // broadcast. Linux fs.watch recursive can degrade after subdir events, so
  // agents should prefer the POST /dashboard/canvas/tabs API which calls
  // composeIndexHtml() synchronously and lets the root watch broadcast.
  try {
    watch(canvasDir.tabsDir, { persistent: false, recursive: true }, (_evt, filename) => {
      schedule('tabs', typeof filename === 'string' ? filename : null)
    })
    log(`[dashboard] watching canvas tabs: ${canvasDir.tabsDir}`)
  } catch (e) {
    log(`[dashboard] canvas tabs watch failed: ${(e as Error).message}`)
  }
}
const mailSync = new MailSync(
  gmailClient,
  authStore,
  syncBus,
  pushServer,
  join(feedsConfigDir, 'mail-state.json'),
  (msg: string) => { log(msg) },
)
syncBus.register('mail', {
  syncNow: async () => mailSync.syncNow(),
})
mailSync.start()
const calSync = new CalendarSync(
  calendarClient,
  authStore,
  syncBus,
  pushServer,
  join(feedsConfigDir, 'cal-state.json'),
  (msg: string) => { log(msg) },
)
syncBus.register('cal', {
  syncNow: async () => calSync.syncNow(),
})
calSync.start()
const serpApiClient = new SerpApiClient(authStore)
const flightWatchlists = new WatchlistStore(join(feedsConfigDir, 'flight-watchlists.json'))
const flightSync = new FlightSync(serpApiClient, flightWatchlists, pushServer, syncBus, mapLayerStore, (msg: string) => { log(msg) })
flightSync.start()
const keyBackupStore = new KeyBackupStore(
  join(feedsConfigDir, 'matrix-key-backup.json'),
  (msg: string) => { log(msg) },
)
const hubMatrixCrypto = new HubMatrixCrypto(
  join(feedsConfigDir, 'matrix-crypto-snapshot.json'),
  (msg: string) => { log(msg) },
)
// If hub already has Matrix credentials, re-init OlmMachine on boot so
// decryption capability survives restarts without requiring re-login.
// When a snapshot exists it's restored first (fast-path: identity preserved).
// When no snapshot exists (first boot after credentials, or schema-rebuild)
// we still init with the existing device_id; OlmMachine generates fresh Olm
// account keys and re-uploads them, then we re-import the M0 key backup so
// historical room decrypts still work.
{
  const existingMatrix = authStore.getMatrixConfig()
  if (existingMatrix) {
    const snapshotExists = existsSync(join(feedsConfigDir, 'matrix-crypto-snapshot.json'))
    ;(async () => {
      await hubMatrixCrypto.init(existingMatrix.userId, existingMatrix.deviceId)
      if (snapshotExists) {
        log('[hub-crypto] re-initialized from snapshot')
      } else {
        log('[hub-crypto] re-initialized with existing device_id (fresh Olm account)')
        // Re-upload device keys + OTKs under the existing access token.
        await hubMatrixCrypto.processOutgoingRequests(
          existingMatrix.homeserver,
          existingMatrix.accessToken,
        )
        // Re-import M0 safety-net keys so decrypt still works.
        const backup = keyBackupStore.get()
        if (backup && backup.userId === existingMatrix.userId) {
          const r = await hubMatrixCrypto.importRoomKeys(backup.keys)
          log(`[hub-crypto] re-imported ${r.imported}/${r.total} room keys from M0 backup`)
        }
      }
      // Activate server-side key-backup UPLOAD on every boot. Encryption-only
      // path — uses the backup version's public key, so no recovery key
      // needed. Ensures every Megolm session the hub receives from here on
      // flows into /room_keys/keys and survives hub re-login / re-init.
      const act = await hubMatrixCrypto.activateBackupUpload(
        existingMatrix.homeserver,
        existingMatrix.accessToken,
      ).catch((e): { enabled: boolean; version?: string; reason?: string } =>
        ({ enabled: false, reason: (e as Error).message }))
      if (act.enabled) {
        log(`[hub-crypto] backup upload activated (version ${act.version})`)
        // Sweep any pre-existing sessions that weren't uploaded (e.g. keys
        // imported from M0 or received while backup was inactive).
        hubMatrixCrypto.backupPendingRoomKeys(
          existingMatrix.homeserver,
          existingMatrix.accessToken,
        ).then((n) => { if (n > 0) log(`[hub-crypto] backed up ${n} pending room keys`) })
          .catch((e) => log(`[hub-crypto] initial backup sweep failed: ${e}`))
      } else {
        log(`[hub-crypto] backup upload NOT activated: ${act.reason}`)
      }
    })().catch((e) => log(`[hub-crypto] boot init failed: ${e}`))
  }
}
// Hub-owned canonical room snapshot. Every /sync delta is computed here and
// broadcast over the `chat-rooms` SyncBus service; clients drop the result
// straight into their IDB cache instead of running their own derivation. This
// is what gives "mark read on PC → phone sees it immediately" — the hub is
// the source of truth, not each device's local Dexie state.
const chatRoomsStore = new ChatRoomsStore({
  path: join(feedsConfigDir, 'chat-rooms.json'),
  bus: syncBus,
  log: (msg: string) => { log(msg) },
})
// Append-only archive of every decrypted chat event + media rescue on
// redaction. The soft-delete-only guarantee: deletes by any party (incl.
// Yousef) only ever mark content deleted; the original text and attachments
// stay recoverable here. There is deliberately no delete API on this store.
const messageArchive = new MessageArchive(
  join(feedsConfigDir, 'chat-archive'),
  (msg: string) => { log(msg) },
)
// When a push client (the APK) connects, send a reconcile frame so it can
// drop stale chat + mail notifications — anything it's showing that's no
// longer unread. This is the only way to clear notifications orphaned by a
// hub restart (in-memory push tracking is gone) or by a read/archive that
// happened while the phone was offline. The hub sends the KEEP sets (still-
// unread items); the APK cancels its chat/mail notifications not in them,
// leaving point-in-time types (money/flights/calendar/agent) untouched.
//
// chat keep = unread rooms (in-memory store, always reliable). mail keep =
// unread inbox threads per Google account (one Gmail query, cached briefly
// so frequent reconnects don't hammer the API). On a mail-fetch failure the
// `mail` key is OMITTED so the APK never wipes mail notifications on a
// transient error (omitted ⇒ "don't touch mail this round").
const MAIL_RECONCILE_CACHE_MS = 30_000
let mailKeepCache: Array<{ account: string; threadId: string }> | null = null
let mailKeepCacheAt = 0
async function sendNotifReconcile(): Promise<void> {
  let chatKeep: string[] = []
  try {
    const rooms = chatRoomsStore.snapshot().data
    chatKeep = Object.entries(rooms).filter(([, r]) => r.isUnread).map(([id]) => id)
  } catch (err) {
    log(`[push] reconcile: chat keep failed: ${(err as Error).message}`)
  }
  let mailKeep = mailKeepCache
  if (!mailKeep || Date.now() - mailKeepCacheAt > MAIL_RECONCILE_CACHE_MS) {
    try {
      const collected: Array<{ account: string; threadId: string }> = []
      for (const acct of authStore.getGoogleAccounts()) {
        const res = await gmailClient.listThreads({ q: 'in:inbox is:unread', maxResults: '100', account: acct.email })
        for (const t of res.threads ?? []) collected.push({ account: acct.email, threadId: t.id })
      }
      mailKeep = collected
      mailKeepCache = collected
      mailKeepCacheAt = Date.now()
    } catch (err) {
      mailKeep = null // omit mail key → APK leaves mail notifications alone
      log(`[push] reconcile: mail keep fetch failed: ${(err as Error).message}`)
    }
  }
  const frame: Record<string, unknown> = { type: 'notif_reconcile', chat: chatKeep }
  if (mailKeep) frame.mail = mailKeep
  pushServer.broadcastRaw(JSON.stringify(frame))
  log(`[push] reconcile sent: ${chatKeep.length} chat + ${mailKeep ? mailKeep.length : 'skip'} mail keep`)
}
pushServer.onConnect(() => { void sendNotifReconcile() })

// Matrix sync loop — starts once crypto is ready (polled).
const matrixSync = new MatrixSync(
  matrixClient,
  hubMatrixCrypto,
  authStore,
  syncBus,
  pushServer,
  join(feedsConfigDir, 'matrix-sync-state.json'),
  (msg: string) => { log(msg) },
  chatRoomsStore,
  messageArchive,
)
syncBus.register('matrix', {
  syncNow: async () => matrixSync.syncNow(),
  // Point-to-point resume: caller supplies its last-seen `since`; returns the
  // delta directly instead of broadcasting. Without `since`, behaves like the
  // old `snapshot` (cold-start initial sync). Response includes `isInitial`
  // so the client can tell a resume-merge from a cold-start reset.
  resume: async (args) => matrixSync.resume(args as { since?: string } | undefined),
  state: async () => matrixSync.getState(),
  // Unified send: hub picks encrypted vs plaintext based on room state
  sendEvent: async (args) => matrixSync.sendRoomEvent(args as { roomId: string; type: string; content: Record<string, unknown> }),
  redact: async (args) => matrixSync.redactEvent(args as { roomId: string; eventId: string; reason?: string }),
  markRead: async (args) => matrixSync.markRead(args as { roomId: string; eventId: string }),
  paginate: async (args) => matrixSync.paginate(args as { roomId: string; from?: string; dir?: 'b' | 'f'; limit?: number }),
  // Discard the outbound Megolm session for a room so the next send forces
  // a fresh shareRoomKey round — used when a bridge reports FAIL_RETRIABLE.
  rotateRoomKey: async (args) => matrixSync.rotateRoomKey(args as { roomId: string }),
})
// Hub-owned chat-rooms snapshot RPCs. Clients call `snapshot` on first connect
// and after reconnect; every other mutation either flows through here
// (markUnread, snooze) or is shadowed by markRead's optimistic update inside
// MatrixSync. All paths persist + broadcast via SnapshotStore.update.
syncBus.register('chat-rooms', {
  snapshot: async () => chatRoomsStore.snapshot(),
  markRead: async (args) => matrixSync.markRead(args as { roomId: string; eventId: string }),
  markUnread: async (args) => matrixSync.markUnread(args as { roomId: string }),
  snooze: async (args) => matrixSync.snooze(args as { roomId: string; untilMs?: number }),
  // Surgical: re-derive one room's metadata from full state (fixes a single
  // re-link-inflated room without waiting for the boot sweep).
  refreshRoom: async (args) => matrixSync.refreshRoomState(args as { roomId: string }),
  // Manual trigger for the inflated-DM sweep (also runs once per deploy on boot).
  refreshStale: async () => matrixSync.refreshStaleDmRooms(),
  // Archive lookup: the pre-redaction copy of a deleted event (text + media
  // pointer). The SPA calls this when rendering a deleted message so the
  // original content is always viewable — the soft-delete-only guarantee.
  archivedEvent: async (args) => {
    const { roomId, eventId } = args as { roomId: string; eventId: string }
    if (!roomId || !eventId) throw new Error('roomId and eventId required')
    return messageArchive.getEvent(roomId, eventId) ?? null
  },
})
matrixSync.start()

// One-shot sweep (per deploy) to repair DMs whose memberCount got inflated by
// a WhatsApp/Signal re-link transient — incremental sync never re-derives
// member fields, so they stick until a full-state refresh. Gated by a version
// marker file so it runs once after this code ships, not on every restart.
// Delayed so it lands after the first sync tick has populated the snapshot.
{
  const SWEEP_VERSION = 1
  const markerPath = join(feedsConfigDir, 'chat-rooms-sweep.json')
  let lastVersion = 0
  try {
    if (existsSync(markerPath)) lastVersion = (JSON.parse(readFileSync(markerPath, 'utf-8')) as { version?: number }).version ?? 0
  } catch { /* treat as never-run */ }
  if (lastVersion < SWEEP_VERSION) {
    setTimeout(() => {
      void matrixSync.refreshStaleDmRooms()
        .then((r) => {
          log(`[matrix-sync] boot DM sweep: refreshed ${r.refreshed}/${r.scanned}`)
          try { writeFileSync(markerPath, JSON.stringify({ version: SWEEP_VERSION, ranAt: Date.now() })) } catch { /* best effort */ }
        })
        .catch((e) => log(`[matrix-sync] boot DM sweep failed: ${(e as Error).message}`))
    }, 30_000)
  }
}

// Geocaching: client mirrors the hub's geocache store. Snapshot on connect,
// delta (summaries only) on every area fetch.
syncBus.register('geocaching', {
  snapshot: async () => geocachingClient.getSnapshot(),
})
geocachingClient.onChange = (changed) => {
  syncBus.broadcast('geocaching', 'delta', {
    caches: changed.map(({ detail: _detail, ...summary }) => summary),
  })
}

// Meetup events: same mirror shape — snapshot on connect, delta (summaries
// only) on each area fetch. Anonymous web GraphQL scrape; manual fetch only.
syncBus.register('meetup', {
  snapshot: async () => meetupClient.getSnapshot(),
})
meetupClient.onChange = (changed) => {
  syncBus.broadcast('meetup', 'delta', {
    events: changed.map(({ detail: _detail, ...summary }) => summary),
  })
}

// Spotify — the hub is a remote control over the Web API; playback runs on the
// spotifyd Connect device. The poller only hits Spotify while a drawer is open
// (subscriberCount('spotify') > 0); control actions poke a fresh fetch.
const spotifyClient = new SpotifyClient(authStore)
const spotifyStore = new SpotifyStore({
  path: join(feedsConfigDir, 'spotify-player.json'),
  bus: syncBus,
  log: (msg: string) => { log(msg) },
})
const spotifySync = new SpotifyPlayerSync(spotifyClient, spotifyStore, syncBus, (msg: string) => { log(msg) })
syncBus.register('spotify', {
  snapshot: async () => spotifyStore.snapshot(),
  syncNow: async () => spotifySync.syncNow(),
})
spotifySync.start()

// Agent-authored map layers: SyncBus carries only the index; clients fetch each
// layer's GeoJSON over HTTP (layers can be multi-MB).
syncBus.register('map-layers', {
  snapshot: async () => ({ layers: mapLayerStore.list() }),
})
const broadcastLayers = () => syncBus.broadcast('map-layers', 'delta', { layers: mapLayerStore.list() })

function markAlRead() {
  const len = alBridge.getMessageLog().length
  setLastReadIndex(AL_SESSION_ID, len)
  broadcast({ type: 'session_read_state', sessionId: AL_SESSION_ID, lastReadIndex: len, messageLogLength: len })
}

function markAlUnread() {
  const len = alBridge.getMessageLog().length
  const idx = Math.max(0, len - 1)
  setLastReadIndex(AL_SESSION_ID, idx)
  broadcast({ type: 'session_read_state', sessionId: AL_SESSION_ID, lastReadIndex: idx, messageLogLength: len })
}

function broadcast(msg: HubMessage) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }
  // Mirror selected events into the push channel so the APK foreground
  // service can surface them as system notifications when backgrounded.
  if (msg.type === 'approval_required') {
    const toolName = (msg as any).toolName as string | undefined
    const input = (msg as any).input as Record<string, unknown> | undefined
    const question = typeof input?.question === 'string' ? input.question : ''
    pushServer.broadcast({
      type: 'agent',
      title: toolName === 'AskUserQuestion' ? 'Agent needs your input' : 'Agent needs approval',
      body: question || toolName || 'Tap to respond',
      pane: 'agents',
      id: `approval:${(msg as any).requestId ?? (msg as any).sessionId}`,
    })
  } else if (msg.type === 'tool_approved' || msg.type === 'tool_denied') {
    // Dismiss the phone notification once the question is answered —
    // whether from the web app, CLI, or another client.
    const requestId = (msg as any).requestId ?? (msg as any).sessionId
    pushServer.broadcast({
      type: 'agent',
      cancel: true,
      id: `approval:${requestId}`,
    })
  }
}

const alBridge = new AlBridge({
  broadcast,
  broadcastExcept: (sender: WebSocket, msg: HubMessage) => {
    const data = JSON.stringify(msg)
    for (const ws of clients) {
      if (ws !== sender && ws.readyState === WebSocket.OPEN) ws.send(data)
    }
  },
  log,
})

// --------------------------------------------------------------------------
// Session registry
// --------------------------------------------------------------------------

const sessions = new Map<string, Session>()
const clients = new Set<WebSocket>()

const agentCtx: AgentContext = {
  sessions, clients, cwd, log, truncate, modelConfig, agentRegistry, tasks: taskStore,
  // @amar attention → push notification (pane:agents). Dedup/anti-noise gated
  // in Session; this only fires when Session decides `push: true`.
  notifyAttention: (sessionId, name, snippet) => {
    pushServer.broadcast({
      type: 'agent',
      title: `${name} wants your attention`,
      body: snippet || '@amar',
      pane: 'agents',
      id: `attention:${sessionId}`,
    })
  },
  clearAttentionPush: (sessionId) => {
    pushServer.broadcast({ type: 'agent', cancel: true, id: `attention:${sessionId}` })
  },
  // `con agent reload Al` → fresh persona spawn, no hub restart needed.
  reloadAl: () => reloadAlSession(agentCtx),
}

// --------------------------------------------------------------------------
// Push-to-talk mic ownership (see server/src/mic.ts).
// --------------------------------------------------------------------------
const micState = new MicState()

/** Effective owner = explicit owner if it's a live (non-ended) session, else
 *  Al. Returns null only if neither is up. */
function effectiveMicOwnerId(): string | null {
  const explicit = micState.getOwnerSessionId()
  if (explicit) {
    const s = sessions.get(explicit)
    if (s && s.status !== 'ended') return explicit
  }
  return getAlSession()?.id ?? null
}
function micOwnerName(sessionId: string | null): string | undefined {
  if (!sessionId) return undefined
  return sessions.get(sessionId)?.name ?? (sessionId === getAlSession()?.id ? 'Al' : undefined)
}
/** Resolve a session id / name / agentKey to a live session id, or null. */
function resolveMicTarget(target: string): string | null {
  if (sessions.get(target)) return target
  const lower = target.toLowerCase()
  for (const [id, s] of sessions) {
    const info = s.getInfo()
    if (info.name?.toLowerCase() === lower || info.agentKey?.toLowerCase() === lower) return id
  }
  return null
}
/** Inject + auto-send a transcript to a session (mirrors the cron nudge path). */
function injectToSession(sessionId: string, content: string): boolean {
  const s = sessions.get(sessionId)
  if (!s || s.status === 'ended') return false
  const msg = { type: 'user_prompt' as const, sessionId: s.id, content }
  try {
    broadcast(msg)
    s.logMessage(msg)
    s.sendMessage(content)
    return true
  } catch (err) {
    log(`[mic] inject failed: ${(err as Error).message}`)
    return false
  }
}
syncBus.register('mic', {
  status: async () => {
    const owner = effectiveMicOwnerId()
    return { owner, ownerName: micOwnerName(owner), hot: micState.isHot() }
  },
  set: async (args) => {
    const target = (args as { target?: string } | undefined)?.target ?? ''
    const sid = target && target.toLowerCase() !== 'al' && target.toLowerCase() !== 'default'
      ? resolveMicTarget(target) : null
    micState.setOwnerSessionId(sid)
    const owner = effectiveMicOwnerId()
    return { ok: true, owner, ownerName: micOwnerName(owner) }
  },
})
micState.onChange(() => {
  const owner = effectiveMicOwnerId()
  syncBus.broadcast('mic', 'state', { owner, ownerName: micOwnerName(owner), hot: micState.isHot() })
})

// Live org-chart updates when an agent edits its own role file. Content-compared
// inside the registry so the hub's own writes don't re-fire.
agentRegistry.watch(() => broadcastAgentsList(agentCtx))

const cronScheduler = new HubCronScheduler(
  join(feedsConfigDir, 'agent-cron.json'),
  () => sessions,
  (msg) => broadcast(msg),
  (m) => log(m),
)
cronScheduler.start()

// Delegation watchdog: nudge stalled in-progress tasks, eventually bubble a
// stall report. 5-min cadence (the staleness threshold inside is 15 min).
setInterval(() => { try { runTaskWatchdog(agentCtx) } catch (e) { log(`[tasks] watchdog: ${(e as Error).message}`) } }, 5 * 60_000)

// Wire Al session updates to broadcast full session list
alBridge.onSessionUpdate = () => {
  const active = Array.from(sessions.values()).map((s) => s.getInfo())
  if (alBridge.isConnected()) active.unshift(alBridge.getSessionInfo())
  const listMsg: HubMessage = { type: 'sessions_list', sessions: active }
  const data = JSON.stringify(listMsg)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }
}

// --------------------------------------------------------------------------
// Glasses: notification forwarding + idle HUD on head-tilt
// --------------------------------------------------------------------------

// Every hub push also fans out to the G1 lenses as a native 0x4B card, gated
// by GlassesConfig + the global DnD pref (the same flag the SPA toggles).
pushServer.onBroadcast(makeNotifyForwarder({
  hub: glassesHub,
  config: glassesConfig,
  isDnd: () => prefsStore.getAll().dnd === true,
  log: (m: string) => log(m),
}))

// HUD data: chat unread (chat-rooms store), agent alerts (sessions needing
// attention), mail unread (Gmail labels, cached), next event (cal sync), and
// batteries (latest glasses snapshot + phone battery rider).
let mailUnreadCached = 0
const refreshMailUnread = () => {
  mailSync.getInboxUnreadCount().then((n) => { mailUnreadCached = n }).catch(() => {})
}
refreshMailUnread()
setInterval(refreshMailUnread, 60_000)

wireHud(glassesHub, glassesConfig, {
  battery: () => {
    const { state } = glassesHub.getCachedState()
    const arms = [state?.left.battery, state?.right.battery].filter((b): b is number => typeof b === 'number')
    return arms.length ? Math.min(...arms) : null
  },
  mail: () => ({ count: mailUnreadCached, text: mailSync.getLatestSubject() }),
  chat: () => {
    const unread = Object.values(chatRoomsStore.snapshot().data)
      .filter((r) => r.isUnread && !r.isMuted && !r.isLowPriority)
      .sort((a, b) => b.lastMessageTime - a.lastMessageTime)
    const top = unread[0]
    const text = top ? `${top.lastMessageSender ? top.lastMessageSender + ': ' : ''}${top.lastMessageBody ?? ''}` : ''
    return { count: unread.length, text }
  },
  agents: () => {
    const att = Array.from(sessions.values()).map((s) => s.getInfo()).filter((i) => !!i.needsAttention)
      .sort((a, b) => (b.needsAttention?.ts ?? 0) - (a.needsAttention?.ts ?? 0))
    const top = att[0]
    const text = top ? `${top.name ? top.name + ': ' : ''}${top.needsAttention?.snippet ?? ''}` : ''
    return { count: att.length, text }
  },
}, (m: string) => log(m))

// --------------------------------------------------------------------------
// HTTP/HTTPS server
// --------------------------------------------------------------------------

// Hub TLS: any `*.crt` / matching `*.key` pair in the config dir is good
// enough. Caddy in front terminates real TLS for con.amar.io; the only
// reason the hub still speaks TLS internally is so the Caddy upstream
// transport stays consistent. Without a cert pair we fall back to plain
// HTTP and Caddy uses `transport http` without `tls_insecure_skip_verify`.
const configDir = join(homedir(), '.config', 'console')
const certCandidates = (() => {
  try {
    return readdirSync(configDir)
      .filter((n) => n.endsWith('.crt') && existsSync(join(configDir, n.replace(/\.crt$/, '.key'))))
      .map((n) => ({ cert: join(configDir, n), key: join(configDir, n.replace(/\.crt$/, '.key')) }))
  } catch { return [] }
})()
const tlsOpts = certCandidates[0]
  ? { cert: readFileSync(certCandidates[0].cert), key: readFileSync(certCandidates[0].key) }
  : null

// Browser-origin allow-list. SPA is reached via Caddy on con.amar.io and is
// same-origin with /hub/* — so CORS only matters for legacy cross-origin
// access. Production is single-origin under con.amar.io.
const ALLOWED_ORIGINS = new Set([
  'https://con.amar.io',
  'https://localhost:5173',
  'http://localhost:5173',
])

function originAllowed(origin: string | undefined): boolean {
  return !!origin && ALLOWED_ORIGINS.has(origin)
}

const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
  const origin = req.headers.origin
  if (originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin!)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // Hub auth gate. In log-only mode (default) this always allows, but logs
  // any decision that enforcement WOULD have rejected so we can verify the
  // model before flipping CONSOLE_AUTH_ENABLED=1. Wrapped in try/catch so a
  // middleware bug can't ever break the request path.
  try {
    const decision = enforceHubAuth(req, authStore)
    if (!decision.allow) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (decision.challenge) headers['WWW-Authenticate'] = 'ConsoleSession'
      res.writeHead(401, headers)
      res.end(JSON.stringify({ error: 'unauthorized', reason: decision.reason ?? null }))
      return
    }
  } catch (err) {
    console.error('[auth] middleware exception (forcing allow):', (err as Error)?.message)
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  // Health check
  if (path === '/health') {
    const sessionList = Array.from(sessions.values()).map((s) => s.getInfo())
    // Include Al in session list if connected
    if (alBridge.isConnected()) sessionList.unshift(alBridge.getSessionInfo())
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, version: '0.3.0', sessions: sessionList, cwd }))
    return
  }

  // Filesystem directory autocomplete for the agent prompt's "new session" picker.
  // Returns subdirectories matching `?q=<partial path>`. The prefix is split into
  // (parent dir, name fragment); we list parent and filter by case-insensitive prefix.
  if (path === '/agents/list-dirs') {
    const q = url.searchParams.get('q') ?? ''
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ dirs: listDirectories(q) }))
    return
  }

  // Agent model config + fallback chain. GET inspects; POST {model} switches.
  // The out-of-band recovery lever when a model is pulled (`con agent model`).
  if (path === '/agents/model') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(modelConfig.getState()))
      return
    }
    if (req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        try {
          const { model, chain } = JSON.parse(raw || '{}') as { model?: string; chain?: string[] }
          if (!model?.trim() && !Array.isArray(chain)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'model or chain is required' })); return }
          if (modelConfig.getState().lockedByEnv) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'locked by CLAUDE_MODEL env var' })); return }
          // Replace the fallback chain first (no fleet restart on its own —
          // it only matters on the next failure), then the active model.
          if (Array.isArray(chain) && chain.length > 0) modelConfig.setChain(chain)
          if (model?.trim()) applyUserModelChange(agentCtx, model)
          else broadcastModelState(agentCtx)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(modelConfig.getState()))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: (e as Error).message }))
        }
      })
      return
    }
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }

  // Org-chart roles. GET inspects roles+tree; POST {agentKey, manager} reparents
  // (surgical frontmatter stamp). The out-of-band lever for `con agent role`.
  if (path === '/agents/roles') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ roles: agentRegistry.list(), tree: agentRegistry.tree() }))
      return
    }
    if (req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        try {
          const { agentKey, manager } = JSON.parse(raw || '{}') as { agentKey?: string; manager?: string | null }
          if (!agentKey?.trim() || !agentRegistry.has(agentKey)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no such role' })); return }
          if (manager === agentKey) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'a role cannot manage itself' })); return }
          agentRegistry.setManager(agentKey, manager ?? null)
          broadcastAgentsList(agentCtx)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ roles: agentRegistry.list(), tree: agentRegistry.tree() }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: (e as Error).message }))
        }
      })
      return
    }
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }

  // Delegation tasks — the out-of-band lever + CLI backend (mirrors /agents/roles).
  if (path === '/agents/tasks') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ tasks: taskStore.list() }))
      return
    }
    if (req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        try {
          const b = JSON.parse(raw || '{}') as { fromKey?: string; toKey?: string; newRole?: { title: string; cwd?: string; manager?: string | null }; title?: string; brief?: string; parentTaskId?: string | null; ephemeral?: boolean }
          if (!b.brief?.trim()) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'brief is required' })); return }
          const r = delegateTask(agentCtx, { fromKey: b.fromKey ?? 'al', toKey: b.toKey, newRole: b.newRole, title: b.title, brief: b.brief, parentTaskId: b.parentTaskId, ephemeral: b.ephemeral })
          if (r.error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: r.error })); return }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ task: r.task }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: (e as Error).message }))
        }
      })
      return
    }
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }

  // Report a task (POST /agents/tasks/<id>/report) or cancel it (DELETE /agents/tasks/<id>).
  const taskMatch = path.match(/^\/agents\/tasks\/([^/]+?)(\/report)?$/)
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]!)
    if (taskMatch[2] === '/report' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        try {
          const b = JSON.parse(raw || '{}') as { result?: string; status?: 'done' | 'blocked' | 'failed' }
          const r = reportTask(agentCtx, taskId, b.result ?? '', b.status ?? 'done')
          if (r.error) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: r.error })); return }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: (e as Error).message }))
        }
      })
      return
    }
    if (!taskMatch[2] && req.method === 'DELETE') {
      taskStore.cancel(taskId)
      broadcastTasks(agentCtx)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }

  // STT — transcribes audio via OpenAI Whisper API
  if (path === '/stt' && req.method === 'POST') {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks)
        // Parse multipart form data to extract the audio file
        const boundary = (req.headers['content-type'] || '').split('boundary=')[1]
        if (!boundary) { res.writeHead(400); res.end('Missing boundary'); return }
        const parts = body.toString('binary').split('--' + boundary)
        let audioData: Buffer | null = null
        // Honor the uploaded part's real filename — OpenAI Whisper picks the
        // audio format from the extension. Browser MediaRecorder sends
        // audio.webm; the `con mic` CLI sends a .wav. Default to webm.
        let filename = 'audio.webm'
        for (const part of parts) {
          if (part.includes('name="file"')) {
            const fnMatch = part.match(/filename="([^"]+)"/)
            if (fnMatch) filename = fnMatch[1]!
            const headerEnd = part.indexOf('\r\n\r\n')
            if (headerEnd !== -1) {
              audioData = Buffer.from(part.slice(headerEnd + 4).replace(/\r\n$/, ''), 'binary')
            }
          }
        }
        if (!audioData || audioData.length < 100) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: '' })); return }

        // Get OpenAI API key from environment
        const apiKey = process.env.OPENAI_API_KEY
        if (!apiKey) { res.writeHead(500); res.end('OPENAI_API_KEY not set'); return }

        const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
        const audioMime = ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : 'audio/webm'
        // Build multipart form for OpenAI
        const formBoundary = '----FormBoundary' + Date.now()
        const formParts = [
          `--${formBoundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${audioMime}\r\n\r\n`,
          audioData,
          `\r\n--${formBoundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${formBoundary}--\r\n`,
        ]
        const formBody = Buffer.concat([Buffer.from(formParts[0] as string), formParts[1] as Buffer, Buffer.from(formParts[2] as string)])

        const apiRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': `multipart/form-data; boundary=${formBoundary}`,
          },
          body: formBody,
        })
        if (!apiRes.ok) {
          const errText = await apiRes.text()
          log(`[stt] OpenAI error: ${apiRes.status} ${errText.slice(0, 200)}`)
          res.writeHead(500); res.end('STT failed')
          return
        }
        const result = await apiRes.json() as { text: string }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ text: result.text }))
      } catch (err) {
        log(`[stt] Error: ${(err as Error).message}`)
        res.writeHead(500); res.end('STT error')
      }
    })
    return
  }

  // TTS — converts text to speech via espeak-ng, returns WAV audio
  if (path === '/tts' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body)
        if (!text) { res.writeHead(400); res.end('Missing text'); return }
        const voice = 'en-GB-RyanNeural'
        const tmpFile = `/tmp/tts-${Date.now()}.mp3`
        execFile('edge-tts', ['--voice', voice, '--text', text.slice(0, 5000), '--write-media', tmpFile], { timeout: 30000 }, (err) => {
          if (err) {
            // Fallback to espeak-ng
            execFile('espeak-ng', ['--stdout', text.slice(0, 5000)], { encoding: 'buffer', maxBuffer: 5 * 1024 * 1024, timeout: 10000 }, (err2, stdout) => {
              if (err2) { res.writeHead(500); res.end('TTS failed'); return }
              res.writeHead(200, { 'Content-Type': 'audio/wav' })
              res.end(stdout)
            })
            return
          }
          try {
            const audio = readFileSync(tmpFile)
            res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
            res.end(audio)
            unlinkSync(tmpFile)
          } catch { res.writeHead(500); res.end('TTS read failed') }
        })
      } catch { res.writeHead(400); res.end('Invalid JSON') }
    })
    return
  }

  // Icon proxy — serves remote images as same-origin for notification icons
  if (path === '/proxy/icon' && req.method === 'GET') {
    const iconUrl = url.searchParams.get('url')
    if (!iconUrl) {
      res.writeHead(400)
      res.end('Missing url param')
      return
    }
    try {
      const iconRes = await fetch(iconUrl)
      if (!iconRes.ok) {
        res.writeHead(iconRes.status)
        res.end()
        return
      }
      const contentType = iconRes.headers.get('content-type') || 'image/png'
      const buffer = Buffer.from(await iconRes.arrayBuffer())
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      })
      res.end(buffer)
    } catch {
      res.writeHead(502)
      res.end()
    }
    return
  }

  // Route to handlers — each returns true if it handled the request
  if (path.startsWith('/auth') && handleAuthRoutes(req, res, path, authStore, readBody, port as number)) return
  if (path.startsWith('/mail') && handleMailRoutes(req, res, path, url, gmailClient, readBody)) return
  if (path.startsWith('/cal') && handleCalendarRoutes(req, res, path, url, calendarClient, authStore, readBody)) return
  if (path.startsWith('/flights') && handleFlightRoutes(req, res, path, url, { authStore, serpApi: serpApiClient, watchlists: flightWatchlists, sync: flightSync, mapLayers: mapLayerStore, onLayersChange: broadcastLayers, readBody })) return
  // Rescued media from the append-only chat archive (deleted attachments).
  // GET /matrix/archive/media/<sha1>.bin[?mime=image/jpeg] — filename
  // validated inside mediaPath. The stored blob has no extension, so the
  // client passes the archived mime as a query hint; constrained to
  // image/audio/video/pdf so a crafted hint can't smuggle text/html (XSS).
  if (path.startsWith('/matrix/archive/media/') && req.method === 'GET') {
    const file = path.slice('/matrix/archive/media/'.length)
    const p = messageArchive.mediaPath(file)
    if (!p) { res.writeHead(404); res.end('not found'); return }
    const hint = url.searchParams.get('mime') ?? ''
    const safeMime = /^(image|audio|video)\/[\w.+-]+$/.test(hint) || hint === 'application/pdf'
      ? hint
      : 'application/octet-stream'
    res.writeHead(200, {
      'Content-Type': safeMime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000',
    })
    res.end(readFileSync(p))
    return
  }
  if (path.startsWith('/matrix') && handleMatrixRoutes(req, res, path, url, matrixClient, keyBackupStore, hubMatrixCrypto, authStore, matrixSync, readBody)) return
  if (path.startsWith('/money') && handleMonzoRoutes(req, res, path, url, monzoClient, monzoStore, authStore, readBody, broadcast, pushServer)) return
  if (path.startsWith('/finance') && handleFinanceRoutes(req, res, path, url, financeStore, monzoStore, monzoClient, authStore, readBody)) return
  // ---- Public surface ---------------------------------------------------
  // /public/canvas/<token>  → public.ts (canvas share)
  // /public/cron.ics?token  → aliases to /cron.ics (token already on query)
  // /public/apk/<name>      → aliases to /apk/<name> (immutable assets)
  // No auth applies to /public/*; auth middleware already let it through.
  if (path === '/public/canvas' || path.startsWith('/public/canvas/')) {
    if (handlePublicCanvas(req, res, path, { canvas: canvasDir, publicTokens: publicCanvasTokens })) return
  }
  if (path === '/public/cron.ics' || path.startsWith('/public/cron.ics?')) {
    if (handleCronRoutes(req, res, '/cron.ics', url, {
      scheduler: cronScheduler, getSessions: () => sessions, getAlConnected: () => alBridge.isConnected(), log,
    }, readBody)) return
  }
  if (path === '/public/apk' || path.startsWith('/public/apk/')) {
    const apkPath = path.replace(/^\/public\/apk/, '/apk')
    if (handleApkRoutes(req, res, apkPath)) return
  }

  if (path.startsWith('/mic') && handleMicRoutes(req, res, path, {
    effectiveOwnerId: effectiveMicOwnerId,
    ownerName: micOwnerName,
    isHot: () => micState.isHot(),
    explicitOwnerId: () => micState.getOwnerSessionId(),
    resolveTarget: resolveMicTarget,
    setOwner: (sid) => micState.setOwnerSessionId(sid),
    setHot: (hot) => micState.setHot(hot),
    injectToSession,
    compose: (text) => {
      const owner = effectiveMicOwnerId()
      syncBus.broadcast('mic', 'compose', { owner, ownerName: micOwnerName(owner), text })
      return owner
    },
  }, readBody)) return
  if (path.startsWith('/bookmarks') && handleBookmarkRoutes(req, res, path, bookmarkStore, readBody)) return
  if (path.startsWith('/feeds') && handleFeedRoutes(req, res, path, url, feedStore, readBody)) return
  if (path.startsWith('/notes') && handleNoteRoutes(req, res, path, noteStore, readBody)) return
  if (path.startsWith('/blog') && handleBlogRoutes(req, res, path, noteStore, readBody)) return
  if (path.startsWith('/debug') && handleDebugRoutes(req, res, path, url, debugClients, debugLog, readBody)) return
  if (path.startsWith('/apk') && handleApkRoutes(req, res, path)) return
  if (path.startsWith('/owntracks/') && handleOwntracksRoutes(req, res, path, url, authStore)) return
  if (path.startsWith('/geocaching') && handleGeocachingRoutes(req, res, path, geocachingClient, readBody)) return
  if (path.startsWith('/meetup') && handleMeetupRoutes(req, res, path, meetupClient, readBody)) return
  if (path.startsWith('/outdoorlads') && handleOutdoorLadsRoutes(req, res, path, outdoorLadsStore)) return
  if (path.startsWith('/spotify') && handleSpotifyRoutes(req, res, path, url, spotifyClient, spotifyStore, spotifySync, readBody)) return
  if (path.startsWith('/map/layers') && handleMapLayerRoutes(req, res, path, url, mapLayerStore, readBody, broadcastLayers)) return
  if (path.startsWith('/push') && handlePushRoutes(req, res, path, pushServer, readBody)) return
  if (path.startsWith('/glasses') && handleGlassesRoutes(req, res, path, glassesHub, readBody, glassesConfig)) return
  if (path.startsWith('/pen') && handlePenRoutes(req, res, path, penHub, readBody)) return
  if ((path.startsWith('/whatsapp') || path.startsWith('/voice')) && handleAlRoutes(req, res, path, readBody)) return
  if (path === '/config' && handleConfigRoutes(req, res, path, prefsStore, readBody)) return
  if (path.startsWith('/dashboard/canvas/islands') && handleCanvasIslandRoutes(req, res, path, {
    servers: dashboardServers, canvas: canvasDir, sessions, cal: calSync, debugLog, publicTokens: publicCanvasTokens,
  }, readBody)) return
  if (path.startsWith('/dashboard/canvas/tabs') && handleCanvasTabRoutes(req, res, path, {
    servers: dashboardServers, canvas: canvasDir, sessions, cal: calSync, debugLog, publicTokens: publicCanvasTokens,
  }, readBody)) return
  if (path.startsWith('/dashboard') && handleDashboardRoutes(req, res, path, url, {
    servers: dashboardServers, canvas: canvasDir, sessions, cal: calSync, debugLog, publicTokens: publicCanvasTokens,
  }, readBody)) return
  if (path.startsWith('/canvas') && handleCanvasRoutes(req, res, path, {
    servers: dashboardServers, canvas: canvasDir, sessions, cal: calSync, debugLog, publicTokens: publicCanvasTokens,
  })) return
  if ((path === '/cron' || path === '/cron.ics' || path.startsWith('/cron/')) && handleCronRoutes(req, res, path, url, {
    scheduler: cronScheduler, getSessions: () => sessions, getAlConnected: () => alBridge.isConnected(), log,
  }, readBody)) return

  res.writeHead(404)
  res.end('Not found')
}

const httpServer = tlsOpts
  ? createHttpsServer(tlsOpts, requestHandler)
  : createHttpServer(requestHandler)

// --------------------------------------------------------------------------
// WebSocket server
// --------------------------------------------------------------------------

// WS Origin gate. Browsers always send `Origin`; Node-side clients (CLI, Al,
// glasses, debug) don't. Reject browser connections from unknown origins so a
// malicious site can't bypass CORS via WebSocket.
const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: (info: { origin: string }) => !info.origin || originAllowed(info.origin),
})

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const urlPath = req.url ?? '/'

  // Al connects on /al path — handle separately from browser clients
  if (urlPath === '/al') {
    log('[al] Al connecting...')
    alBridge.handleAlConnection(ws)

    // Broadcast updated session list to all browser clients
    const active = Array.from(sessions.values()).map((s) => s.getInfo())
    if (alBridge.isConnected()) active.unshift(alBridge.getSessionInfo())
    const listMsg: HubMessage = { type: 'sessions_list', sessions: active }
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(listMsg))
    }
    return
  }

  // Push clients (Android foreground service) connect on /push path
  if (urlPath === '/push') {
    pushServer.attach(ws)
    return
  }

  // Glasses raw LC3 audio fanout (typically one subscriber: Al / STT bridge).
  // Frames: `{type:'audio', seq, lc3b64}`. Each frame is ~200B LC3 at ~50fps.
  // Decode to PCM happens on the *consumer* — see docs/g1-mic-stt-recipe.md.
  if (urlPath === '/glasses/mic') {
    log(`[glasses] audio subscriber connected`)
    const unsub = glassesHub.onAudio((f) => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'audio', seq: f.seq, lc3b64: f.lc3b64 })) } catch { /* ignore */ }
      }
    })
    ws.on('close', () => { unsub(); log(`[glasses] audio subscriber disconnected`) })
    return
  }

  // Glasses touchbar events (taps, long-presses, swipes) fanout.
  if (urlPath === '/glasses/events') {
    log(`[glasses] event subscriber connected`)
    const unsubTouch = glassesHub.onTouch((f) => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'touch', arm: f.arm, subcmd: f.subcmd })) } catch { /* ignore */ }
      }
    })
    ws.on('close', () => { unsubTouch(); log(`[glasses] event subscriber disconnected`) })
    return
  }

  // Sync bus — service event streams + RPC for hub-owned services
  if (urlPath === '/sync') {
    syncBus.attach(ws)
    return
  }

  // Debug agent connects on /debug path
  if (urlPath === '/debug') {
    // Stash the upgrade request's User-Agent on the socket so debug RPCs can
    // target a specific client (desktop browser vs. APK WebView vs. mobile
    // browser) by substring. `.ua` is read in handleDebugRoutes via the
    // `(ws as any).ua` cast.
    ;(ws as any).ua = (req.headers['user-agent'] as string | undefined) ?? ''
    debugClients.add(ws)
    log(`[debug] Client connected (${debugClients.size} total): ${(ws as any).ua.slice(0, 80)}`)
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as DebugClientMessage
        handleDebugClientMessage(msg, debugLog)
      } catch { /* ignore malformed */ }
    })
    ws.on('close', () => {
      debugClients.delete(ws)
      log(`[debug] Client disconnected (${debugClients.size} remaining)`)
    })
    return
  }

  // STT WebSocket relay — bridges browser audio to OpenAI Realtime Transcription API
  if (urlPath === '/stt') {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      ws.send(JSON.stringify({ type: 'error', message: 'OPENAI_API_KEY not set' }))
      ws.close()
      return
    }
    log('[stt] Client connected, opening OpenAI realtime transcription...')
    // GA realtime API — config + event translation live in stt.ts (with tests).
    // See that module's header for the two broken variants that preceded this.
    const openaiWs = new WebSocket(STT_REALTIME_URL, { headers: buildSttHeaders(apiKey) })

    // Periodically commit the audio buffer to force transcription during continuous speech
    let commitInterval: ReturnType<typeof setInterval> | null = null

    openaiWs.on('open', () => {
      openaiWs.send(JSON.stringify(buildTranscriptionSessionUpdate()))
    })

    openaiWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        const type = msg.type as string | undefined
        // Log all event types for debugging (except session acks which are noisy)
        if (type && !type.startsWith('session.') && !type.startsWith('transcription_session')) {
          log(`[stt] event: ${type}`)
        }
        if (type === 'conversation.item.input_audio_transcription.failed' || type === 'error') {
          log(`[stt] OpenAI error payload: ${JSON.stringify(msg).slice(0, 500)}`)
        }
        const out = translateOpenAiEvent(msg)
        if (out) ws.send(JSON.stringify(out))
      } catch { /* ignore */ }
    })

    openaiWs.on('close', (code, reason) => {
      log(`[stt] OpenAI WS closed code=${code} reason=${reason?.toString().slice(0, 200) || '(none)'}`)
      if (commitInterval) clearInterval(commitInterval)
      ws.close()
    })
    openaiWs.on('error', (err) => {
      log(`[stt] OpenAI WS error: ${(err as Error).message}`)
      if (commitInterval) clearInterval(commitInterval)
      ws.close()
    })
    openaiWs.on('unexpected-response', (_req, res) => {
      log(`[stt] OpenAI WS handshake failed: HTTP ${res.statusCode} ${res.statusMessage}`)
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'audio' && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.data }))
        }
      } catch { /* ignore */ }
    })

    ws.on('close', () => {
      log('[stt] Client disconnected')
      if (commitInterval) clearInterval(commitInterval)
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close()
    })
    return
  }

  // Browser client
  clients.add(ws)
  log(`Client connected from ${req.socket.remoteAddress} (${clients.size} total)`)

  // Send project directories on connect
  const dirs = discoverProjectDirs()
  sendTo(ws, { type: 'project_dirs', dirs })

  // Send current agent-model config so the picker reflects reality on connect.
  sendTo(ws, { type: 'model_state', ...modelConfig.getState() })

  // Send the org-chart roles + tree (mirror model_state; also pushed on change).
  sendTo(ws, { type: 'agents_list', roles: agentRegistry.list(), tree: agentRegistry.tree() })

  // Delegation tasks
  sendTo(ws, { type: 'tasks', tasks: taskStore.list() })

  // Send current session list (including Al if connected)
  const active = Array.from(sessions.values()).map((s) => s.getInfo())
  if (alBridge.isConnected()) active.unshift(alBridge.getSessionInfo())
  sendTo(ws, { type: 'sessions_list', sessions: active })

  // Send session order (translated from persisted claudeSessionIds to current hub IDs)
  const order = loadSessionOrder(sessions)
  if (order.length > 0) {
    sendTo(ws, { type: 'session_order', order })
  }

  // Send collapsed-groups state (keyed by cwd, stable across restarts)
  const collapsed = loadCollapsedGroups()
  if (collapsed.length > 0) {
    sendTo(ws, { type: 'collapsed_groups', collapsed })
  }

  // Replay last REPLAY_LIMIT messages per session (older messages loaded on scroll-up)
  const REPLAY_LIMIT = 50
  for (const session of sessions.values()) {
    const log = session.messageLog
    if (log.length > 0) {
      const start = Math.max(0, log.length - REPLAY_LIMIT)
      for (let i = start; i < log.length; i++) {
        sendTo(ws, log[i]!)
      }
    }
  }

  // Replay last REPLAY_LIMIT Al messages
  if (alBridge.isConnected()) {
    const alLog = alBridge.getMessageLog()
    const start = Math.max(0, alLog.length - REPLAY_LIMIT)
    for (let i = start; i < alLog.length; i++) {
      sendTo(ws, alLog[i]!)
    }
  }

  ws.on('message', (data) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(data.toString()) as ClientMessage
    } catch {
      sendTo(ws, { type: 'hub_error', message: 'Invalid JSON' })
      return
    }

    // Handle older message pagination (works for both Al and regular sessions).
    // beforeIndex is an ABSOLUTE index (client-side message numbering, monotonic
    // across the session). For agent sessions we translate to the in-memory
    // window via `messageLogOffset` — anything older than the offset has been
    // rolled off the cap and is no longer paginable in-memory (full history
    // still lives in Claude CLI's JSONL transcript on disk, but we don't
    // re-hydrate it from there yet).
    if (msg.type === 'get_older_messages') {
      const PAGE = (msg as any).limit || 50
      const beforeIndex = (msg as any).beforeIndex as number
      const sessionId = (msg as any).sessionId as string
      if (sessionId === AL_SESSION_ID) {
        const log = alBridge.getMessageLog()
        const end = Math.min(beforeIndex, log.length)
        const start = Math.max(0, end - PAGE)
        const slice = log.slice(start, end)
        sendTo(ws, { type: 'older_messages', sessionId, messages: slice, hasMore: start > 0 })
      } else {
        const session = sessions.get(sessionId)
        if (!session) {
          sendTo(ws, { type: 'older_messages', sessionId, messages: [], hasMore: false })
          return
        }
        const offset = session.messageLogOffset
        const memEnd = Math.min(beforeIndex - offset, session.messageLog.length)
        const memStart = Math.max(0, memEnd - PAGE)
        const slice = memStart < memEnd ? session.messageLog.slice(memStart, memEnd) : []
        // hasMore reflects whether there's more *in memory* — when we've hit
        // the rolling cap boundary, advertise no more so the client stops
        // asking. (Older history still exists in Claude CLI's on-disk JSONL;
        // a future JSONL-replay path could extend pagination past memory.)
        sendTo(ws, { type: 'older_messages', sessionId, messages: slice, hasMore: memStart > 0 })
      }
      return
    }

    // Route Al-targeted messages to the bridge
    if ('sessionId' in msg && (msg as { sessionId?: string }).sessionId === AL_SESSION_ID) {
      if (msg.type === 'send_message') {
        alBridge.handleBrowserMessage('send_message', ws, msg.content, msg.images)
        markAlRead()
      } else if (msg.type === 'interrupt') {
        alBridge.handleBrowserMessage('interrupt', ws)
      } else if (msg.type === 'kill_session') {
        alBridge.handleBrowserMessage('clear', ws)
      } else if (msg.type === 'mark_session_read') {
        markAlRead()
      } else if (msg.type === 'mark_session_unread') {
        markAlUnread()
      }
      return
    }

    handleClientMessage(agentCtx, ws, msg)
  })

  ws.on('close', () => {
    clients.delete(ws)
    log(`Client disconnected (${clients.size} remaining)`)
  })

  ws.on('error', (err) => {
    log(`WebSocket error: ${err.message}`)
    clients.delete(ws)
  })
})

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------

httpServer.listen(port, host, () => {
  const proto = tlsOpts ? 'https' : 'http'
  const wsproto = tlsOpts ? 'wss' : 'ws'
  log(`Console Server running on ${proto}://${host}:${port}`)
  log(`Working directory: ${cwd}`)
  log(`WebSocket: ${wsproto}://${host}:${port}`)
  log(`Health check: ${proto}://${host}:${port}/health`)
  if (tlsOpts && certCandidates[0]) log(`TLS: using ${certCandidates[0].cert}`)

  // Restore sessions from manifest
  const manifest = loadManifest()
  if (manifest.length > 0) {
    log(`Restoring ${manifest.length} session(s) from manifest...`)

    // One-time backfill of fork lineage for forks created before the hub began
    // recording `parentClaudeSessionId`. A fork is named "<parent> (fork)"; if
    // exactly one manifest entry has that base name, adopt it as the parent.
    // Ambiguous (no/multiple matches) → left unlinked (renders as a root).
    const byName = new Map<string, string[]>()
    for (const e of manifest) {
      if (e.name && e.claudeSessionId) {
        const arr = byName.get(e.name) ?? []
        arr.push(e.claudeSessionId)
        byName.set(e.name, arr)
      }
    }
    const resolveParent = (entry: { name?: string; parentClaudeSessionId?: string }): string | undefined => {
      if (entry.parentClaudeSessionId) return entry.parentClaudeSessionId
      const m = entry.name?.match(/^(.*) \(fork\)$/)
      if (!m) return undefined
      const candidates = byName.get(m[1]!)
      return candidates && candidates.length === 1 ? candidates[0] : undefined
    }

    // One-time, idempotent ROLE backfill: turn every pre-existing named session
    // into a durable org-chart role. Two passes so a fork's manager can resolve
    // to its parent's (possibly just-minted) key. create()/mintKey are file-aware,
    // so re-running on later boots is a no-op once role files exist.
    const csidToKey = new Map<string, string>()
    for (const entry of manifest) {
      if (entry.ended || !entry.claudeSessionId || !entry.name) continue
      let key = entry.agentKey
      if (!key) key = agentRegistry.mintKey(entry.name)
      if (!agentRegistry.has(key)) {
        agentRegistry.create(key, { title: entry.name, charter: entry.prompt, cwd: entry.cwd })
      }
      csidToKey.set(entry.claudeSessionId, key)
    }
    for (const entry of manifest) {
      if (entry.ended || !entry.claudeSessionId) continue
      const key = csidToKey.get(entry.claudeSessionId)
      if (!key) continue
      const role = agentRegistry.get(key)
      const parentCsid = resolveParent(entry)
      const mgrKey = parentCsid ? csidToKey.get(parentCsid) : undefined
      // Only seed a manager for a role that doesn't already have one (don't
      // override an edge the user/agent set).
      if (role && role.manager === null && mgrKey && mgrKey !== key) {
        agentRegistry.setManager(key, mgrKey)
      }
    }

    // One-time org reorg: within a directory, the "<X> general" agent manages
    // the other agents in that same cwd. Gated by a marker file so it runs once
    // and never fights a manual reparent later. Forks keep their fork-parent
    // edge (set above); only still-rootless same-dir peers are reparented.
    const reorgMarker = join(feedsConfigDir, 'agents', '.general-reorg-v1')
    if (!existsSync(reorgMarker)) {
      const generalByCwd = new Map<string, string>()
      for (const entry of manifest) {
        if (entry.ended || !entry.claudeSessionId || !entry.name || !entry.cwd) continue
        if (!/\bgeneral\b/i.test(entry.name)) continue
        const key = csidToKey.get(entry.claudeSessionId)
        if (key && !generalByCwd.has(entry.cwd)) generalByCwd.set(entry.cwd, key)
      }
      let reorged = 0
      for (const entry of manifest) {
        if (entry.ended || !entry.claudeSessionId || !entry.cwd) continue
        const key = csidToKey.get(entry.claudeSessionId)
        if (!key) continue
        const gen = generalByCwd.get(entry.cwd)
        const role = agentRegistry.get(key)
        if (gen && gen !== key && role && role.manager === null) {
          agentRegistry.setManager(key, gen)
          reorged++
        }
      }
      try { writeFileSync(reorgMarker, new Date().toISOString()) } catch { /* best effort */ }
      log(`[agents] general-reorg: ${reorged} role(s) placed under their dir's general`)
    }

    // One-time: materialize the directory buckets as REAL folder nodes (so they
    // can be renamed, created, and used as drop targets) and parent the still-
    // rootless agents under them. Replaces the old client-side synthetic folders.
    const dirFoldersMarker = join(feedsConfigDir, 'agents', '.dir-folders-v1')
    if (!existsSync(dirFoldersMarker)) {
      const parentDirOf = (p: string) => { const s = p.replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i > 0 ? s.slice(0, i) : s }
      const baseNameOf = (p: string) => { const s = p.replace(/\/+$/, ''); const i = s.lastIndexOf('/'); const b = i >= 0 ? s.slice(i + 1) : s; return b ? b.charAt(0).toUpperCase() + b.slice(1) : b }
      const roots = agentRegistry.list().filter((r) => !r.folder && r.key !== 'al' && !r.manager && r.cwd)
      const byDir = new Map<string, typeof roots>()
      for (const r of roots) { const d = parentDirOf(r.cwd!); const arr = byDir.get(d) ?? []; arr.push(r); byDir.set(d, arr) }
      let folders = 0
      for (const [dir, members] of byDir) {
        if (members.length < 2) continue
        const fkey = agentRegistry.mintKey(baseNameOf(dir))
        agentRegistry.create(fkey, { title: baseNameOf(dir), folder: true, manager: 'al' })
        for (const m of members) agentRegistry.setManager(m.key, fkey)
        folders++
      }
      try { writeFileSync(dirFoldersMarker, new Date().toISOString()) } catch { /* best effort */ }
      log(`[agents] dir-folders: created ${folders} folder node(s) from directory buckets`)
    }

    // Re-instantiate only ONE Al — the official one per al-session.json (or the
    // first if none recorded). Stale Al entries (left by prior reloads/restarts)
    // are skipped so a second "Al" never appears on boot; the saveManifest()
    // after this loop then prunes them from the file. ensureAlSession (below)
    // adopts the restored Al or spawns fresh — exactly one Al either way, with
    // nothing killed.
    const officialAlId = getRecordedAlSessionId()
    let alRestored = false
    for (const entry of manifest) {
      // User explicitly ended this session — stay dead. The saveManifest()
      // after the loop prunes it (it never enters the sessions map).
      if (entry.ended) {
        log(`  Skipped (ended by user): ${entry.name ?? entry.claudeSessionId}`)
        continue
      }
      if (entry.agentKey === 'al' || entry.name === 'Al') {
        const isOfficial = officialAlId ? entry.claudeSessionId === officialAlId : !alRestored
        if (!isOfficial) {
          log(`  Skipped (stale Al duplicate): ${entry.claudeSessionId}`)
          continue
        }
        alRestored = true
      }
      try {
        const session = createSession(agentCtx, {
          prompt: entry.prompt,
          cwd: entry.cwd,
          resume: entry.claudeSessionId,
          silent: true,
          name: entry.name,
          parentClaudeSessionId: resolveParent(entry),
          agentKey: entry.agentKey ?? (entry.claudeSessionId ? csidToKey.get(entry.claudeSessionId) : undefined),
          needsAttention: entry.needsAttention,
          restoreMessageLogLength: entry.messageLogLength,
          modelOverride: entry.modelOverride,
        })
        // If the session was mid-turn when the hub stopped, nudge it to
        // continue where it left off. Silent resume alone leaves it idle.
        if (entry.wasRunning) {
          setTimeout(() => {
            if (session.status !== 'ended') {
              const content = 'The hub was restarted, which interrupted you. Continue.'
              // Mirror the UI send-message path: broadcast + log so the prompt
              // appears in the conversation view, not just on Claude's stdin.
              const userMsg = { type: 'user_prompt' as const, sessionId: session.id, content }
              broadcast(userMsg)
              session.logMessage(userMsg)
              session.sendMessage(content)
            }
          }, 1_000)
          log(`  Resumed + continued: ${session.id} (claude: ${entry.claudeSessionId})`)
        } else {
          log(`  Resumed: ${session.id} (claude: ${entry.claudeSessionId})`)
        }
      } catch (err) {
        log(`  Failed to resume ${entry.claudeSessionId}: ${(err as Error).message}`)
      }
    }
    // Save manifest immediately so restored sessions are persisted
    saveManifest(sessions)
  }

  // -----------------------------------------------------------------
  // Al runtime bootstrap — absorbed from ~/proj/code/al into the hub.
  //
  // Order: ensure the Al Claude session is alive (spawned fresh or resumed
  // from manifest), THEN load users + start Baileys. The WhatsApp handlers
  // inject inbound messages into Al; injecting before Al exists is a no-op
  // (returns false) so a fast inbound during the boot window is dropped
  // safely rather than crashing.
  ;(async () => {
    try {
      await loadUsers()
      setUserNotifier((text) => { injectToAl(`[Hub] ${text}`, broadcast) })
      const alSession = await ensureAlSession(agentCtx)
      log(`Al session ready: ${alSession.id} (claude=${alSession.claudeSessionId?.slice(0, 8) ?? '...'})`)

      await alWa.startWhatsApp({
        onInbound: async (msg) => {
          try {
            await ensureUserKnown(msg.sender, 'whatsapp', msg.senderName)
            const resolved = resolveUsername(msg.sender)
            const envelope = alWa.inboundEnvelope(msg, resolved)
            injectToAl(envelope, broadcast)
          } catch (err) {
            console.error('[al/wa/inbound] handler failed:', (err as Error)?.message)
          }
        },
        onQrUpdate: (dataUrl) => {
          const body = [
            '[Hub event] WhatsApp needs pairing.',
            'Scan with your phone (rotates every ~20s):',
            '',
            `![WhatsApp QR](${dataUrl})`,
          ].join('\n')
          injectToAl(body, broadcast)
        },
        onHealthChange: (state, detail) => {
          // WhatsApp drops + auto-reconnects constantly on transient 428/503
          // blips. Injecting each connect/disconnect into Al's session spends a
          // full turn's tokens for zero action, so DON'T feed Al — just log for
          // diagnostics. The one actionable case (logged-out → needs re-pair) is
          // surfaced separately via onQrUpdate when the fresh QR is issued.
          const detailSuffix = detail ? ` (${detail})` : ''
          console.log(`[al/wa] health: ${state}${detailSuffix}`)
        },
      })
      log('Baileys WhatsApp started')

      // Deprecation shim on :18789 — translates old POST /message → wa.sendText
      // until every caller migrates to `con whatsapp send`. Logs every caller.
      startDeprecationShim()
    } catch (err) {
      console.error('[al/boot] failed:', (err as Error)?.message)
    }
  })()

  log('')
  log('Waiting for Console to connect...')
})

// Graceful shutdown — save manifest synchronously before exit
function shutdown() {
  log('\nShutting down — saving manifest...')
  saveManifestSync(sessions)
  flushReadState()
  cronScheduler.flush()
  for (const session of sessions.values()) session.kill()
  authStore.destroy()
  httpServer.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)


// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------

function sendTo(ws: WebSocket, msg: HubMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function log(msg: string) {
  const ts = new Date().toLocaleTimeString()
  console.log(`[${ts}] ${msg}`)
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function getArg(flag: string, fallback: string): string
function getArg(flag: string, fallback: number): number
function getArg(flag: string, fallback: string | number): string | number {
  const idx = process.argv.indexOf(flag)
  if (idx === -1 || idx >= process.argv.length - 1) return fallback
  const val = process.argv[idx + 1]!
  return typeof fallback === 'number' ? parseInt(val, 10) : val
}
