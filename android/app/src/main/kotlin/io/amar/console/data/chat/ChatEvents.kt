package io.amar.console.data.chat

import io.amar.console.data.db.ChatMessageRow
import io.amar.console.data.db.ChatRoomRow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Pure Matrix-event → Room-row conversion. Kotlin port of the SPA's
 * `eventToMessage` (src/matrix/sync.ts). The hub decrypts before
 * broadcasting, so events arrive as plain m.room.message/m.sticker/... —
 * a surviving m.room.encrypted is either an undecryptable placeholder
 * (render lock icon) or a redaction tombstone (content stripped → null).
 */
object ChatEvents {

    private fun JsonObject.str(key: String): String? =
        (this[key] as? JsonElement)?.let { runCatching { it.jsonPrimitive.content }.getOrNull() }

    private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

    fun eventToMessage(event: JsonObject, roomId: String): ChatMessageRow? {
        val eventId = event.str("event_id") ?: return null
        val sender = event.str("sender") ?: return null
        val type = event.str("type") ?: return null
        val ts = event["origin_server_ts"]?.jsonPrimitive?.longOrNull ?: System.currentTimeMillis()
        val content = event.obj("content") ?: return null

        if (type == "m.room.encrypted") {
            val hasCiphertext = content.str("ciphertext") != null
            // Tombstone (redacted E2EE event): content stripped → skip; the
            // redaction handling flips isDeleted on the original row.
            if (!hasCiphertext) return null
            return ChatMessageRow(
                id = eventId, roomId = roomId, timestamp = ts, senderId = sender,
                senderName = senderFallbackName(sender), body = "🔒 Encrypted message",
                msgtype = "m.text", mediaMxc = null, mediaMime = null,
                encryptedFileJson = null, replyToJson = null,
            )
        }

        val effectiveContent = when (type) {
            "m.sticker" -> content // stickers render like images
            "m.room.message" -> {
                // Edits (m.replace) carry the replacement in m.new_content.
                val relates = content.obj("m.relates_to")
                if (relates?.str("rel_type") == "m.replace") {
                    content.obj("m.new_content") ?: content
                } else content
            }
            else -> return null
        }

        val msgtype = when (type) {
            "m.sticker" -> "m.image"
            else -> effectiveContent.str("msgtype") ?: "m.text"
        }
        // WhatsApp bridge noise: transient decrypt-failure notices.
        if (msgtype == "m.notice" &&
            effectiveContent.str("body")?.contains("Decrypting message from WhatsApp failed") == true
        ) return null
        val body = effectiveContent.str("body") ?: ""
        // formatted_body: strip the mx-reply quote block bridges prepend.
        val formatted = effectiveContent.str("formatted_body")
            ?.replace(Regex("<mx-reply>.*?</mx-reply>", RegexOption.DOT_MATCHES_ALL), "")
            ?.takeIf { it.isNotBlank() && effectiveContent.str("format") == "org.matrix.custom.html" }

        // Media: unencrypted rooms carry `url` (mxc://); E2EE rooms carry
        // `file` (EncryptedFile json — url + AES key material).
        val file = effectiveContent.obj("file")
        val mediaMxc = effectiveContent.str("url") ?: file?.str("url")
        val info = effectiveContent.obj("info")
        val mediaMime = info?.str("mimetype")
        // Audio metadata: MSC1767 org.matrix.msc1767.audio.duration OR
        // info.duration; waveform + MSC3245 voice-note flag ride content.
        val msc1767 = effectiveContent.obj("org.matrix.msc1767.audio")
        val durationMs = if (msgtype == "m.audio") {
            msc1767?.get("duration")?.jsonPrimitive?.longOrNull
                ?: info?.get("duration")?.jsonPrimitive?.longOrNull
        } else info?.get("duration")?.jsonPrimitive?.longOrNull
        val waveform = if (msgtype == "m.audio") {
            (msc1767?.get("waveform") as? kotlinx.serialization.json.JsonArray)?.toString()
        } else null
        val isVoiceNote = msgtype == "m.audio" && effectiveContent.containsKey("org.matrix.msc3245.voice")
        val mediaWidth = info?.get("w")?.jsonPrimitive?.intOrNull
        val mediaHeight = info?.get("h")?.jsonPrimitive?.intOrNull

        val replyToId = content.obj("m.relates_to")?.obj("m.in_reply_to")?.str("event_id")

        return ChatMessageRow(
            id = eventId,
            roomId = roomId,
            timestamp = ts,
            senderId = sender,
            senderName = senderFallbackName(sender),
            body = body,
            formattedBody = formatted,
            msgtype = msgtype,
            mediaMxc = mediaMxc,
            mediaMime = mediaMime,
            mediaDurationMs = durationMs,
            waveformJson = waveform,
            isVoiceNote = isVoiceNote,
            mediaWidth = mediaWidth,
            mediaHeight = mediaHeight,
            encryptedFileJson = file?.toString(),
            replyToJson = replyToId?.let { """{"eventId":"$it"}""" },
        )
    }

