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
        const val TYPE_PIN = "chatPin"
        const val TYPE_MUTE = "chatMute"
        const val TYPE_EDIT = "chatEdit"
        const val TYPE_LOWPRIO = "chatLowPriority"
        /** Timeline cache bound per room (paginate loads more transiently). */
        const val ROOM_CACHE_LIMIT = 100
    }

    /** True only during the hub's first-boot initial sync with an empty local
     *  cache (SPA "Matrix: hub initial sync" banner). A cursor-less reconcile
     *  against a populated cache stays false so users don't fear a rebuild. */
    private val _initialSyncing = kotlinx.coroutines.flow.MutableStateFlow(false)
    val initialSyncing: kotlinx.coroutines.flow.StateFlow<Boolean> = _initialSyncing

    // ---------------------------------------------------------------- //
    // Reads (UI)

    fun observeRooms(): Flow<List<ChatRoomRow>> = db.chatRooms().observeAll()
    fun observeRoom(id: String): Flow<ChatRoomRow?> = db.chatRooms().observeRoom(id)
    fun observeMessages(roomId: String, limit: Int): Flow<List<ChatMessageRow>> =
        db.chatMessages().observeRecent(roomId, limit)

    // ---------------------------------------------------------------- //
    // Mutations (optimistic + outbox)

    /** Send text: local echo row now, durable queue, flush when online.
     *  [replyToEventId] adds the m.in_reply_to relation; [formattedBody] +
     *  [mentionUserIds] carry MSC3952 intentional mentions (Element/bridges
     *  only ping when the MXID is in m.mentions.user_ids — plain @Name text
     *  isn't enough). */
    suspend fun sendText(
        roomId: String,
        body: String,
        replyToEventId: String? = null,
        formattedBody: String? = null,
        mentionUserIds: List<String> = emptyList(),
    ) {
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
                    senderId = "me", senderName = "me", body = body,
                    formattedBody = formattedBody, msgtype = "m.text",
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
            formattedBody?.let { put("formattedBody", it) }
            if (mentionUserIds.isNotEmpty()) {
                put("mentionUserIds", kotlinx.serialization.json.JsonArray(
                    mentionUserIds.map { kotlinx.serialization.json.JsonPrimitive(it) }))
            }
        }
        outbox.enqueue(TYPE_SEND, payload.toString(), entityId = roomId, dedupeToken = txnId)
        // Sending marks the room read + advances its preview optimistically.
        bumpRoomPreview(roomId, body, "me")
    }

    /**
     * Edit an already-sent message (m.replace). SPA store editMessage parity:
     * no-op on unchanged text, optimistic in-place flip (originalBody kept for
     * the diff), preview refresh when it was the last message, m.mentions
     * rebuilt on both outer content and m.new_content. Failure surfaces the
     * red send-failed marker on the original bubble.
     */
    suspend fun editMessage(
        roomId: String,
        eventId: String,
        newBody: String,
        formattedBody: String? = null,
        mentionUserIds: List<String> = emptyList(),
    ) {
        val trimmed = newBody.trim()
        if (trimmed.isEmpty()) return
        val existing = db.chatMessages().byId(eventId)
        // No-op if nothing actually changed (avoids a spurious "(edited)").
        if (existing != null && existing.body == trimmed && existing.formattedBody == formattedBody) return
        if (existing != null) {
            db.chatMessages().upsertAll(listOf(existing.copy(
                body = trimmed,
                formattedBody = formattedBody,
                isEdited = true,
                originalBody = existing.originalBody ?: existing.body,
            )))
            val room = db.chatRooms().byId(roomId)
            if (room != null && (room.lastReadEventId == eventId || room.lastMessageTime == existing.timestamp)) {
                db.chatRooms().upsertAll(listOf(room.copy(lastMessageBody = trimmed)))
            }
        }
        val payload = buildJsonObject {
            put("roomId", roomId)
            put("eventId", eventId)
            put("body", trimmed)
            formattedBody?.let { put("formattedBody", it) }
            if (mentionUserIds.isNotEmpty()) {
                put("mentionUserIds", kotlinx.serialization.json.JsonArray(
                    mentionUserIds.map { kotlinx.serialization.json.JsonPrimitive(it) }))
            }
        }
        outbox.enqueue(TYPE_EDIT, payload.toString(), entityId = roomId)
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
        // Newest REAL (non-echo) message is the receipt target.
        val latestReal = db.chatMessages().recent(roomId, 20).firstOrNull { !it.localEcho }
        val room = db.chatRooms().byId(roomId) ?: return
        // Optimistic local flip; the hub snapshot confirms via delta.
        // lastReadTs pins the "— New —" divider for the next unread open.
        db.chatRooms().upsertAll(
            listOf(
                room.copy(
                    isUnread = false, unreadCount = 0, manualUnread = false,
                    lastReadTs = latestReal?.timestamp ?: room.lastMessageTime,
                )
            )
        )
        var eventId = latestReal?.id ?: room.lastReadEventId
        // No cached real message + no known read marker: ask the hub for the
        // newest event of ANY type (SPA fallback) so the receipt isn't
        // silently skipped, which would let the room resurrect as unread.
        if (eventId == null && syncBus.connected) {
            eventId = runCatching {
                val resp = syncBus.rpc("matrix", "paginate", buildJsonObject {
                    put("roomId", roomId); put("dir", "b"); put("limit", 1)
                }).jsonObject
                (resp["chunk"] as? kotlinx.serialization.json.JsonArray)
                    ?.firstOrNull()?.jsonObject?.get("event_id")?.jsonPrimitive?.content
            }.getOrNull()
        }
        if (eventId == null) return
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

    /** Pin/unpin: m.favourite room tag via hub REST (chat-rooms has no pin
     *  RPC). Optimistic local flip; sync's account_data confirms. */
    suspend fun setPinned(roomId: String, pinned: Boolean) {
        val room = db.chatRooms().byId(roomId) ?: return
        db.chatRooms().upsertAll(listOf(room.copy(isPinned = pinned)))
        val payload = buildJsonObject { put("roomId", roomId); put("pinned", pinned) }
        outbox.enqueue(TYPE_PIN, payload.toString(), entityId = roomId)
    }

    /** Mute/unmute: room-kind push rule via hub REST. Optimistic flip. */
    suspend fun setMuted(roomId: String, muted: Boolean) {
        val room = db.chatRooms().byId(roomId) ?: return
        db.chatRooms().upsertAll(listOf(room.copy(isMuted = muted)))
        val payload = buildJsonObject { put("roomId", roomId); put("muted", muted) }
        outbox.enqueue(TYPE_MUTE, payload.toString(), entityId = roomId)
    }

    /** Demote to low-priority / restore to inbox: m.lowpriority tag via hub
     *  REST (SPA setRoomTag/removeRoomTag). Optimistic flip. */
    suspend fun setLowPriority(roomId: String, low: Boolean) {
        val room = db.chatRooms().byId(roomId) ?: return
        db.chatRooms().upsertAll(listOf(room.copy(isLowPriority = low)))
        val payload = buildJsonObject { put("roomId", roomId); put("low", low) }
        outbox.enqueue(TYPE_LOWPRIO, payload.toString(), entityId = roomId)
    }

    /** Advance a room's preview + mark read after our own send (SPA store
     *  updates lastMessageBody/sender/time on sendMessage). */
    private suspend fun bumpRoomPreview(roomId: String, body: String, sender: String) {
        val room = db.chatRooms().byId(roomId) ?: return
        db.chatRooms().upsertAll(listOf(room.copy(
            lastMessageBody = body,
            lastMessageSender = sender,
            lastMessageTime = maxOf(room.lastMessageTime, System.currentTimeMillis()),
        )))
    }

    // ---------------------------------------------------------------- //
    // Room members (mention autocomplete) — in-memory per-room cache

    data class RoomMember(val userId: String, val displayName: String)

    private data class MemberCacheEntry(val members: List<RoomMember>, val fetchedAt: Long)
    private val membersCache = mutableMapOf<String, MemberCacheEntry>()
    private val MEMBER_TTL_MS = 60_000L
    private var cachedMyUserId: String? = null

    /** Own MXID — memory → meta table (offline-durable) → network. Persisted
     *  on first successful fetch so "mine" bubbles render correctly offline
     *  and on first composition (no live-fetch dependency). */
    suspend fun myUserId(): String? {
        cachedMyUserId?.let { return it }
        db.meta().get("matrix:myUserId")?.let {
            cachedMyUserId = it
            return it
        }
        return runCatching {
            json.parseToJsonElement(hub.get("/matrix/hub/status"))
                .jsonObject["userId"]?.jsonPrimitive?.content
        }.getOrNull()?.also {
            cachedMyUserId = it
            db.meta().put(MetaRow("matrix:myUserId", it))
        }
    }

    /**
     * GET /matrix/rooms/:id/info members, cached in memory per room with a
     * 60s TTL (SPA room-members.ts). Returns the cached list synchronously
     * when warm and fresh; otherwise refetches. [primeRoomMembers] warms it
     * on compose mount so the first '@' keystroke isn't blank.
     */
    suspend fun roomMembers(roomId: String, now: Long = System.currentTimeMillis()): List<RoomMember> {
        val cached = membersCache[roomId]
        if (cached != null && now - cached.fetchedAt < MEMBER_TTL_MS) return cached.members
        val members = runCatching {
            val resp = hub.get("/matrix/rooms/${java.net.URLEncoder.encode(roomId, "UTF-8")}/info")
            (json.parseToJsonElement(resp).jsonObject["members"] as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { el ->
                    val m = el as? JsonObject ?: return@mapNotNull null
                    val userId = m["userId"]?.jsonPrimitive?.content ?: return@mapNotNull null
                    val name = m["displayName"]?.jsonPrimitive?.content ?: userId
                    RoomMember(userId, name)
                } ?: emptyList()
        }.getOrElse { emptyList() }
        // Keep the stale list if a refetch failed (offline) — never blank it.
        if (members.isNotEmpty()) {
            membersCache[roomId] = MemberCacheEntry(members, now)
            repairSenderNames(roomId, members)
        }
        return members.ifEmpty { cached?.members ?: emptyList() }
    }

    /** Warm the member cache (compose mount) so autocomplete has data. */
    suspend fun primeRoomMembers(roomId: String) { runCatching { roomMembers(roomId) } }

    /** Backfill display names onto cached rows still showing the MXID
     *  localpart (e.g. "whatsapp_lid-1669…") — pre-fix ingests and rooms whose
     *  member state arrived after the messages. Runs on member-list refresh. */
    private suspend fun repairSenderNames(roomId: String, members: List<RoomMember>) {
        val byId = members.associateBy({ it.userId }, { it.displayName })
        val rows = db.chatMessages().recent(roomId, 400)
        val fixed = rows.mapNotNull { row ->
            val better = byId[row.senderId] ?: return@mapNotNull null
            val localpart = row.senderId.removePrefix("@").substringBefore(':')
            if (better.isNotBlank() && better != localpart &&
                (row.senderName.isNullOrBlank() || row.senderName == localpart)
            ) row.copy(senderName = better) else null
        }
        if (fixed.isNotEmpty()) db.chatMessages().upsertAll(fixed)
    }

    private val externalProfileCache = mutableMapOf<String, Pair<String, String>?>()

    /**
     * External profile (network, url) for a bridged room, from
     * GET /matrix/rooms/:id/info externalProfile (SPA room header link).
     * Cached per room; fetch failure → null (icon omitted).
     */
    suspend fun externalProfile(roomId: String): Pair<String, String>? {
        if (externalProfileCache.containsKey(roomId)) return externalProfileCache[roomId]
        val result = runCatching {
            val resp = hub.get("/matrix/rooms/${java.net.URLEncoder.encode(roomId, "UTF-8")}/info")
            val ep = json.parseToJsonElement(resp).jsonObject["externalProfile"] as? JsonObject ?: return@runCatching null
            val network = ep["network"]?.jsonPrimitive?.content ?: return@runCatching null
            val url = ep["url"]?.jsonPrimitive?.content ?: return@runCatching null
            network to url
        }.getOrNull()
        externalProfileCache[roomId] = result
        return result
    }

    /** Local plaintext file for a media message (decrypts E2EE attachments). */
    suspend fun mediaFile(context: android.content.Context, msg: ChatMessageRow): java.io.File =
        E2eeMedia.mediaFile(context, hub, msg)

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

        // msgtype from MIME (SPA sendFile): image/video/audio → typed bubble.
        // Non-whitelisted audio (WAV/AIFF/FLAC — bounced by the WhatsApp
        // bridge as unsupported voice notes) demotes to m.file.
        val msgtype = when {
            mime.startsWith("image/") -> "m.image"
            mime.startsWith("video/") -> "m.video"
            isWhitelistedAudio(mime) -> "m.audio"
            else -> "m.file"
        }
        // Image dimensions → content.info (aspect-ratio thumbnails).
        var w: Int? = null
        var h: Int? = null
        if (msgtype == "m.image") {
            runCatching {
                val opts = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                android.graphics.BitmapFactory.decodeFile(spoolFile.absolutePath, opts)
                if (opts.outWidth > 0) w = opts.outWidth
                if (opts.outHeight > 0) h = opts.outHeight
            }
        }

        val txnId = outbox.mintToken()
        val echoId = "~${System.currentTimeMillis()}.${(0..999999).random()}"
        db.chatMessages().upsertAll(
            listOf(
                ChatMessageRow(
                    id = echoId, roomId = roomId, timestamp = System.currentTimeMillis(),
                    senderId = "me", senderName = "me",
                    body = caption ?: filename,
                    msgtype = msgtype,
                    mediaMxc = null, mediaMime = mime,
                    mediaWidth = w, mediaHeight = h,
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
        // Room preview gets the WhatsApp-style media glyph + caption.
        val glyph = when (msgtype) {
            "m.image" -> "📷"; "m.video" -> "🎬"; "m.audio" -> "🎵"; else -> "📎"
        }
        bumpRoomPreview(roomId, "$glyph ${caption ?: filename}", "me")
    }

    /** Audio MIME the WhatsApp bridge accepts as a voice note (SPA sendFile). */
    private fun isWhitelistedAudio(mime: String): Boolean = mime in setOf(
        "audio/ogg", "audio/mp4", "audio/mpeg", "audio/aac", "audio/m4a", "audio/webm",
    )

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
        db.chatMessages().setSendFailedReason(echoId, false, null)
        val payload = buildJsonObject {
            put("roomId", echo.roomId)
            put("echoId", echoId)
            put("body", echo.body ?: "")
        }
        outbox.enqueue(TYPE_SEND, payload.toString(), entityId = echo.roomId, dedupeToken = txnId)
    }

    // ---------------------------------------------------------------- //
    // Link previews (SPA getUrlPreview)

    data class UrlPreview(
        val title: String?, val description: String?, val imageUrl: String?, val siteName: String?,
    )

    /** Session-scoped once the homeserver 404s preview_url (SPA localStorage
     *  matrix_preview_url_disabled) — avoids hammering an unsupported server. */
    @Volatile private var previewsDisabled = false
    private val previewCache = mutableMapOf<String, UrlPreview?>()

    /**
     * First-URL link preview via hub GET /matrix/url-preview (SPA
     * getUrlPreview). Returns null when unsupported / no preview. og:image mxc
     * is rewritten through the media proxy. Result cached per URL.
     */
    suspend fun urlPreview(url: String): UrlPreview? {
        if (previewsDisabled) return null
        previewCache[url]?.let { return it }
        if (previewCache.containsKey(url)) return null
        val result = runCatching {
            val resp = hub.get("/matrix/url-preview?url=${java.net.URLEncoder.encode(url, "UTF-8")}")
            val o = json.parseToJsonElement(resp).jsonObject
            val title = o["og:title"]?.jsonPrimitive?.content
            val desc = o["og:description"]?.jsonPrimitive?.content
            val img = o["og:image"]?.jsonPrimitive?.content
            val site = o["og:site_name"]?.jsonPrimitive?.content
            if (title == null && desc == null && img == null) null
            else UrlPreview(title, desc, img?.let { MatrixMedia.thumbnailUrl(it, 400, 400) ?: it }, site)
        }.getOrElse { e ->
            if (e is HubClient.HttpException && e.code == 404) previewsDisabled = true
            null
        }
        previewCache[url] = result
        return result
    }

    /** First bare http(s) URL in a text body (link-preview source). */
    fun firstUrl(body: String?): String? =
        body?.let { Regex("https?://[^\\s]+").find(it)?.value?.trimEnd('.', ',', ')', ']', '!', '?') }

    // ---------------------------------------------------------------- //
    // Deleted-message archive recovery (SPA DeletedMessageBody)

    data class ArchivedEvent(val body: String?, val mediaUrl: String?, val mimeType: String?)

    /**
     * Pre-redaction copy of a deleted event from the hub's append-only
     * archive (chat-rooms.archivedEvent RPC). Local-echo ids are skipped.
     * Recovered media is served via /matrix/archive/media/<sha1> with the
     * archived mime as a query hint (the blob on disk has no extension).
     */
    suspend fun archivedEvent(roomId: String, eventId: String): ArchivedEvent? {
        if (eventId.startsWith("~") || !syncBus.connected) return null
        return runCatching {
            val rec = syncBus.rpc("chat-rooms", "archivedEvent", buildJsonObject {
                put("roomId", roomId); put("eventId", eventId)
            }, timeoutMs = 8_000)
            val o = rec as? JsonObject ?: return null
            val body = o["content"]?.jsonObject?.get("body")?.jsonPrimitive?.content
            val mediaFile = o["mediaFile"]?.jsonPrimitive?.content
            val mime = o["mediaMimeType"]?.jsonPrimitive?.content
            val mediaUrl = mediaFile?.let {
                "${io.amar.console.core.HubConfig.hubBase}/matrix/archive/media/$it" +
                    "?mime=${java.net.URLEncoder.encode(mime ?: "", "UTF-8")}"
            }
            if (body == null && mediaUrl == null) null else ArchivedEvent(body, mediaUrl, mime)
        }.getOrNull()
    }

    // ---------------------------------------------------------------- //
    // Undo mark-read + background preload + reload room

    /** Undo a mark-read: restore the prior unread state (SPA undoMarkRead). */
    suspend fun undoMarkRead(snapshot: ChatRoomRow) {
        db.chatRooms().upsertAll(listOf(snapshot))
        outbox.enqueue(TYPE_MARK_UNREAD, buildJsonObject { put("roomId", snapshot.id) }.toString(), entityId = snapshot.id)
    }

    /**
     * Preload an initial page for every unread, non-snoozed room with nothing
     * cached (SPA preloadAllRooms). Failures are silent — messages load on
     * open. No-op offline.
     */
    suspend fun preloadAllRooms(now: Long = System.currentTimeMillis()) {
        if (!syncBus.connected) return
        val rooms = db.chatRooms().allRooms()
        for (room in rooms) {
            if (!room.isUnread || room.isMuted) continue
            if (room.snoozedUntil != null && room.snoozedUntil >= now) continue
            if (db.chatMessages().countForRoom(room.id) > 0) continue
            runCatching { loadOlder(room.id, limit = 20) }
        }
    }

    /**
     * Reload a room: wipe cached messages EXCEPT deleted ones still carrying a
     * body (re-pagination returns empty tombstones, losing the recovered text
     * forever — SPA reloadRoom), then re-fill via pagination. The hub-owned
     * prevBatch stays valid, so ensureMessages repaginates cleanly.
     */
    suspend fun reloadRoom(roomId: String) {
        db.chatMessages().deleteRoomExceptRecoverableDeleted(roomId)
        ensureMessages(roomId)
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
                val formattedBody = p["formattedBody"]?.jsonPrimitive?.content
                val mentionIds = (p["mentionUserIds"] as? kotlinx.serialization.json.JsonArray)
                    ?.mapNotNull { it.jsonPrimitive.content }
                val result = syncBus.rpc("matrix", "sendEvent", buildJsonObject {
                    put("roomId", roomId)
                    put("type", "m.room.message")
                    putJsonObject("content") {
                        put("msgtype", "m.text")
                        put("body", body)
                        if (formattedBody != null) {
                            put("format", "org.matrix.custom.html")
                            put("formatted_body", formattedBody)
                        }
                        if (replyTo != null) {
                            putJsonObject("m.relates_to") {
                                putJsonObject("m.in_reply_to") { put("event_id", replyTo) }
                            }
                        }
                        if (!mentionIds.isNullOrEmpty()) {
                            putJsonObject("m.mentions") {
                                put("user_ids", kotlinx.serialization.json.JsonArray(
                                    mentionIds.map { kotlinx.serialization.json.JsonPrimitive(it) }))
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
        outbox.register(TYPE_PIN) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val roomId = java.net.URLEncoder.encode(p["roomId"]!!.jsonPrimitive.content, "UTF-8")
            val pinned = p["pinned"]?.jsonPrimitive?.booleanOrNull == true
            try {
                if (pinned) hub.put("/matrix/rooms/$roomId/tags/m.favourite", "{}")
                else hub.delete("/matrix/rooms/$roomId/tags/m.favourite")
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }
        outbox.register(TYPE_MUTE) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val roomId = java.net.URLEncoder.encode(p["roomId"]!!.jsonPrimitive.content, "UTF-8")
            val muted = p["muted"]?.jsonPrimitive?.booleanOrNull == true
            try {
                if (muted) hub.put("/matrix/rooms/$roomId/mute", "{}")
                else hub.delete("/matrix/rooms/$roomId/mute")
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }
        // Low-priority tag via room tags REST (SPA setRoomTag m.lowpriority).
        outbox.register(TYPE_LOWPRIO) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val roomId = java.net.URLEncoder.encode(p["roomId"]!!.jsonPrimitive.content, "UTF-8")
            val low = p["low"]?.jsonPrimitive?.booleanOrNull == true
            try {
                if (low) hub.put("/matrix/rooms/$roomId/tags/m.lowpriority", "{}")
                else hub.delete("/matrix/rooms/$roomId/tags/m.lowpriority")
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }
        // Edit send (m.replace) — SPA store editMessage. ' * ' fallback body +
        // m.new_content, m.mentions rebuilt on both.
        outbox.register(TYPE_EDIT) { row, _ ->
            if (!syncBus.connected) return@register Outbox.Result.Retry("hub disconnected")
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val roomId = p["roomId"]!!.jsonPrimitive.content
            val eventId = p["eventId"]!!.jsonPrimitive.content
            val body = p["body"]!!.jsonPrimitive.content
            val formattedBody = p["formattedBody"]?.jsonPrimitive?.content
            val mentionIds = (p["mentionUserIds"] as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { it.jsonPrimitive.content }
            try {
                syncBus.rpc("matrix", "sendEvent", buildJsonObject {
                    put("roomId", roomId)
                    put("type", "m.room.message")
                    putJsonObject("content") {
                        put("msgtype", "m.text")
                        put("body", " * $body")
                        putJsonObject("m.new_content") {
                            put("msgtype", "m.text")
                            put("body", body)
                            if (formattedBody != null) {
                                put("format", "org.matrix.custom.html")
                                put("formatted_body", formattedBody)
                            }
                            if (!mentionIds.isNullOrEmpty()) {
                                putJsonObject("m.mentions") {
                                    put("user_ids", kotlinx.serialization.json.JsonArray(
                                        mentionIds.map { kotlinx.serialization.json.JsonPrimitive(it) }))
                                }
                            }
                        }
                        if (formattedBody != null) {
                            put("format", "org.matrix.custom.html")
                            put("formatted_body", " * $formattedBody")
                        }
                        putJsonObject("m.relates_to") {
                            put("rel_type", "m.replace")
                            put("event_id", eventId)
                        }
                        if (!mentionIds.isNullOrEmpty()) {
                            putJsonObject("m.mentions") {
                                put("user_ids", kotlinx.serialization.json.JsonArray(
                                    mentionIds.map { kotlinx.serialization.json.JsonPrimitive(it) }))
                            }
                        }
                    }
                })
                Outbox.Result.Done
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "edit failed")
            }
        }
        // Terminal edit failure → red marker on the edited bubble.
        outbox.register("$TYPE_EDIT:onFailed") { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            p["eventId"]?.jsonPrimitive?.content?.let {
                db.chatMessages().setSendFailedReason(it, true, "edit failed")
            }
            Outbox.Result.Done
        }
    }

    // ---------------------------------------------------------------- //
    // Sync: live deltas + reconcile

    private var repoScope: kotlinx.coroutines.CoroutineScope? = null

    fun wireLiveDeltas(scope: kotlinx.coroutines.CoroutineScope) {
        repoScope = scope
        // Handlers fire on the OkHttp WS reader thread — hop to a coroutine.
        syncBus.on("chat-rooms", "delta") { data ->
            scope.launch { runCatching { applyRoomsDelta(data.jsonObject) } }
        }
        syncBus.on("matrix", "delta") { data ->
            scope.launch { runCatching { ingestMatrixDelta(data.jsonObject) } }
        }
    }

    /** Manual sync (pull-to-refresh): nudge the hub /sync loop then reconcile
     *  (SPA hubBus.rpc('matrix','syncNow')). */
    suspend fun syncNow() {
        if (!syncBus.connected) return
        runCatching { syncBus.rpc("matrix", "syncNow", kotlinx.serialization.json.JsonNull, timeoutMs = 30_000) }
        reconcile()
    }

    /** Connect-time reconcile: rooms via seq patch, messages via resume cursor. */
    suspend fun reconcile() {
        if (!syncBus.connected) return
        // Own-MXID warm-up (meta-persisted; cheap no-op once cached).
        runCatching { myUserId() }
        // 1. Rooms: snapshotSince with our persisted seq.
        val seq = db.meta().get(ROOMS_SEQ_KEY)?.toLongOrNull()
        val args = buildJsonObject { seq?.let { put("since", it) } }
        runCatching {
            val result = syncBus.rpc("chat-rooms", "snapshotSince", args)
            applyRoomsDelta(result.jsonObject, isSnapshot = true)
        }
        // 2. Messages: matrix.resume with our persisted next_batch.
        val since = db.meta().get(CURSOR_KEY)
        // Initial-sync banner only on TRUE first boot (empty cache + hub says
        // isInitial). A populated cache stays silent (SPA parity).
        val cacheEmpty = db.chatRooms().allIds().isEmpty()
        runCatching {
            val resumeArgs = buildJsonObject { since?.let { put("since", it) } }
            val delta = syncBus.rpc("matrix", "resume", resumeArgs, timeoutMs = 120_000).jsonObject
            val isInitial = delta["isInitial"]?.jsonPrimitive?.booleanOrNull == true
            _initialSyncing.value = isInitial && cacheEmpty
            ingestMatrixDelta(delta)
        }
        _initialSyncing.value = false
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
        // Post-transaction: rotate-and-resend any wedged bridge failures.
        runCatching { processSendFailures() }
    }

    private suspend fun ingestRoomTimeline(roomId: String, roomDelta: JsonObject) {
        // State events FIRST (SPA allStateForRoom order): member display names
        // from state.events must be visible when the timeline's messages are
        // named. Without this, initial/limited syncs — where names arrive in
        // the state block, not the timeline — fell through to MXID localparts.
        processEvents(roomId, ChatEvents.stateEvents(roomDelta) + ChatEvents.timelineEvents(roomDelta))
    }

    /**
     * The single event-processing choke point for BOTH live deltas and
     * backward pagination (loadOlder). Handles redactions, encrypted
     * tombstones, reactions, edits (in-place update + originalBody preserve),
     * bridge send-status, and message rows — with the decryption-regression
     * guard (a re-delivered lock placeholder never overwrites a decrypted
     * row). SPA parity: this is store/chat.ts ingest + matrix/sync.ts merged.
     */
    private suspend fun processEvents(roomId: String, events: List<JsonObject>) {
        if (events.isEmpty()) return
        // Sender display names, SPA parity (matrix/sync.ts getSenderInfo +
        // cached-message fallback + DM room-name fallback). Without this,
        // bridge ghosts render as their MXID localpart ("whatsapp_lid-1669…").
        val senderNames = mutableMapOf<String, String>()
        for (event in events) {
            if (event["type"]?.jsonPrimitive?.content == "m.room.member") {
                val userId = event["state_key"]?.jsonPrimitive?.content ?: continue
                val name = (event["content"] as? JsonObject)?.get("displayname")?.jsonPrimitive?.content
                if (!name.isNullOrBlank()) senderNames[userId] = name
            }
        }
        suspend fun resolveSenderName(senderId: String, fallback: String): String {
            senderNames[senderId]?.let { return it }
            // Cached rows for this room whose name is better than the localpart.
            val localpart = senderId.removePrefix("@").substringBefore(':')
            db.chatMessages().latestBySender(roomId, senderId)?.let { prior ->
                val n = prior.senderName
                if (!n.isNullOrBlank() && n != localpart && n != senderId) { senderNames[senderId] = n; return n }
            }
            // Member cache (hub /rooms/:id/info — TTL'd, may be stale-but-right).
            membersCache[roomId]?.members?.firstOrNull { it.userId == senderId }?.let {
                if (it.displayName.isNotBlank() && it.displayName != localpart) {
                    senderNames[senderId] = it.displayName; return it.displayName
                }
            }
            // DM fallback: the room name IS the other party's name.
            val room = db.chatRooms().byId(roomId)
            if (room?.isDirect == true && room.name.isNotBlank() && senderId != myUserId()) {
                senderNames[senderId] = room.name; return room.name
            }
            // Nothing resolved → kick a background member fetch; the repair
            // pass in roomMembers() heals these rows once names arrive, so a
            // localpart is transient rather than permanent.
            repoScope?.launch { runCatching { roomMembers(roomId) } }
            return fallback
        }
        val toUpsert = mutableListOf<ChatMessageRow>()
        // In-batch working view: later events (reaction #2, edit-after-msg)
        // must see earlier ones from THIS batch, not the stale DB row.
        suspend fun lookup(id: String): ChatMessageRow? =
            toUpsert.lastOrNull { it.id == id } ?: db.chatMessages().byId(id)
        fun upsert(row: ChatMessageRow) {
            toUpsert.removeAll { it.id == row.id }
            toUpsert.add(row)
        }
        for (event in events) {
            // Bridge send-status (com.beeper.message_send_status) — flip/clear
            // the local echo's failure marker; wedged-Megolm auto-recovery is
            // scheduled separately (needs a network RPC, done post-transaction).
            if (ChatEvents.isSendStatus(event)) {
                val (target, status, reason) = ChatEvents.sendStatusParts(event) ?: continue
                if (status == "SUCCESS") {
                    lookup(target)?.let { upsert(it.copy(sendFailed = false, sendFailedReason = null)) }
                } else {
                    val msg = "bridge: $status" + (reason?.let { " ($it)" } ?: "")
                    lookup(target)?.let { upsert(it.copy(sendFailed = true, sendFailedReason = msg)) }
                    pendingSendFailures.add(SendFailure(roomId, target, status, reason))
                }
                continue
            }
            // Redactions → flip isDeleted + deletedBy on the original row.
            if (ChatEvents.isRedaction(event)) {
                val target = ChatEvents.redactsEventId(event)
                if (target != null) {
                    lookup(target)?.let {
                        if (!it.isDeleted) upsert(it.copy(isDeleted = true, deletedBy = event["sender"]?.jsonPrimitive?.content))
                    }
                }
                continue
            }
            if (ChatEvents.isEncryptedTombstone(event)) {
                val id = event["event_id"]?.jsonPrimitive?.content
                if (id != null) lookup(id)?.let {
                    if (!it.isDeleted) {
                        // A never-decrypted body has no meaningful strikethrough —
                        // blank it so the bubble reads "Message deleted".
                        val wasPlaceholder = it.body == "🔒 Encrypted message"
                        upsert(it.copy(
                            isDeleted = true,
                            deletedBy = event["sender"]?.jsonPrimitive?.content,
                            body = if (wasPlaceholder) "" else it.body,
                        ))
                    }
                }
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
            // under the edit-event id duplicated the message. originalBody is
            // preserved (first edit only) for the inline word-diff view.
            if (ChatEvents.isEdit(event)) {
                val targetId = ChatEvents.relatesToEventId(event) ?: continue
                val edit = ChatEvents.editContent(event) ?: continue
                val original = lookup(targetId) ?: continue // not cached → skip, don't duplicate
                // Type-changing edits (bridge replaces a failed sticker/media
                // message with an m.notice): adopt the new msgtype + media and
                // DON'T mark edited — a bridge status swap isn't a user edit,
                // and the word-diff of two unrelated notices is unreadable.
                val typeChanged = edit.msgtype != null && edit.msgtype != original.msgtype
                if (typeChanged) {
                    upsert(original.copy(
                        body = edit.body,
                        formattedBody = edit.formattedBody,
                        msgtype = edit.msgtype!!,
                        mediaMxc = edit.mediaMxc,
                        encryptedFileJson = edit.encryptedFileJson,
                        isEdited = false,
                        originalBody = null,
                    ))
                } else {
                    upsert(original.copy(
                        body = edit.body,
                        formattedBody = edit.formattedBody,
                        isEdited = true,
                        originalBody = original.originalBody ?: original.body,
                    ))
                }
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
            // Decryption-regression guard: a re-delivered m.room.encrypted
            // (lock placeholder) must NOT overwrite a row that already
            // decrypted. Cold resume replays encrypted events, and blindly
            // upserting rolled a good body back to "🔒 Encrypted message".
            if (msg.body == "🔒 Encrypted message") {
                val existing = lookup(msg.id)
                if (existing != null && existing.body != "🔒 Encrypted message" && !existing.isDeleted) continue
            }
            // Enrich sender name (bridge ghost MXIDs → display names) + replyTo.
            val named = msg.copy(senderName = resolveSenderName(msg.senderId, msg.senderName ?: msg.senderId))
            upsert(enrichReply(named))
        }
        if (toUpsert.isNotEmpty()) db.chatMessages().upsertAll(toUpsert)
    }

    // ---------------------------------------------------------------- //
    // Bridge send-failure auto-recovery (rotate key + resend once).

    private data class SendFailure(val roomId: String, val eventId: String, val status: String, val reason: String?)
    private val pendingSendFailures = java.util.concurrent.ConcurrentLinkedQueue<SendFailure>()

    /**
     * Drain send-failures observed this sync tick: for FAIL_RETRIABLE
     * undecryptable_event, rotate the room key + resend once
     * (matrix.resendAfterRotate) — automation of the manual runbook. On
     * success the wedged echo is deleted so only the delivered copy shows.
     * Runs OUTSIDE the ingest transaction (it makes network RPCs).
     */
    suspend fun processSendFailures() {
        while (true) {
            val f = pendingSendFailures.poll() ?: break
            val row = db.chatMessages().byId(f.eventId) ?: continue
            val isUndecryptable = f.status == "FAIL_RETRIABLE" &&
                (f.reason?.contains("undecryptable_event", ignoreCase = true) == true)
            if (isUndecryptable && !row.autoRotateRetried) {
                db.chatMessages().markAutoRotateRetried(f.eventId)
                val ok = runCatching {
                    val res = syncBus.rpc("matrix", "resendAfterRotate", buildJsonObject {
                        put("roomId", f.roomId); put("eventId", f.eventId)
                    }, timeoutMs = 30_000).jsonObject
                    res["ok"]?.jsonPrimitive?.booleanOrNull == true && res["eventId"] != null
                }.getOrDefault(false)
                if (ok) {
                    // Resend delivered under a fresh key — drop the dead echo.
                    db.chatMessages().delete(f.eventId)
                }
            }
        }
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
        // with dir='b', chunk is newest→oldest and `end` is the token for the
        // NEXT older page. Reverse to chronological order so the shared
        // processEvents sees each target before its reaction/edit/redaction —
        // the SPA does the same (deferred second pass). This fixes reactions,
        // redactions, and edits being dropped/duplicated on backfill.
        val chunk = (obj["chunk"] as? kotlinx.serialization.json.JsonArray)
            ?.mapNotNull { it as? JsonObject }
            ?.reversed()
            ?: emptyList()
        val newPrev = obj["end"]?.jsonPrimitive?.content
        // Count message-bearing rows for the caller's window growth.
        val messageCount = chunk.count { ChatEvents.eventToMessage(it, roomId) != null }
        db.withTransaction {
            processEvents(roomId, chunk)
            if (newPrev != null) {
                db.chatRooms().byId(roomId)?.let {
                    db.chatRooms().upsertAll(listOf(it.copy(prevBatch = newPrev)))
                }
            }
        }
        return messageCount
    }

    /** Daily prune: bound every room's cached timeline. */
    suspend fun prune() {
        for (roomId in db.chatMessages().roomsWithMessages()) {
            db.chatMessages().pruneRoom(roomId, ROOM_CACHE_LIMIT)
        }
    }
}
