package io.amar.console.di

import android.content.Context
import io.amar.console.core.HubClient
import io.amar.console.core.AppLifecycle
import io.amar.console.data.agents.AgentsRepository
import io.amar.console.data.cal.CalendarRepository
import io.amar.console.data.chat.ChatRepository
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.feeds.FeedsRepository
import io.amar.console.data.mail.MailRepository
import io.amar.console.data.notes.NotesRepository
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
    }
}