    /**
     * Bridge "SenderName: message" prefix stripping (SPA
     * ChatMessageBubble displayBody): WhatsApp/Slack bridges prepend the
     * sender's display name to the body in group rooms. Strip only when the
     * prefix exactly matches the resolved sender name.
     */
    fun displayBody(body: String, senderName: String?): String {
        if (senderName.isNullOrBlank()) return body
        val prefix = "$senderName: "
        return if (body.startsWith(prefix)) body.substring(prefix.length) else body
    }

    /** m.relates_to rel_type of an event, if any ("m.replace" / "m.annotation"). */
    fun relType(event: JsonObject): String? =
        event.obj("content")?.obj("m.relates_to")?.str("rel_type")

    /** For edits/annotations: the event id being related to. */
    fun relatesToEventId(event: JsonObject): String? =
        event.obj("content")?.obj("m.relates_to")?.str("event_id")

    fun isReaction(event: JsonObject): Boolean = event.str("type") == "m.reaction"

    /** For m.reaction: (targetEventId, emojiKey, sender). */
    fun reactionParts(event: JsonObject): Triple<String, String, String>? {
        val rel = event.obj("content")?.obj("m.relates_to") ?: return null
        if (rel.str("rel_type") != "m.annotation") return null
        val target = rel.str("event_id") ?: return null
        val key = rel.str("key") ?: return null
        val sender = event.str("sender") ?: return null
        return Triple(target, key, sender)
    }

    /** True when this m.room.message is an edit (m.replace). */
    fun isEdit(event: JsonObject): Boolean =
        event.str("type") == "m.room.message" && relType(event) == "m.replace"

    /** Replacement body + formatted_body from an m.replace event's
     *  m.new_content (falls back to the outer content). */
    data class EditContent(val body: String, val formattedBody: String?)

    fun editContent(event: JsonObject): EditContent? {
        val content = event.obj("content") ?: return null
        val nc = content.obj("m.new_content") ?: content
        val body = nc.str("body") ?: return null
        val formatted = nc.str("formatted_body")
            ?.replace(Regex("<mx-reply>.*?</mx-reply>", RegexOption.DOT_MATCHES_ALL), "")
            ?.takeIf { it.isNotBlank() && nc.str("format") == "org.matrix.custom.html" }
        return EditContent(body, formatted)
    }

    fun isRedaction(event: JsonObject): Boolean = event.str("type") == "m.room.redaction"

    fun redactsEventId(event: JsonObject): String? =
        event.str("redacts") ?: event.obj("content")?.str("redacts")

    /** Encrypted tombstone: m.room.encrypted with content stripped by redaction. */
    fun isEncryptedTombstone(event: JsonObject): Boolean {
        if (event.str("type") != "m.room.encrypted") return false
        val content = event.obj("content") ?: return true
        return content.str("ciphertext") == null
    }

    /** The local-echo transaction id the homeserver echoes back to the sender. */
    fun transactionId(event: JsonObject): String? =
        event.obj("unsigned")?.str("transaction_id")

    /** Beeper bridge send-status event (references the original send). */
    fun isSendStatus(event: JsonObject): Boolean =
        event.str("type") == "com.beeper.message_send_status"

    /** (targetEventId, status, reason?) from a send-status event. */
    fun sendStatusParts(event: JsonObject): Triple<String, String, String?>? {
        val content = event.obj("content") ?: return null
        val target = content.obj("m.relates_to")?.str("event_id") ?: return null
        val status = content.str("status") ?: return null
        val reason = content.str("reason") ?: content.str("error")
        return Triple(target, status, reason)
    }

    private fun senderFallbackName(sender: String): String =
        sender.removePrefix("@").substringBefore(':')

    // ------------------------------------------------------------------ //
    // Hub chat-rooms snapshot rows (server RoomState) → ChatRoomRow.

