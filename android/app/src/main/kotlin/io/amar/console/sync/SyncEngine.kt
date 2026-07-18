package io.amar.console.sync

import io.amar.console.core.AppLifecycle
import io.amar.console.core.Connectivity
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Orchestrates the sync lifecycle:
 *  - starts/stops the SyncBus WS with app foreground (WhatsApp model — no
 *    background socket in the main process; PushService owns background
 *    freshness via notifications, and opening the app reconciles).
 *  - wires the three reconcile triggers (connect / foreground / online) into
 *    one debounced single-flight Reconciler.
 *  - per-domain reconcilers register via [addDomain]; M2+ fill these in
 *    (chat: matrix.resume + chat-rooms.snapshotSince; mail: /mail/history; …).
 */
class SyncEngine(
    private val scope: CoroutineScope,
    val db: ConsoleDb,
    val hub: HubClient,
    val syncBus: SyncBusClient,
    val outbox: Outbox,
) {
    fun interface DomainReconciler {
        suspend fun reconcile()
    }

    private val domains = mutableListOf<Pair<String, DomainReconciler>>()

    private val reconciler = Reconciler(scope) {
        for ((_, domain) in domains) {
            runCatching { domain.reconcile() }
        }
        // A reconnect is also the moment to flush anything queued offline.
        outbox.drain()
    }

    fun addDomain(name: String, domain: DomainReconciler) {
        domains.add(name to domain)
    }

    fun start() {
        scope.launch { outbox.resetStuckProcessing() }

        // WS lives while the app is foreground.
        scope.launch {
            AppLifecycle.foregroundFlow.collectLatest { fg ->
                if (fg) {
                    syncBus.start()
                    reconciler.trigger()
                } else {
                    syncBus.stop()
                }
            }
        }

        syncBus.onConnect { reconciler.trigger() }

        scope.launch {
            Connectivity.onlineFlow.collectLatest { online ->
                if (online) {
                    reconciler.trigger()
                    outbox.scheduleDrain()
                }
            }
        }
    }

    fun triggerReconcile() = reconciler.trigger()
}
