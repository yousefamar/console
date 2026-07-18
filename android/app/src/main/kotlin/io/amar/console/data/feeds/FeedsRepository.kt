package io.amar.console.data.feeds

import androidx.room.withTransaction
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.FeedItemRow
import io.amar.console.data.db.FeedReadRow
import io.amar.console.data.db.FeedRow
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Feeds: offline reading of already-downloaded items + additive read-state
 * sync. GET /feeds/items?since= is a live origin refetch (slow) so it runs
 * only on reconcile; the hub's PUT /feeds/read {add,remove} is an idempotent
 * set-merge — perfect outbox target. All pending read marks coalesce into ONE
 * PUT at flush (the SPA pushes 500-chunks; our volumes are smaller).
 */
class FeedsRepository(
    private val db: ConsoleDb,
    private val hub: HubClient,
    private val outbox: Outbox,
) {
    private val json = Json { ignoreUnknownKeys = true }

    companion object {
        const val TYPE_READ_SYNC = "feedsReadSync"
        const val ITEMS_PER_FEED = 50
        const val VIEW_LIMIT = 200
    }

    fun observeItems(): Flow<List<FeedItemRow>> = db.feeds().observeRecent(VIEW_LIMIT)
    fun observeFeeds(): Flow<List<FeedRow>> = db.feeds().observeFeeds()
    fun observeReadIds(): Flow<List<String>> = db.feeds().observeReadIds()
    suspend fun itemById(id: String): FeedItemRow? = db.feeds().itemById(id)

    suspend fun markRead(itemId: String) {
        db.feeds().upsertRead(listOf(FeedReadRow(itemId, pendingSync = true)))
        enqueueReadSync()
    }

    suspend fun markUnread(itemId: String) {
        db.feeds().deleteRead(itemId)
        // Removal also rides the coalesced sync (as `remove`).
        enqueueReadSync()
    }

    private suspend fun enqueueReadSync() {
        // Single logical row: coalesce by cancelling any pending one first.
        outbox.cancel("feeds", TYPE_READ_SYNC)
        outbox.enqueue(TYPE_READ_SYNC, "{}", entityId = "feeds")
    }

    fun registerOutboxHandlers() {
        outbox.register(TYPE_READ_SYNC) { _, _ ->
            try {
                val pending = db.feeds().pendingReadIds()
                if (pending.isNotEmpty()) {
                    val body = buildJsonObject {
                        put("add", buildJsonArray { pending.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
                    }
                    hub.put("/feeds/read", body.toString())
                    db.feeds().markSynced(pending)
                }
                Outbox.Result.Done
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }
    }

    suspend fun reconcile() {
        // Subscriptions (names/folders for grouping).
        runCatching {
            val resp = hub.get("/feeds")
            val feeds = (json.parseToJsonElement(resp) as? JsonArray)
                ?.mapNotNull { it as? JsonObject } ?: emptyList()
            val rows = feeds.mapNotNull { f ->
                val id = f["id"]?.jsonPrimitive?.content ?: return@mapNotNull null
                FeedRow(id, f["title"]?.jsonPrimitive?.content ?: id, f["folder"]?.jsonPrimitive?.content)
            }
            if (rows.isNotEmpty()) db.feeds().upsertFeeds(rows)
        }

        // Items + hub read-state convergence. `since` bounded to 7d back so
        // the origin refetch stays cheap; the hub caps items per feed anyway.
        runCatching {
            val since = java.time.Instant.ofEpochMilli(System.currentTimeMillis() - 7L * 24 * 3600 * 1000).toString()
            val resp = hub.get("/feeds/items?since=$since")
            val obj = json.parseToJsonElement(resp).jsonObject
            val items = (obj["items"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
            val readIds = (obj["readIds"] as? JsonArray)
                ?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList()

            db.withTransaction {
                val rows = items.mapNotNull { itemRow(it) }
                if (rows.isNotEmpty()) db.feeds().upsertItems(rows)
                // Hub read-state merges DOWN (additive; local pending stays).
                if (readIds.isNotEmpty()) {
                    db.feeds().upsertRead(readIds.map { FeedReadRow(it, pendingSync = false) })
                }
            }
        }
        // Push any local-only read marks up.
        val pending = db.feeds().pendingReadIds()
        if (pending.isNotEmpty()) enqueueReadSync()
    }

    private fun itemRow(item: JsonObject): FeedItemRow? {
        val id = item["id"]?.jsonPrimitive?.content ?: return null
        val feedId = item["feedId"]?.jsonPrimitive?.content ?: return null
        val published = item["publishedAt"]?.jsonPrimitive?.content
        val publishedMs = published?.let {
            runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull()
                ?: it.toLongOrNull()
        } ?: item["publishedAt"]?.jsonPrimitive?.longOrNull ?: 0L
        return FeedItemRow(
            id = id,
            feedId = feedId,
            title = item["title"]?.jsonPrimitive?.content ?: "(untitled)",
            link = item["link"]?.jsonPrimitive?.content,
            content = item["content"]?.jsonPrimitive?.content,
            snippet = item["contentSnippet"]?.jsonPrimitive?.content,
            publishedAt = publishedMs,
            imageUrl = item["imageUrl"]?.jsonPrimitive?.content,
        )
    }

    suspend fun prune() {
        for (feedId in db.feeds().feedsWithItems()) {
            db.feeds().pruneFeed(feedId, ITEMS_PER_FEED)
        }
    }
}