    fun roomFromState(id: String, state: JsonObject): ChatRoomRow = ChatRoomRow(
        id = id,
        name = state.str("name") ?: id,
        avatarMxc = state.str("avatar"),
        isDirect = state["isDirect"]?.jsonPrimitive?.booleanOrNull ?: false,
        isUnread = state["isUnread"]?.jsonPrimitive?.booleanOrNull ?: false,
        unreadCount = state["unreadCount"]?.jsonPrimitive?.intOrNull ?: 0,
        manualUnread = state["manualUnread"]?.jsonPrimitive?.booleanOrNull ?: false,
        lastMessageBody = state.str("lastMessageBody"),
        lastMessageSender = state.str("lastMessageSender"),
        lastMessageTime = state["lastMessageTime"]?.jsonPrimitive?.longOrNull ?: 0L,
        lastReadEventId = state.str("lastReadEventId"),
        isMuted = state["isMuted"]?.jsonPrimitive?.booleanOrNull ?: false,
        isLowPriority = state["isLowPriority"]?.jsonPrimitive?.booleanOrNull ?: false,
        isEncrypted = state["isEncrypted"]?.jsonPrimitive?.booleanOrNull ?: false,
        memberCount = state["memberCount"]?.jsonPrimitive?.intOrNull ?: 0,
        networkIcon = state.str("networkIcon"),
        snoozedUntil = state["snoozedUntil"]?.jsonPrimitive?.longOrNull,
        prevBatch = state.str("prevBatch"),
        isPinned = (state["tags"] as? kotlinx.serialization.json.JsonArray)
            ?.any { runCatching { it.jsonPrimitive.content }.getOrNull() == "m.favourite" } ?: false,
        lastReadTs = state["lastReadTs"]?.jsonPrimitive?.longOrNull,
        rawJson = state.toString(),
    )

    /** A read receipt for one OTHER user (server RoomState.readReceipts). */
    data class ReadReceipt(
        val userId: String,
        val eventId: String,
        val ts: Long,
        val displayName: String?,
        val avatarMxc: String?,
    )

    /**
     * Parse `readReceipts` from a room's rawJson (the verbatim server
     * RoomState): map userId → {eventId, ts, displayName?, avatar?}.
     * The hub already filters out my own user + bridge bots.
     */
    fun parseReadReceipts(rawJson: String?): List<ReadReceipt> {
        rawJson ?: return emptyList()
        val state = runCatching {
            kotlinx.serialization.json.Json.parseToJsonElement(rawJson).jsonObject
        }.getOrNull() ?: return emptyList()
        val receipts = state.obj("readReceipts") ?: return emptyList()
        return receipts.entries.mapNotNull { (userId, el) ->
            val r = el as? JsonObject ?: return@mapNotNull null
            val eventId = r.str("eventId") ?: return@mapNotNull null
            ReadReceipt(
                userId = userId,
                eventId = eventId,
                ts = r["ts"]?.jsonPrimitive?.longOrNull ?: 0L,
                displayName = r.str("displayName"),
                avatarMxc = r.str("avatar"),
            )
        }
    }

    /**
     * For each receipt, resolve the NEWEST message row the reader has seen —
     * exact event-id match when cached, else newest message at-or-before the
     * receipt ts (receipts often point at events outside our window). Returns
     * messageId → receipts, receipts sorted by ts descending.
     */
    fun receiptsByMessage(
        receipts: List<ReadReceipt>,
        messages: List<ChatMessageRow>, // any order
    ): Map<String, List<ReadReceipt>> {
        if (receipts.isEmpty() || messages.isEmpty()) return emptyMap()
        val byTime = messages.filter { !it.localEcho }.sortedBy { it.timestamp }
        val byId = byTime.associateBy { it.id }
        val out = mutableMapOf<String, MutableList<ReadReceipt>>()
        for (r in receipts) {
            val target = byId[r.eventId]
                ?: byTime.lastOrNull { it.timestamp <= r.ts }
                ?: continue
            out.getOrPut(target.id) { mutableListOf() }.add(r)
        }
        for (list in out.values) list.sortByDescending { it.ts }
        return out
    }

    /**
     * Unread divider position: the id of the first message strictly newer
     * than [lastReadTs] that isn't mine — the "— New —" row renders above it
     * (SPA ChatRoomView showUnreadDivider parity). Null when nothing unread.
     * [myUserId] is the full MXID (real rows carry it; echoes carry "me").
     */
    fun unreadDividerMessageId(
        messages: List<ChatMessageRow>, // any order
        lastReadTs: Long?,
        myUserId: String? = null,
    ): String? {
        if (lastReadTs == null || lastReadTs <= 0) return null
        return messages
            .filter {
                !it.localEcho && it.senderId != "me" &&
                    (myUserId == null || it.senderId != myUserId) &&
                    it.timestamp > lastReadTs
            }
            .minByOrNull { it.timestamp }
            ?.id
    }

    /** Timeline events array from a hub MatrixDelta room entry. */
    fun timelineEvents(roomDelta: JsonObject): List<JsonObject> =
        (roomDelta["timeline"] as? JsonObject)
            ?.get("events")?.jsonArray
            ?.mapNotNull { it as? JsonObject }
            ?: emptyList()
}
