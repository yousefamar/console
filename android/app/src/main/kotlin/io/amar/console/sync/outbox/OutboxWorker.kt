package io.amar.console.sync.outbox

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import io.amar.console.ConsoleApp

/**
 * Durable outbox drain — WorkManager fires this when the network constraint
 * is satisfied, including after process death. The in-process debounce drain
 * covers the fast path; this is the backstop that makes offline queuing
 * actually reliable.
 */
class OutboxWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val graph = (applicationContext as ConsoleApp).graph
        val clear = graph.outbox.drain()
        // Not clear = something is still pending (hub unreachable through a
        // live network, or retries left). Let WorkManager back off and re-run.
        return if (clear) Result.success() else Result.retry()
    }
}
