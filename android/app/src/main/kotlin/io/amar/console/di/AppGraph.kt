package io.amar.console.di

import android.content.Context
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
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
}
