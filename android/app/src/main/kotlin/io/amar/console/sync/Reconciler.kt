package io.amar.console.sync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
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
            // Detach the pass from the debounce job: trigger()'s cancel must
            // only coalesce WAITING debounces. When run() executed inside
            // this job, a trigger landing mid-pass cancelled the pass — and
            // the finally's suspending mutex.withLock throws in a cancelled
            // coroutine, so `running`/`_syncing` stayed true FOREVER: the
            // perma-"Syncing" chip, with reconcile (matrix.resume catch-up)
            // dead until app restart. Same bug class as the outbox drain.
            scope.launch { run() }
        }
    }

    /** Run a pass NOW (no debounce) and suspend until the data is fresh:
     *  either this call ran the pass itself, or it marked an in-flight pass
     *  dirty and waited out its re-run. The completed return is the caller's
     *  "safe to tear the borrowed transport down" signal (background sync). */
    suspend fun runNow() {
        run()
        _syncing.first { !it }
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
            // Cap dirty re-runs: with launcher mode every home-press triggers,
            // and an unbounded loop read as a permanently-syncing UI. Any
            // trigger beyond the cap lands in the NEXT debounced run instead.
            var passes = 0
            do {
                mutex.withLock { dirty = false }
                runCatching { action() }
            } while (mutex.withLock { dirty } && ++passes < 3)
            _lastSyncedAt.value = System.currentTimeMillis()
        } finally {
            // NonCancellable: state restoration must survive scope teardown —
            // a cancelled suspending withLock would leak running=true.
            kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) {
                mutex.withLock { running = false }
                _syncing.value = false
            }
        }
    }
}
