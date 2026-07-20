package io.amar.console.sync.outbox

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.OutboxRow
import io.amar.console.sync.SyncBusClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

/**
 * The durable offline mutation queue — the heart of "compose offline, flush
 * on reconnect". Port of the SPA's src/db/sync-queue.ts semantics:
 *
 *  - enqueue() writes a pending Room row (with a minted dedupeToken) and
 *    schedules a drain: an in-process 500ms debounce for the fast path, plus
 *    a WorkManager NETWORK_CONNECTED unique work as the durable backstop
 *    (survives process death; fires when connectivity returns).
 *  - drain() walks pending rows oldest-first; each row's handler performs the
 *    hub call. Success → row deleted. Failure → retryCount++, back to
 *    pending until MAX_RETRIES, then terminal `failed` (visible in the queue
 *    screen; chat echoes get a sendFailed badge). A handler may also return
 *    Conflict, parking the row for user resolution.
 *  - handlers are registered per action type by each domain repository.
 */
class Outbox(
    private val context: Context,
    private val scope: CoroutineScope,
    val db: ConsoleDb,
    val hub: HubClient,
    val syncBus: SyncBusClient,
    /** Durable backstop scheduler — WorkManager in prod, injectable for tests
     *  (WorkManager needs an initialized Application context). */
    private val durableScheduler: (Context) -> Unit = ::scheduleWorkManagerDrain,
) {
    sealed class Result {
        data object Done : Result()
        data class Retry(val error: String) : Result()
        data class Fail(val error: String) : Result()
        data class Conflict(val error: String) : Result()
    }

    fun interface Handler {
        suspend fun handle(row: OutboxRow, outbox: Outbox): Result
    }

    private val handlers = mutableMapOf<String, Handler>()
    private val drainMutex = Mutex()
    private var debounceJob: Job? = null

    companion object {
        const val MAX_RETRIES = 3
        private const val WORK_NAME = "outbox-drain"

        fun scheduleWorkManagerDrain(context: Context) {
            val work = OneTimeWorkRequestBuilder<OutboxWorker>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, work)
        }
    }

    fun register(type: String, handler: Handler) {
        handlers[type] = handler
    }

    /** Mint a dedupe token: stable for the row's lifetime, unique across rows. */
    fun mintToken(): String = "apk-${UUID.randomUUID()}"

    suspend fun enqueue(
        type: String,
        payloadJson: String,
        entityId: String? = null,
        dedupeToken: String = mintToken(),
    ): Long {
        val id = db.outbox().insert(
            OutboxRow(
                type = type,
                payloadJson = payloadJson,
                dedupeToken = dedupeToken,
                entityId = entityId,
                createdAt = System.currentTimeMillis(),
                status = "pending",
            )
        )
        scheduleDrain()
        return id
    }

    /** Undo path: drop a not-yet-flushed action (SPA removeByThread). */
    suspend fun cancel(entityId: String, type: String) {
        db.outbox().removeByEntity(entityId, type)
    }

    /** Debounced in-process drain + durable WorkManager backstop. */
    fun scheduleDrain() {
        debounceJob?.cancel()
        debounceJob = scope.launch {
            delay(500)
            drain()
        }
        runCatching { durableScheduler(context) }
    }

    /** Crash recovery, called once at app start. */
    suspend fun resetStuckProcessing() {
        db.outbox().resetStuckProcessing()
        // Rows that failed with 404/410 predate the handlers treating "already
        // gone" as success — requeue so the next drain resolves them to Done.
        db.outbox().requeueGoneFailures()
    }

    /**
     * Flush pending rows sequentially (oldest first — ordering matters for
     * e.g. two messages to the same room). Single-flight.
     * @return true if the backlog is clear (nothing pending remains).
     */
    suspend fun drain(): Boolean = drainMutex.withLock {
        val rows = db.outbox().pending()
        var allClear = true
        for (row in rows) {
            val handler = handlers[row.type]
            if (handler == null) {
                // Unknown type (e.g. row from a newer app version) — park it.
                db.outbox().setStatus(row.id, "failed", "no handler for ${row.type}")
                continue
            }
            db.outbox().setStatus(row.id, "processing")
            val result = try {
                handler.handle(row, this)
            } catch (e: Exception) {
                Result.Retry(e.message ?: e.javaClass.simpleName)
            }
            when (result) {
                is Result.Done -> db.outbox().delete(row.id)
                is Result.Fail -> {
                    db.outbox().setStatus(row.id, "failed", result.error)
                    allClear = false
                }
                is Result.Conflict -> {
                    db.outbox().setStatus(row.id, "conflict", result.error)
                    allClear = false
                }
                is Result.Retry -> {
                    if (row.retryCount + 1 >= MAX_RETRIES) {
                        db.outbox().setStatus(row.id, "failed", result.error)
                        handlers[row.type + ":onFailed"]?.handle(row, this)
                    } else {
                        db.outbox().markRetry(row.id, result.error)
                    }
                    allClear = false
                }
            }
        }
        allClear
    }
}
