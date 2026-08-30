package io.amar.console.sync

import io.amar.console.core.AppLifecycle
import io.amar.console.core.Connectivity
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Orchestrates the sync lifecycle:
 *  - starts/stops the SyncBus WS with app foreground (WhatsApp model — no
 *    PERSISTENT background socket in the main process; PushService owns
 *    background notifications).
 *  - wires the three reconcile triggers (connect / foreground / online) into
 *    one debounced single-flight Reconciler.
 *  - [backgroundSync] is the freshness borrow: a data push (or the periodic
 *    SyncWorker) briefly brings the WS up, runs ONE reconcile pass, and tears
 *    it down again — so the resume gap stays small and opening the app is
 *    instant instead of a minutes-long catch-up.
 *  - per-domain reconcilers register via [addDomain]; M2+ fill these in
 *    (chat: matrix.resume + chat-rooms.snapshotSince; mail: /mail/history; …).
 */
class SyncEngine(
    private val scope: CoroutineScope,
    val db: ConsoleDb,
    val hub: HubClient,
    val syncBus: SyncBusClient,
    val outbox: Outbox,
    /** Injectable so the unreachable-hub test doesn't wait 20 real seconds. */
    private val bgConnectTimeoutMs: Long = BG_CONNECT_TIMEOUT_MS,
    /** Injectable foreground probe: tests must NOT flip the process-wide
     *  AppLifecycle — Robolectric boots the real ConsoleApp, whose own graph
     *  reacts to the flip and pollutes the JVM with live sockets. */
    private val isForeground: () -> Boolean = { AppLifecycle.foregroundFlow.value },
) {
    fun interface DomainReconciler {
        suspend fun reconcile()
    }

    private val domains = mutableListOf<Pair<String, DomainReconciler>>()

    private val reconciler = Reconciler(scope) {
        // Hub-synced prefs first (cheap; DND gates notifications).
        runCatching { io.amar.console.core.HubPrefs.refresh(hub) }
        for ((name, domain) in domains) {
            // A single wedged domain (hung request past OkHttp timeouts, dead
            // RPC) must not pin the whole pass — and with launcher mode the
            // pass runs on every home-press, so a permanent hang read as a
            // permanent "Syncing…" pill. 45s ceiling per domain.
            runCatching {
                kotlinx.coroutines.withTimeout(45_000) { domain.reconcile() }
            }.onFailure { android.util.Log.w("SyncEngine", "domain $name reconcile failed: $it") }
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

    /** UI freshness surface: is a reconcile pass running, and when did the
     *  last one complete. */
    val syncing get() = reconciler.syncing
    val lastSyncedAt get() = reconciler.lastSyncedAt

    // --- Background freshness borrow (^brisk-moth) ----------------------- //

    private val bgSyncRunning = java.util.concurrent.atomic.AtomicBoolean(false)
    @Volatile private var lastBgSyncAt = 0L

    /** One reconcile pass while the app is BACKGROUNDED, borrowing the sync
     *  WS just for the pass — so the resume gap stays small and opening the
     *  app is instant instead of a minutes-long catch-up. Callers:
     *  PushService on any data-bearing push (throttled here to one pass per
     *  [BG_MIN_INTERVAL_MS] — a chat storm must not hold the socket open by
     *  proxy), and SyncWorker as the periodic backstop (`force` bypasses the
     *  throttle; its own cadence is the limit). Foreground calls just feed
     *  the normal debounced reconcile — the WS is already up. */
    suspend fun backgroundSync(force: Boolean = false) {
        if (isForeground()) { reconciler.trigger(); return }
        val now = System.currentTimeMillis()
        if (!force && now - lastBgSyncAt < BG_MIN_INTERVAL_MS) return
        if (!bgSyncRunning.compareAndSet(false, true)) return
        try {
            lastBgSyncAt = now
            syncBus.start()
            val connected = runCatching {
                kotlinx.coroutines.withTimeout(bgConnectTimeoutMs) {
                    syncBus.connectedFlow.first { it }
                }
            }.isSuccess
            if (connected) runCatching { reconciler.runNow() }
        } finally {
            // Tear the borrow down unless the user opened the app mid-pass
            // (the foreground collector owns the socket then). stop() also
            // kills the reconnect loop a failed connect would otherwise leave
            // burning in the background.
            if (!isForeground()) {
                syncBus.stop()
                // Close the flip race: foreground turned on between the check
                // and the stop → re-arm the socket the collector expects.
                if (isForeground()) syncBus.start()
            }
            bgSyncRunning.set(false)
        }
    }

    companion object {
        const val BG_MIN_INTERVAL_MS = 5 * 60_000L
        const val BG_CONNECT_TIMEOUT_MS = 20_000L
    }
}
