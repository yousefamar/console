package io.amar.console.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.amar.console.ConsoleApp
import java.util.concurrent.TimeUnit

/**
 * Periodic background freshness backstop (^brisk-moth): every ~15 min (WM's
 * floor; Doze batches it further) borrow the sync WS for ONE reconcile pass,
 * so opening the app after hours away is a small delta, not a minutes-long
 * catch-up. Push-triggered [SyncEngine.backgroundSync] handles the common
 * case seconds after the data changes; this catches what pushes miss
 * (silent deltas, missed pushes, PushService dead).
 */
class SyncWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val g = (applicationContext as ConsoleApp).graph
        runCatching { g.syncEngine.backgroundSync(force = true) }
        return Result.success()
    }

    companion object {
        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork("background-sync", ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}
