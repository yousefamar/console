package io.amar.console.di

import android.content.Context
import io.amar.console.core.HubClient
import io.amar.console.core.AppLifecycle
import io.amar.console.data.agents.AgentsRepository
import io.amar.console.data.cal.CalendarRepository
import io.amar.console.data.chat.ChatRepository
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.feeds.FeedsRepository
import io.amar.console.data.longtail.BookmarksRepository
import io.amar.console.data.longtail.HomeRepository
import io.amar.console.data.longtail.MapRepository
import io.amar.console.data.longtail.MusicRepository
import io.amar.console.data.mail.MailRepository
import io.amar.console.data.notes.NotesRepository
import io.amar.console.glasses.mirror.GlassesMirror
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.SyncEngine
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Hand-wired singletons — deliberately no DI framework (single-dev,
 * single-process app; Hilt buys nothing here but build time).
 * Built once in ConsoleApp.onCreate; services reach it via
 * `(application as ConsoleApp).graph`.
 */
class AppGraph(context: Context) {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val db: ConsoleDb = ConsoleDb.build(context)
    val hub = HubClient()
    val syncBus = SyncBusClient(appScope)
    val outbox = Outbox(context, appScope, db, hub, syncBus)
    val syncEngine = SyncEngine(appScope, db, hub, syncBus, outbox)

    val chat = ChatRepository(db, hub, syncBus, outbox)
    val mail = MailRepository(db, hub, syncBus, outbox)
    val calendar = CalendarRepository(db, hub, syncBus, outbox)
    val notes = NotesRepository(db, hub, syncBus, outbox)
    val feeds = FeedsRepository(db, hub, outbox)
    val agents = AgentsRepository(appScope, db, hub, outbox)
    val bookmarks = BookmarksRepository(db, hub, outbox)
    val map = MapRepository(db, hub)
    val music = MusicRepository(hub)
    val home = HomeRepository(hub)
    val hardware = io.amar.console.data.longtail.HardwareRepository(hub)
    val mirror = GlassesMirror(context, appScope, db)

    init {
        chat.registerOutboxHandlers()
        chat.wireLiveDeltas(appScope)
        syncEngine.addDomain("chat") { chat.reconcile() }
        // Warm every unread room's first page in the background once per app
        // launch, after the first sync connects (SPA useSync parity). Keeps the
        // last message + unread state ready when opening a room offline.
        run {
            val once = java.util.concurrent.atomic.AtomicBoolean(false)
            syncBus.onConnect {
                if (once.compareAndSet(false, true)) {
                    appScope.launch { runCatching { chat.preloadAllRooms() } }
                }
            }
        }

        mail.registerOutboxHandlers()
        mail.wireLiveDeltas(appScope)
        syncEngine.addDomain("mail") { mail.reconcile() }

        calendar.registerOutboxHandlers()
        calendar.wireLiveDeltas(appScope)
        syncEngine.addDomain("calendar") { calendar.reconcile() }
        // 15-min periodic fallback refetch (parity with the SPA useSync timer) —
        // catches drift when neither cal.delta nor a reconnect fired.
        appScope.launch {
            while (true) {
                kotlinx.coroutines.delay(15 * 60 * 1000L)
                if (io.amar.console.core.AppLifecycle.foregroundFlow.value) {
                    runCatching { calendar.reconcile() }
                }
            }
        }

        notes.registerOutboxHandlers()
        syncEngine.addDomain("notes") { notes.reconcile() }
        // Eager pen live-activity wiring: the Notes tile's red dot + auto-open
        // work even before the Notes pane is first opened (SyncBus 'pen').
        notes.wirePenActivity(appScope)

        feeds.registerOutboxHandlers()
        syncEngine.addDomain("feeds") { feeds.reconcile() }
        // 15-min periodic refetch (parity with the calendar timer) so feeds stay
        // fresh app-wide, not only while the Feeds pane is open.
        appScope.launch {
            while (true) {
                kotlinx.coroutines.delay(15 * 60 * 1000L)
                if (AppLifecycle.foregroundFlow.value) runCatching { feeds.reconcile() }
            }
        }

        agents.registerOutboxHandlers()
        // The agents WS (separate from /sync) follows the same
        // foreground-only lifecycle; its connect burst IS the reconcile.
        appScope.launch {
            AppLifecycle.foregroundFlow.collectLatest { fg ->
                if (fg) agents.start() else agents.stop()
            }
        }
        // PTT mic ownership rides the shared SyncBus (one socket for the app)
        // instead of Mic's own /sync WS.
        io.amar.console.data.agents.Mic.attach(syncBus)

        bookmarks.registerOutboxHandlers()
        syncEngine.addDomain("bookmarks") { bookmarks.reconcile() }
        syncEngine.addDomain("map") { map.reconcile() }
        // Instant cross-device deltas (a fetch-area / canvas edit on PC updates
        // the phone without waiting for a reconnect/poll).
        map.wireLiveDeltas(appScope, syncBus)
        home.wireDashboardBus(syncBus)
    }
}
