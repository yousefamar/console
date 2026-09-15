package io.amar.console.data.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * Per-room draft reconciliation between ONE composer and the hub-owned
 * `RoomState.draft` — port of the ref dance in the SPA's ChatComposeInput
 * (`hubDraftRef` / `syncedDraftRef` / `lastLocalWriteRef`). Pure so the rules
 * that were each a bug on the desktop are unit-tested here:
 *
 *  - the FIRST hub read for a room fills the composer (hydrate);
 *  - a later remote change (another device, an agent's `con chat draft`)
 *    replaces the text only when nothing unsaved is typed — local typing wins
 *    and overwrites the hub on its next flush;
 *  - a remote value arriving within [ECHO_WINDOW_MS] of our own write is ignored
 *    (a sync delta computed before the write landed echoes the PREVIOUS draft;
 *    applying it blanked the textarea mid-typing);
 *  - edit mode never persists (the field holds the message being edited);
 *  - a flush pushes only when the text differs from the hub mirror, so a push
 *    the hub dropped is simply retried on the next flush.
 *
 * `hubDraft` = latest mirror value seen for this room (null until the first
 * read); `synced` = the last text this composer applied or pushed, i.e. what
 * the field held before any unsaved typing.
 */
class ChatDraftSync {
    var hubDraft: String? = null
        private set
    var synced: String? = null
        private set
    private var lastLocalWrite = 0L

    /** Room switch: forget everything; the new room starts blank until hydrated. */
    fun reset() {
        hubDraft = null
        synced = null
        lastLocalWrite = 0L
    }

    /**
     * A mirror value landed. Returns the text the composer should now show, or
     * null to leave it alone. [current] is the field's text right now.
     */
    fun onRemote(draft: String, current: String, editing: Boolean, now: Long = System.currentTimeMillis()): String? {
        hubDraft = draft
        if (editing) return null
        val s = synced
        if (s == null) {
            synced = draft
            return if (draft != current) draft else null
        }
        if (draft == s) return null
        if (now - lastLocalWrite < ECHO_WINDOW_MS) return null
        val apply = current == s
        synced = draft
        return if (apply) draft else null
    }

    /**
     * Push [text] to the hub as the room's draft if it differs from the mirror.
     * Returns the text to send (may be "" = clear), or null when nothing needs
     * pushing. Never pushes before the first read (the composer may still be
     * showing a stale local copy) or while editing.
     */
    fun flush(text: String, editing: Boolean, now: Long = System.currentTimeMillis()): String? {
        if (editing) return null
        val h = hubDraft ?: return null
        if (text == h) return null
        hubDraft = text
        synced = text
        lastLocalWrite = now
        return text
    }

    /** Leaving edit mode puts the room's draft back in the field. */
    fun afterEdit(): String {
        val d = hubDraft ?: ""
        synced = d
        return d
    }

    companion object {
        const val SAVE_DEBOUNCE_MS = 400L
        const val ECHO_WINDOW_MS = 1500L
    }
}

private val draftJson = Json { ignoreUnknownKeys = true }

/**
 * The room's `rawJson` with `draft`/`draftUpdatedAt` replaced — the optimistic
 * Room write behind a `setRoomDraft` (the hub's chat-rooms delta lands within a
 * tick and overwrites identically). An empty [text] clears both keys, matching
 * `ChatRoomsStore.setRoomDraft`.
 */
fun withRoomDraft(rawJson: String?, text: String, now: Long = System.currentTimeMillis()): String {
    val o = runCatching { draftJson.parseToJsonElement(rawJson ?: "{}").jsonObject }.getOrNull() ?: JsonObject(emptyMap())
    return buildJsonObject {
        o.forEach { (k, v) -> if (k != "draft" && k != "draftUpdatedAt") put(k, v) }
        if (text.isNotBlank()) {
            put("draft", JsonPrimitive(text))
            put("draftUpdatedAt", now)
        }
    }.toString()
}
