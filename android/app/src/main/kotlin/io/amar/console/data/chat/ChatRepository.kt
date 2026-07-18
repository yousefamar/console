package io.amar.console.data.chat

import androidx.room.withTransaction
import io.amar.console.core.HubClient
import io.amar.console.data.db.ChatMessageRow
import io.amar.console.data.db.ChatRoomRow
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.MetaRow
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * Chat domain: hub-authoritative room list + client-cached message windows +
 * offline outbox sends. The SPA equivalents are chat-rooms-subscribe.ts
 * (rooms), matrix/sync.ts ingestHubDelta (messages), store/chat.ts
 * sendMessage (echo + queue).
 *
 * Cursor rule (load-bearing): `matrix:lastBatch` advances in the SAME Room
 * transaction as the ingested events, so a crash can't skip a gap.
 */
class ChatRepository(
    private val db: ConsoleDb,
    private val hub: HubClient,
    private val syncBus: SyncBusClient,
    private val outbox: Outbox,
) {
    private val json = Json { ignoreUnknownKeys = true }

    companion object {
        const val CURSOR_KEY = "matrix:lastBatch"
        const val ROOMS_SEQ_KEY = "chatRooms:seq"
        const val TYPE_SEND = "chatSend"
        const val TYPE_MARK_READ = "chatMarkRead"
        const val TYPE_MARK_UNREAD = "chatMarkUnread"
        const val TYPE_SNOOZE = "chatSnooze"
        const val TYPE_SEND_FILE = "chatSendFile"
        const val TYPE_REACT = "chatReact"
        /** Timeline cache bound per room (paginate loads more transiently). */
        const val ROOM_CACHE_LIMIT = 100
    }

    // ---------------------------------------------------------------- //
    // Reads (UI)

    fun observeRooms(): Flow<List<ChatRoomRow>> = db.chatRooms().observeAll()
    fun observeRoom(id: String): Flow<ChatRoomRow?> = db.chatRooms().observeRoom(id)
    fun observeMessages(roomId: String, limit: Int): Flow<List<ChatMessageRow>> =
        db.chatMessages().observeRecent(roomId, limit)

    // ---------------------------------------------------------------- //
    // Mutations (optimistic + outbox)

    /** Send text: local echo row now, durable queue, flush when online.
     *  [replyToEventId] adds the m.in_reply_to relation. */
    suspend fun sendText(roomId: String, body: String, replyToEventId: String? = null) {
        val txnId = outbox.mintToken()
        val echoId = "~${System.currentTimeMillis()}.${(0..999999).random()}"
        val replyMeta = replyToEventId?.let { target ->
            val t = db.chatMessages().byId(target)
            buildJsonObject {
                put("eventId", target)
                t?.let {
                    put("sender", it.senderName ?: it.senderId)
                    put("body", (it.body ?: "").take(120))
                }
            }.toString()
        }
        db.chatMessages().upsertAll(
            listOf(
                ChatMessageRow(
                    id = echoId, roomId = roomId, timestamp = System.currentTimeMillis(),
                    senderId = "me", senderName = "me", body = body, msgtype = "m.text",
                    mediaMxc = null, mediaMime = null, encryptedFileJson = null,
                    replyToJson = replyMeta, localEcho = true, txnId = txnId,
                )
            )
        )
        val payload = buildJsonObject {
            put("roomId", roomId)
            put("echoId", echoId)
            put("body", body)
            replyToEventId?.let { put("replyTo", it) }
        }
        outbox.enqueue(TYPE_SEND, payload.toString(), entityId = roomId, dedupeToken = txnId)
    }

    /** Send an emoji reaction (m.annotation). Optimistic aggregate + queued. */
    suspend fun sendReaction(roomId: String, targetEventId: String, emoji: String) {
        val row = db.chatMessages().byId(targetEventId)
        if (row != null) {
            val reactions = parseReactions(row.reactionsJson).toMutableMap()
            val senders = (reactions[emoji] ?: emptyList()).toMutableList()
            if ("me" !in senders) senders.add("me")
            reactions[emoji] = senders
            db.chatMessages().upsertAll(listOf(row.copy(reactionsJson = encodeReactions(reactions))))
        }
        val payload = buildJsonObject {
            put("roomId", roomId)
            put("targetEventId", targetEventId)
            put("emoji", emoji)
        }
        outbox.enqueue(TYPE_REACT, payload.toString(), entityId = roomId)
    }

    suspend fun markRead(roomId: String) {
        val latest = db.chatMessages().recent(roomId, 1).firstOrNull()
        val room = db.chatRooms().byId(roomId) ?: return
        // Optimistic local flip; the hub snapshot confirms via delta.
        db.chatRooms().upsertAll(listOf(room.copy(isUnread = false, unreadCount = 0, manualUnread = false)))
        val eventId = latest?.takeUnless { it.localEcho }?.id ?: room.lastReadEventId ?: return
        val payload = buildJsonObject { put("roomId", roomId); put("eventId", eventId) }
        outbox.enqueue(TYPE_MARK_READ, payload.toString(), entityId = roomId)
    }

    suspend fun markUnread(roomId: String) {
        val room = db.chatRooms().byId(roomId) ?: return
        db.chatRooms().upsertAll(listOf(room.copy(isUnread = true, manualUnread = true, unreadCount = maxOf(1, room.unreadCount))))
        outbox.enqueue(TYPE_MARK_UNREAD, buildJsonObject { put("roomId", roomId) }.toString(), entityId = roomId)
    }

    suspend fun snooze(roomId: String, untilMs: Long?) {
        val room = db.chatRooms().byId(roomId) ?: return
        db.chatRooms().upsertAll(listOf(room.copy(snoozedUntil = untilMs)))
        val payload = buildJsonObject {
            put("roomId", roomId)
            untilMs?.let { put("untilMs", it) }
        }
        outbox.enqueue(TYPE_SNOOZE, payload.toString(), entityId = roomId)
    }

    /**
     * Send an attachment (image/file/video/audio — hub picks msgtype by MIME).
     * The bytes are copied into an app-private spool file NOW (content URIs
     * don't survive process death), then a durable outbox row uploads via
     * POST /matrix/rooms/:id/send-file when online. Local echo shows the
     * spooled file immediately.
     */
    suspend fun sendAttachment(context: android.content.Context, roomId: String, uri: android.net.Uri, caption: String?) {
        val resolver = context.contentResolver
        val mime = resolver.getType(uri) ?: "application/octet-stream"
        val filename = queryDisplayName(resolver, uri) ?: "attachment"
        val spool = java.io.File(context.filesDir, "outbox-media").apply { mkdirs() }
        val spoolFile = java.io.File(spool, "${System.currentTimeMillis()}-$filename")
        resolver.openInputStream(uri)?.use { input ->
            spoolFile.outputStream().use { input.copyTo(it) }
        } ?: return

        val txnId = outbox.mintToken()
        val echoId = "~${System.currentTimeMillis()}.${(0..999999).random()}"
        db.chatMessages().upsertAll(
            listOf(
                ChatMessageRow(
                    id = echoId, roomId = roomId, timestamp = System.currentTimeMillis(),
                    senderId = "me", senderName = "me",
                    body = caption ?: filename,
                    msgtype = if (mime.startsWith("image/")) "m.image" else "m.file",
                    mediaMxc = null, mediaMime = mime,
                    encryptedFileJson = null, replyToJson = null,
                    localEcho = true, txnId = txnId,
                    localMediaPath = spoolFile.absolutePath,
                )
            )
        )
        val payload = buildJsonObject {
            put("roomId", roomId)
            put("echoId", echoId)
            put("path", spoolFile.absolutePath)
            put("filename", filename)
            put("mimeType", mime)
            caption?.let { put("caption", it) }
        }
        outbox.enqueue(TYPE_SEND_FILE, payload.toString(), entityId = roomId, dedupeToken = txnId)
    }

    private fun queryDisplayName(resolver: android.content.ContentResolver, uri: android.net.Uri): String? =
        runCatching {
            resolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull()

    /** Retry a failed echo: re-enqueue with the SAME txnId (safe — idempotent). */
    suspend fun retryFailed(echoId: String) {
        val echo = db.chatMessages().byId(echoId) ?: return
        val txnId = echo.txnId ?: outbox.mintToken()
        db.chatMessages().setSendFailed(echoId, false)
        val payload = buildJsonObject {
            put("roomId", echo.roomId)
            put("echoId", echoId)
            put("body", echo.body ?: "")
        }
        outbox.enqueue(TYPE_SEND, payload.toString(), entityId = echo.roomId, dedupeToken = txnId)
    }

    // ---------------------------------------------------------------- //
    // Outbox handlers

    fun registerOutboxHandlers() {
        outbox.register(TYPE_SEND) { row, _ ->
            if (!syncBus.connected) return@register Outbox.Result.Retry("hub disconnected")
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val roomId = p["roomId"]!!.jsonPrimitive.content
            val echoId = p["echoId"]!!.jsonPrimitive.content
            val body = p["body"]!!.jsonPrimitive.content
            try {
                val replyTo = p["replyTo"]?.jsonPrimitive?.content
                val result = syncBus.rpc("matrix", "sendEvent", buildJsonObject {
                    put("roomId", roomId)
                    put("type", "m.room.message")
                    putJsonObject("content") {
                        put("msgtype", "m.text")
                        put("body", body)
                        if (replyTo != null) {
                            putJsonObject("m.relates_to") {
                                putJsonObject("m.in_reply_to") { put("event_id", replyTo) }
                            }
                        }
                    }
                    put("txnId", row.dedupeToken)
                })
                val eventId = result.jsonObject["event_id"]?.jsonPrimitive?.content
                if (eventId != null) {
                    val echo = db.chatMessages().byId(echoId)
                    if (echo != null) {
                        db.chatMessages().replaceEcho(echoId, echo.copy(id = eventId, localEcho = false, sendFailed = false))
                    }
                }
                Outbox.Result.Done
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "send failed")
            }
        }
        // Terminal failure → sendFailed badge on the echo (WhatsApp model:
        // message stays visible with a retry affordance).
        outbox.register("$TYPE_SEND:onFailed") { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val echoId = p["echoId"]?.jsonPrimitive?.content
            if (echoId != null) db.chatMessages().setSendFailed(echoId, true)
            Outbox.Result.Done
        }

        val rpcHandler = { op: String ->
            Outbox.Handler { row, _ ->
                if (!syncBus.connected) return@Handler Outbox.Result.Retry("hub disconnected")
                try {
                    syncBus.rpc("chat-rooms", op, json.parseToJsonElement(row.payloadJson))
                    Outbox.Result.Done
                } catch (e: Exception) {
                    Outbox.Result.Retry(e.message ?: "$op failed")
                }
            }
        }
        outbox.register(TYPE_SEND_FILE) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val roomId = p["roomId"]!!.jsonPrimitive.content
            val echoId = p["echoId"]!!.jsonPrimitive.content
            val path = p["path"]!!.jsonPrimitive.content
            val file = java.io.File(path)
            if (!file.exists()) return@register Outbox.Result.Fail("spool file gone")
            try {
                val b64 = android.util.Base64.encodeToString(file.readBytes(), android.util.Base64.NO_WRAP)
                val body = buildJsonObject {
                    put("content", b64)
                    put("filename", p["filename"]!!.jsonPrimitive.content)
                    put("mimeType", p["mimeType"]!!.jsonPrimitive.content)
                    p["caption"]?.jsonPrimitive?.content?.let { put("caption", it) }
                }
                val resp = hub.post("/matrix/rooms/${java.net.URLEncoder.encode(roomId, "UTF-8")}/send-file", body.toString())
                val eventId = json.parseToJsonElement(resp).jsonObject["event_id"]?.jsonPrimitive?.content
                val echo = db.chatMessages().byId(echoId)
                if (echo != null && eventId != null) {
                    db.chatMessages().replaceEcho(echoId, echo.copy(id = eventId, localEcho = false))
                }
                file.delete()
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }
        outbox.register("$TYPE_SEND_FILE:onFailed") { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            p["echoId"]?.jsonPrimitive?.content?.let { db.chatMessages().setSendFailed(it, true) }
            Outbox.Result.Done
        }
        outbox.register(TYPE_REACT) { row, _ ->
            if (!syncBus.connected) return@register Outbox.Result.Retry("hub disconnected")
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            try {
                syncBus.rpc("matrix", "sendEvent", buildJsonObject {
                    put("roomId", p["roomId"]!!.jsonPrimitive.content)
                    put("type", "m.reaction")
                    putJsonObject("content") {
                        putJsonObject("m.relates_to") {
                            put("rel_type", "m.annotation")
                            put("event_id", p["targetEventId"]!!.jsonPrimitive.content)
                            put("key", p["emoji"]!!.jsonPrimitive.content)
                        }
                    }
                })
                Outbox.Result.Done
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "react failed")
            }
        }
        outbox.register(TYPE_MARK_READ, rpcHandler("markRead"))
        outbox.register(TYPE_MARK_UNREAD, rpcHandler("markUnread"))
        outbox.register(TYPE_SNOOZE, rpcHandler("snooze"))
    }

    // ---------------------------------------------------------------- //
    // Sync: live deltas + reconcile

    fun wireLiveDeltas(scope: kotlinx.coroutines.CoroutineScope) {
        // Handlers fire on the OkHttp WS reader thread — hop to a coroutine.
        syncBus.on("chat-rooms", "delta") { data ->
            scope.launch { runCatching { applyRoomsDelta(data.jsonObject) } }
        }
        syncBus.on("matrix", "delta") { data ->
            scope.launch { runCatching { ingestMatrixDelta(data.jsonObject) } }
        }
    }

    /** Connect-time reconcile: rooms via seq patch, messages via resume cursor. */
    suspend fun reconcile() {
        if (!syncBus.connected) return
        // 1. Rooms: snapshotSince with our persisted seq.
        val seq = db.meta().get(ROOMS_SEQ_KEY)?.toLongOrNull()
        val args = buildJsonObject { seq?.let { put("since", it) } }
        runCatching {
            val result = syncBus.rpc("chat-rooms", "snapshotSince", args)
            applyRoomsDelta(result.jsonObject, isSnapshot = true)
        }
        // 2. Messages: matrix.resume with our persisted next_batch.
        val since = db.meta().get(CURSOR_KEY)
        runCatching {
            val resumeArgs = buildJsonObject { since?.let { put("since", it) } }
            val delta = syncBus.rpc("matrix", "resume", resumeArgs, timeoutMs = 120_000)
            ingestMatrixDelta(delta.jsonObject)
        }
    }

    /** Apply a chat-rooms envelope: patch {seq,partial,changed,removed} or
     *  full {seq,data}. Full snapshots prune rooms the hub no longer has. */
    internal suspend fun applyRoomsDelta(env: JsonObject, isSnapshot: Boolean = false) {
        val seq = env["seq"]?.jsonPrimitive?.longOrNull ?: return
        val lastSeen = db.meta().get(ROOMS_SEQ_KEY)?.toLongOrNull() ?: 0L
        if (seq <= lastSeen) return
        val partial = env["partial"]?.jsonPrimitive?.booleanOrNull == true

        db.withTransaction {
            if (partial) {
                val changed = env["changed"] as? JsonObject
                val removed = (env["removed"] as? kotlinx.serialization.json.JsonArray)
                    ?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() }
                    ?: emptyList()
                // Live-delta gap check: patches are per-seq; a gap means we
                // missed a broadcast → trust nothing, full refetch next
                // reconcile (skip applying, DON'T advance the cursor).
                if (!isSnapshot && lastSeen > 0 && seq > lastSeen + 1) return@withTransaction
                if (changed != null) {
                    val rows = changed.entries.mapNotNull { (id, state) ->
                        (state as? JsonObject)?.let { ChatEvents.roomFromState(id, it) }
                    }
                    if (rows.isNotEmpty()) db.chatRooms().upsertAll(rows)
                }
                if (removed.isNotEmpty()) db.chatRooms().deleteByIds(removed)
            } else {
                val data = env["data"] as? JsonObject ?: return@withTransaction
                val rows = data.entries.mapNotNull { (id, state) ->
                    (state as? JsonObject)?.let { ChatEvents.roomFromState(id, it) }
                }
                if (isSnapshot) {
                    val serverIds = rows.map { it.id }.toSet()
                    val stale = db.chatRooms().allIds().filter { it !in serverIds }
                    if (stale.isNotEmpty()) db.chatRooms().deleteByIds(stale)
                }
                if (rows.isNotEmpty()) db.chatRooms().upsertAll(rows)
            }
            db.meta().put(MetaRow(ROOMS_SEQ_KEY, seq.toString()))
        }
    }

    /** Ingest a hub MatrixDelta {nextBatch, rooms{id→{timeline,...}}}. */
    internal suspend fun ingestMatrixDelta(delta: JsonObject) {
        val nextBatch = delta["nextBatch"]?.jsonPrimitive?.content
        val rooms = delta["rooms"] as? JsonObject
        db.withTransaction {
            if (rooms != null) {
                for ((roomId, roomDeltaEl) in rooms.entries) {
                    val roomDelta = roomDeltaEl as? JsonObject ?: continue
                    ingestRoomTimeline(roomId, roomDelta)
                }
            }
            // Cursor advances IN the same transaction as the events.
            if (!nextBatch.isNullOrEmpty()) {
                db.meta().put(MetaRow(CURSOR_KEY, nextBatch))
            }
        }
    }

    private suspend fun ingestRoomTimeline(roomId: String, roomDelta: JsonObject) {
        val events = ChatEvents.timelineEvents(roomDelta)
        if (events.isEmpty()) return
        val toUpsert = mutableListOf<ChatMessageRow>()
        // In-batch working view: later events (reaction #2, edit-after-msg)
        // must see earlier ones from THIS delta, not the stale DB row.
        suspend fun lookup(id: String): ChatMessageRow? =
            toUpsert.lastOrNull { it.id == id } ?: db.chatMessages().byId(id)
        fun upsert(row: ChatMessageRow) {
            toUpsert.removeAll { it.id == row.id }
            toUpsert.add(row)
        }
        for (event in events) {
            // Redactions / tombstones → flip isDeleted on the original row.
            if (ChatEvents.isRedaction(event)) {
                val target = ChatEvents.redactsEventId(event)
                if (target != null) {
                    lookup(target)?.let { upsert(it.copy(isDeleted = true)) }
                }
                continue
            }
            if (ChatEvents.isEncryptedTombstone(event)) {
                val id = event["event_id"]?.jsonPrimitive?.content
                if (id != null) lookup(id)?.let { upsert(it.copy(isDeleted = true)) }
                continue
            }
            // Reactions aggregate onto the target row (emoji → [senders]).
            if (ChatEvents.isReaction(event)) {
                val parts = ChatEvents.reactionParts(event) ?: continue
                val (target, key, sender) = parts
                val row = lookup(target) ?: continue
                val reactions = parseReactions(row.reactionsJson).toMutableMap()
                val senders = (reactions[key] ?: emptyList()).toMutableList()
                if (sender !in senders) senders.add(sender)
                reactions[key] = senders
                upsert(row.copy(reactionsJson = encodeReactions(reactions)))
                continue
            }
            // Edits UPDATE the original row in place (SPA parity) — inserting
            // under the edit-event id duplicated the message (audit item 6).
            if (ChatEvents.isEdit(event)) {
                val targetId = ChatEvents.relatesToEventId(event)
                val edited = ChatEvents.eventToMessage(event, roomId) ?: continue
                if (targetId != null) {
                    val original = lookup(targetId)
                    if (original != null) {
                        upsert(original.copy(body = edited.body, isEdited = true))
                        continue
                    }
                }
                // Original not cached — skip rather than duplicate.
                continue
            }
            // Our own sends echo back with our txnId — swap the local echo.
            val txn = ChatEvents.transactionId(event)
            val msg = ChatEvents.eventToMessage(event, roomId) ?: continue
            if (txn != null) {
                val echo = db.chatMessages().recent(roomId, 50)
                    .firstOrNull { it.localEcho && it.txnId == txn }
                if (echo != null) db.chatMessages().delete(echo.id)
            }
            // Enrich replyTo with the quoted body/sender from the local cache.
            upsert(enrichReply(msg))
        }
        if (toUpsert.isNotEmpty()) db.chatMessages().upsertAll(toUpsert)
    }

    private suspend fun enrichReply(msg: ChatMessageRow): ChatMessageRow {
        val replyJson = msg.replyToJson ?: return msg
        if (replyJson.contains("\"body\"")) return msg // already enriched
        val eventId = runCatching {
            json.parseToJsonElement(replyJson).jsonObject["eventId"]?.jsonPrimitive?.content
        }.getOrNull() ?: return msg
        val target = db.chatMessages().byId(eventId) ?: return msg
        val enriched = buildJsonObject {
            put("eventId", eventId)
            put("sender", target.senderName ?: target.senderId)
            put("body", (target.body ?: "").take(120))
        }
        return msg.copy(replyToJson = enriched.toString())
    }

    internal fun parseReactions(jsonStr: String?): Map<String, List<String>> {
        jsonStr ?: return emptyMap()
        return runCatching {
            json.parseToJsonElement(jsonStr).jsonObject.entries.associate { (k, v) ->
                k to ((v as? kotlinx.serialization.json.JsonArray)?.mapNotNull {
                    runCatching { it.jsonPrimitive.content }.getOrNull()
                } ?: emptyList())
            }
        }.getOrElse { emptyMap() }
    }

    private fun encodeReactions(map: Map<String, List<String>>): String =
        buildJsonObject {
            for ((k, senders) in map) {
                put(k, kotlinx.serialization.json.JsonArray(senders.map { kotlinx.serialization.json.JsonPrimitive(it) }))
            }
        }.toString()

    /** Cold-room fill on open: paginate until ~20 messages cached (SPA
     *  ensureMessages parity). No-op offline or when already warm. */
    suspend fun ensureMessages(roomId: String, target: Int = 20) {
        if (!syncBus.connected) return
        var guard = 0
        while (db.chatMessages().countForRoom(roomId) < target && guard < 5) {
            val fetched = loadOlder(roomId, limit = 30)
            if (fetched == 0) break
            guard++
        }
    }

    /** Scroll-up pagination via matrix.paginate; events go into the cache. */
    suspend fun loadOlder(roomId: String, limit: Int = 30): Int {
        if (!syncBus.connected) return 0
        val room = db.chatRooms().byId(roomId) ?: return 0
        val from = room.prevBatch ?: return 0
        val result = runCatching {
            syncBus.rpc("matrix", "paginate", buildJsonObject {
                put("roomId", roomId)
                put("from", from)
                put("dir", "b")
                put("limit", limit)
            })
        }.getOrNull() ?: return 0
        val obj = result.jsonObject
        // paginate returns {chunk, state?, start?, end?} (decrypted events);
        // with dir='b', `end` is the token for the NEXT older page.
        val messages = (obj["chunk"] as? kotlinx.serialization.json.JsonArray)
            ?.mapNotNull { (it as? JsonObject)?.let { e -> ChatEvents.eventToMessage(e, roomId) } }
            ?: emptyList()
        val newPrev = obj["end"]?.jsonPrimitive?.content
        db.withTransaction {
            if (messages.isNotEmpty()) db.chatMessages().upsertAll(messages)
            if (newPrev != null) {
                db.chatRooms().byId(roomId)?.let {
                    db.chatRooms().upsertAll(listOf(it.copy(prevBatch = newPrev)))
                }
            }
        }
        return messages.size
    }

    /** Daily prune: bound every room's cached timeline. */
    suspend fun prune() {
        for (roomId in db.chatMessages().roomsWithMessages()) {
            db.chatMessages().pruneRoom(roomId, ROOM_CACHE_LIMIT)
        }
    }
}
