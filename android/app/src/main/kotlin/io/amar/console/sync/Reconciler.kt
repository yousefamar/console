package io.amar.console.sync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Debounced single-flight reconcile — verbatim port of the SPA's
 * `runReconcile` in src/hooks/useSync.ts.
 *
 * Semantics:
 *  - trigger() coalesces bursts (150ms debounce): connect + foreground +
 *    network-regained often fire together.
 *  - only one reconcile runs at a time; a trigger DURING a run sets a dirty
 *    flag and re-runs once when the current pass finishes (never drops a
 *    wake signal, never runs two passes concurrently).
 */
class Reconciler(
    private val scope: CoroutineScope,
    private val debounceMs: Long = 150,
    private val action: suspend () -> Unit,
) {
    private val mutex = Mutex()
    private var running = false
    private var dirty = false
    private var debounceJob: Job? = null

    /** Observable sync status for the UI freshness indicator. */
    private val _syncing = kotlinx.coroutines.flow.MutableStateFlow(false)
    val syncing: kotlinx.coroutines.flow.StateFlow<Boolean> = _syncing

    /** Epoch ms of the last COMPLETED reconcile pass (0 = never this process). */
    private val _lastSyncedAt = kotlinx.coroutines.flow.MutableStateFlow(0L)
    val lastSyncedAt: kotlinx.coroutines.flow.StateFlow<Long> = _lastSyncedAt

    fun trigger() {
        debounceJob?.cancel()
        debounceJob = scope.launch {
            delay(debounceMs)
            run()
        }
    }

    private suspend fun run() {
        mutex.withLock {
            if (running) {
                dirty = true
                return
            }
            running = true
        }
        _syncing.value = true
        try {
            do {
                mutex.withLock { dirty = false }
                runCatching { action() }
                // If a trigger arrived mid-run, loop once more.
            } while (mutex.withLock { dirty })
            _lastSyncedAt.value = System.currentTimeMillis()
        } finally {
            mutex.withLock { running = false }
            _syncing.value = false
        }
    }
}
