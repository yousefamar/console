package io.amar.console.data.feeds

import androidx.room.withTransaction
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.FeedItemRow
import io.amar.console.data.db.FeedReadRow
import io.amar.console.data.db.FeedRow
import io.amar.console.data.db.MetaRow
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
        /** Meta KV key holding pending "mark unread" removals (JSON string array). */
        const val META_PENDING_REMOVE = "feeds:pendingRemove"
    }

    fun observeItems(): Flow<List<FeedItemRow>> = db.feeds().observeRecent(VIEW_LIMIT)
    fun observeFeeds(): Flow<List<FeedRow>> = db.feeds().observeFeeds()
    fun observeReadIds(): Flow<List<String>> = db.feeds().observeReadIds()
    suspend fun itemById(id: String): FeedItemRow? = db.feeds().itemById(id)
    suspend fun search(q: String): List<FeedItemRow> = db.feeds().searchItems(q)

    suspend fun markRead(itemId: String) {
        db.feeds().upsertRead(listOf(FeedReadRow(itemId, pendingSync = true)))
        removePendingRemove(listOf(itemId))
        enqueueReadSync()
    }

    /** Mark-all for the ids currently visible (folder/scope filtering is the UI's). */
    suspend fun markAllRead(itemIds: List<String>) {
        if (itemIds.isEmpty()) return
        db.feeds().upsertRead(itemIds.map { FeedReadRow(it, pendingSync = true) })
        removePendingRemove(itemIds)
        enqueueReadSync()
    }

    suspend fun markUnread(itemId: String) {
        db.feeds().deleteRead(itemId)
        // Removal also rides the coalesced sync (as `remove`) — tracked in the
        // meta KV (no dedicated table; schema is frozen at v8 for this batch).
        addPendingRemove(itemId)
        enqueueReadSync()
    }

    internal suspend fun pendingRemoveIds(): List<String> =
        db.meta().get(META_PENDING_REMOVE)?.let { raw ->
            runCatching {
                (json.parseToJsonElement(raw) as? JsonArray)
                    ?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() }
            }.getOrNull()
        } ?: emptyList()

    private suspend fun addPendingRemove(itemId: String) {
        val ids = (pendingRemoveIds() + itemId).distinct()
        db.meta().put(MetaRow(META_PENDING_REMOVE, JsonArray(ids.map { JsonPrimitive(it) }).toString()))
    }

    private suspend fun removePendingRemove(itemIds: List<String>) {
        val ids = pendingRemoveIds() - itemIds.toSet()
        if (ids.isEmpty()) db.meta().delete(META_PENDING_REMOVE)
        else db.meta().put(MetaRow(META_PENDING_REMOVE, JsonArray(ids.map { JsonPrimitive(it) }).toString()))
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
                val removals = pendingRemoveIds()
                if (pending.isNotEmpty() || removals.isNotEmpty()) {
                    val body = buildJsonObject {
                        if (pending.isNotEmpty()) {
                            put("add", buildJsonArray { pending.forEach { add(JsonPrimitive(it)) } })
                        }
                        if (removals.isNotEmpty()) {
                            put("remove", buildJsonArray { removals.forEach { add(JsonPrimitive(it)) } })
                        }
                    }
                    hub.put("/feeds/read", body.toString())
                    db.feeds().markSynced(pending)
                    db.meta().delete(META_PENDING_REMOVE)
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

            val pendingRemove = pendingRemoveIds().toSet()
            db.withTransaction {
                val rows = items.mapNotNull { itemRow(it) }
                if (rows.isNotEmpty()) db.feeds().upsertItems(rows)
                // Hub read-state merges DOWN (additive; local pending stays —
                // and a local "mark unread" that hasn't flushed yet must not
                // be resurrected by the hub's stale read set).
                val down = readIds.filter { it !in pendingRemove }
                if (down.isNotEmpty()) {
                    db.feeds().upsertRead(down.map { FeedReadRow(it, pendingSync = false) })
                }
            }
        }
        // Push any local-only read marks (or unread removals) up.
        if (db.feeds().pendingReadIds().isNotEmpty() || pendingRemoveIds().isNotEmpty()) enqueueReadSync()
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
