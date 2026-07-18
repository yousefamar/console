package io.amar.console.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.amar.console.ConsoleApp
import java.util.concurrent.TimeUnit

/**
 * Daily cache-bound enforcement (plan B2): chat 100 msgs/room, mail bodies
 * newest-50, calendar window, feeds 50/feed, agents 200 msgs/session.
 * Keeps the DB "lightweight — bounded windows, not full history".
 */
class PruneWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val g = (applicationContext as ConsoleApp).graph
        runCatching { g.chat.prune() }
        runCatching { g.mail.prune() }
        runCatching { g.calendar.prune() }
        runCatching { g.feeds.prune() }
        runCatching { g.agents.prune() }
        return Result.success()
    }

    companion object {
        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<PruneWorker>(1, TimeUnit.DAYS).build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork("cache-prune", ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}
