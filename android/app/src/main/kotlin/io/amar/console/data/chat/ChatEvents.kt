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
        val body = effectiveContent.str("body") ?: ""

        // Media: unencrypted rooms carry `url` (mxc://); E2EE rooms carry
        // `file` (EncryptedFile json — url + AES key material).
        val file = effectiveContent.obj("file")
        val mediaMxc = effectiveContent.str("url") ?: file?.str("url")
        val mediaMime = effectiveContent.obj("info")?.str("mimetype")

        val replyToId = content.obj("m.relates_to")?.obj("m.in_reply_to")?.str("event_id")

        return ChatMessageRow(
            id = eventId,
            roomId = roomId,
            timestamp = ts,
            senderId = sender,
            senderName = senderFallbackName(sender),
            body = body,
            msgtype = msgtype,
            mediaMxc = mediaMxc,
            mediaMime = mediaMime,
            encryptedFileJson = file?.toString(),
            replyToJson = replyToId?.let { """{"eventId":"$it"}""" },
        )
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
        rawJson = state.toString(),
    )

    /** Timeline events array from a hub MatrixDelta room entry. */
    fun timelineEvents(roomDelta: JsonObject): List<JsonObject> =
        (roomDelta["timeline"] as? JsonObject)
            ?.get("events")?.jsonArray
            ?.mapNotNull { it as? JsonObject }
            ?: emptyList()
}
