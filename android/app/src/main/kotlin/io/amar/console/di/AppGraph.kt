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

        feeds.registerOutboxHandlers()
        syncEngine.addDomain("feeds") { feeds.reconcile() }

        agents.registerOutboxHandlers()
        // The agents WS (separate from /sync) follows the same
        // foreground-only lifecycle; its connect burst IS the reconcile.
        appScope.launch {
            AppLifecycle.foregroundFlow.collectLatest { fg ->
                if (fg) agents.start() else agents.stop()
            }
        }

        bookmarks.registerOutboxHandlers()
        syncEngine.addDomain("bookmarks") { bookmarks.reconcile() }
        syncEngine.addDomain("map") { map.reconcile() }
    }
}
