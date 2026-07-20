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
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
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
    suspend fun feedById(id: String): FeedRow? = db.feeds().feedById(id)
    suspend fun search(q: String): List<FeedItemRow> = db.feeds().searchItems(q)

    /** Mark every unread item of one feed read (bulk), coalesced sync. */
    suspend fun markFeedRead(feedId: String) {
        val ids = db.feeds().itemIdsForFeed(feedId)
        if (ids.isEmpty()) return
        markAllRead(ids)
    }

    /** Mark every unread item across a folder's feeds read. */
    suspend fun markFolderRead(feedIds: List<String>) {
        if (feedIds.isEmpty()) return
        val ids = db.feeds().itemIdsForFeeds(feedIds)
        if (ids.isEmpty()) return
        markAllRead(ids)
    }

    // --- Subscription CRUD (online; refetch on success, matches SPA) --- //

    /** POST /feeds {xmlUrl, folder?, fullText?}; returns true on success. */
    suspend fun addFeed(xmlUrl: String, folder: String?, fullText: Boolean): Boolean {
        val body = buildJsonObject {
            put("xmlUrl", JsonPrimitive(xmlUrl))
            if (!folder.isNullOrBlank()) put("folder", JsonPrimitive(folder))
            if (fullText) put("fullText", JsonPrimitive(true))
        }
        return runCatching {
            hub.post("/feeds", body.toString())
            reconcile()
            true
        }.getOrDefault(false)
    }

    /** PUT /feeds/:id {title?, folder?, fullText?, maxItems?}; retrims on maxItems. */
    suspend fun updateFeed(
        feedId: String,
        title: String? = null,
        folder: String? = null,
        fullText: Boolean? = null,
        maxItems: Int? = null,
        clearMaxItems: Boolean = false,
    ): Boolean = runCatching {
        val body = buildJsonObject {
            if (title != null) put("title", JsonPrimitive(title))
            if (folder != null) put("folder", JsonPrimitive(folder))
            if (fullText != null) put("fullText", JsonPrimitive(fullText))
            if (clearMaxItems) put("maxItems", kotlinx.serialization.json.JsonNull)
            else if (maxItems != null) put("maxItems", JsonPrimitive(maxItems))
        }
        hub.put("/feeds/$feedId", body.toString())
        // Reflect locally + retrim so the item cap applies without a full sync.
        db.feeds().feedById(feedId)?.let { existing ->
            db.feeds().upsertFeeds(listOf(existing.copy(
                title = title ?: existing.title,
                folder = folder ?: existing.folder,
                fullText = fullText ?: existing.fullText,
                maxItems = if (clearMaxItems) null else (maxItems ?: existing.maxItems),
            )))
        }
        db.feeds().pruneFeed(feedId, effectiveCap(feedId))
        true
    }.getOrDefault(false)

    /** DELETE /feeds/:id; purge the feed's items + read entries locally. */
    suspend fun deleteFeed(feedId: String): Boolean = runCatching {
        hub.delete("/feeds/$feedId")
        val ids = db.feeds().itemIdsForFeed(feedId)
        db.feeds().deleteItemsForFeed(feedId)
        for (id in ids) db.feeds().deleteRead(id)
        db.feeds().deleteFeed(feedId)
        true
    }.getOrDefault(false)

    /** POST /feeds/import-opml {opmlXml}; refetch feeds only (items would be slow). */
    suspend fun importOpml(opmlXml: String): Boolean = runCatching {
        val body = buildJsonObject { put("opmlXml", JsonPrimitive(opmlXml)) }
        hub.post("/feeds/import-opml", body.toString())
        reconcileFeedsOnly()
        true
    }.getOrDefault(false)

    /** Existing folder names (for the add-feed folder autocomplete). */
    suspend fun folderNames(): List<String> =
        db.feeds().observeFeeds().first().mapNotNull { it.folder }.distinct().sorted()

    private suspend fun effectiveCap(feedId: String): Int {
        val cap = db.feeds().feedById(feedId)?.maxItems
        return if (cap != null && cap > 0) cap else ITEMS_PER_FEED
    }

    /** HN comment tree (depth 3) — raw JSON from GET /feeds/hn/:id. */
    suspend fun hnComments(itemId: String): String? =
        runCatching { hub.get("/feeds/hn/$itemId?depth=3") }.getOrNull()

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

    /** Refetch just the subscription list (folders/metadata) — used by OPML
     *  import, which deliberately skips the slow all-items refetch. */
    suspend fun reconcileFeedsOnly() {
        runCatching {
            val resp = hub.get("/feeds")
            val feeds = (json.parseToJsonElement(resp) as? JsonArray)
                ?.mapNotNull { it as? JsonObject } ?: emptyList()
            val rows = feeds.mapNotNull { feedRow(it) }
            if (rows.isNotEmpty()) {
                db.feeds().upsertFeeds(rows)
                db.feeds().observeFeeds().first() // no-op; keeps flow warm
            }
        }
    }

    private fun feedRow(f: JsonObject): FeedRow? {
        val id = f["id"]?.jsonPrimitive?.content ?: return null
        return FeedRow(
            id = id,
            title = f["title"]?.jsonPrimitive?.content ?: id,
            folder = f["folder"]?.jsonPrimitive?.content,
            xmlUrl = f["xmlUrl"]?.jsonPrimitive?.content,
            siteUrl = f["siteUrl"]?.jsonPrimitive?.content,
            fullText = f["fullText"]?.jsonPrimitive?.booleanOrNull ?: false,
            maxItems = f["maxItems"]?.jsonPrimitive?.content?.toIntOrNull(),
            addedAt = f["addedAt"]?.jsonPrimitive?.content,
        )
    }

    suspend fun reconcile() {
        // Subscriptions (names/folders/metadata for grouping + info sheet).
        runCatching {
            val resp = hub.get("/feeds")
            val feeds = (json.parseToJsonElement(resp) as? JsonArray)
                ?.mapNotNull { it as? JsonObject } ?: emptyList()
            val rows = feeds.mapNotNull { feedRow(it) }
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
            val currentItemIds = (obj["currentItemIds"] as? JsonArray)
                ?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() }

            val pendingRemove = pendingRemoveIds().toSet()
            db.withTransaction {
                val rows = items.mapNotNull { itemRow(it) }
                if (rows.isNotEmpty()) db.feeds().upsertItems(rows)
                // Hub-authoritative reconciliation: drop items the hub no longer
                // surfaces (rolled off the source feed). NEVER delete feedRead
                // entries — a rolled-off-then-resurfaced item must stay read.
                if (currentItemIds != null && currentItemIds.isNotEmpty()) {
                    val hubSet = currentItemIds.toSet()
                    val orphans = db.feeds().allItemIds().filter { it !in hubSet }
                    if (orphans.isNotEmpty()) db.feeds().deleteItems(orphans)
                }
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
            author = item["author"]?.jsonPrimitive?.content,
        )
    }

    suspend fun prune() {
        // Per-feed cap honours a feed's maxItems override, else the 50 default.
        for (feedId in db.feeds().feedsWithItems()) {
            db.feeds().pruneFeed(feedId, effectiveCap(feedId))
        }
    }
}
