package io.amar.console.data.mail

import android.util.Base64
import io.amar.console.data.db.MailMessageRow
import io.amar.console.data.db.MailThreadRow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Pure Gmail-API JSON → Room-row conversion (port of the SPA's
 * src/gmail/parse paths). A "full thread" is Gmail's
 * {id, historyId, messages:[{id, threadId, labelIds, payload{headers, parts,
 * body}, internalDate, snippet}]}.
 */
object GmailParse {

    private fun JsonObject.str(key: String): String? =
        runCatching { this[key]?.jsonPrimitive?.content }.getOrNull()

    private fun headers(msg: JsonObject): Map<String, String> {
        val list = (msg["payload"] as? JsonObject)?.get("headers") as? JsonArray ?: return emptyMap()
        val out = mutableMapOf<String, String>()
        for (h in list) {
            val o = h as? JsonObject ?: continue
            val name = o.str("name")?.lowercase() ?: continue
            // First occurrence wins (Gmail can repeat Received etc.)
            if (name !in out) out[name] = o.str("value") ?: ""
        }
        return out
    }

    /** "Alice Smith <alice@x.com>" → ("Alice Smith", "alice@x.com") */
    fun parseAddress(header: String): Pair<String, String> {
        val m = Regex("^\\s*\"?([^\"<]*)\"?\\s*<([^>]+)>\\s*$").find(header)
        return if (m != null) {
            val name = m.groupValues[1].trim().ifEmpty { m.groupValues[2].trim() }
            name to m.groupValues[2].trim()
        } else {
            header.trim() to header.trim()
        }
    }

    private fun labelIds(msg: JsonObject): List<String> =
        (msg["labelIds"] as? JsonArray)?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() }
            ?: emptyList()

    /** Walk MIME parts for the preferred body; returns html to text pair. */
    fun extractBodies(payload: JsonObject?): Pair<String?, String?> {
        payload ?: return null to null
        var html: String? = null
        var text: String? = null

        fun decode(part: JsonObject): String? {
            val data = (part["body"] as? JsonObject)?.str("data") ?: return null
            return runCatching {
                String(Base64.decode(data, Base64.URL_SAFE), Charsets.UTF_8)
            }.getOrNull()
        }

        fun walk(part: JsonObject) {
            val mime = part.str("mimeType") ?: ""
            when {
                mime == "text/html" && html == null -> html = decode(part)
                mime == "text/plain" && text == null -> text = decode(part)
            }
            (part["parts"] as? JsonArray)?.forEach { child ->
                (child as? JsonObject)?.let { walk(it) }
            }
        }
        walk(payload)
        return html to text
    }

    /** Attachment metadata JSON array string, or null when none. */
    fun extractAttachments(msg: JsonObject): String? {
        val out = StringBuilder("[")
        var any = false
        fun walk(part: JsonObject) {
            val filename = part.str("filename")
            val attId = (part["body"] as? JsonObject)?.str("attachmentId")
            if (!filename.isNullOrEmpty() && attId != null) {
                if (any) out.append(',')
                any = true
                val size = (part["body"] as? JsonObject)?.get("size")?.jsonPrimitive?.intOrNull ?: 0
                out.append(
                    """{"messageId":"${msg.str("id")}","attachmentId":"$attId","filename":${jsonQuote(filename)},"mimeType":"${part.str("mimeType") ?: ""}","size":$size}"""
                )
            }
            ((part["parts"]) as? JsonArray)?.forEach { c -> (c as? JsonObject)?.let { walk(it) } }
        }
        (msg["payload"] as? JsonObject)?.let { walk(it) }
        out.append(']')
        return if (any) out.toString() else null
    }

    private fun jsonQuote(s: String): String =
        "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    fun messageRow(msg: JsonObject, threadId: String, keepBody: Boolean = true): MailMessageRow? {
        val id = msg.str("id") ?: return null
        val h = headers(msg)
        val (html, text) = if (keepBody) extractBodies(msg["payload"] as? JsonObject) else (null to null)
        return MailMessageRow(
            id = id,
            threadId = threadId,
            date = msg["internalDate"]?.jsonPrimitive?.content?.toLongOrNull()
                ?: msg["internalDate"]?.jsonPrimitive?.longOrNull ?: 0L,
            fromHeader = h["from"] ?: "",
            toHeader = h["to"] ?: "",
            ccHeader = h["cc"],
            subject = h["subject"] ?: "",
            bodyHtml = html,
            bodyText = text ?: msg.str("snippet"),
            isUnread = "UNREAD" in labelIds(msg),
            attachmentsJson = extractAttachments(msg),
        )
    }

    /** Full thread JSON → (thread row, message rows). Null when malformed. */
    fun threadRows(thread: JsonObject, account: String): Pair<MailThreadRow, List<MailMessageRow>>? {
        val id = thread.str("id") ?: return null
        val messages = (thread["messages"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
        if (messages.isEmpty()) return null
        val last = messages.last()
        val h = headers(last)
        val (fromName, fromEmail) = parseAddress(h["from"] ?: "")
        val allLabels = messages.flatMap { labelIds(it) }.toSet()
        val rows = messages.mapNotNull { messageRow(it, id) }
        val threadRow = MailThreadRow(
            id = id,
            subject = h["subject"] ?: "(no subject)",
            fromName = fromName,
            fromEmail = fromEmail,
            snippet = last.str("snippet") ?: "",
            date = rows.maxOfOrNull { it.date } ?: 0L,
            isUnread = "UNREAD" in allLabels,
            isInbox = "INBOX" in allLabels,
            hasAttachments = rows.any { it.attachmentsJson != null },
            messageCount = messages.size,
            snoozedUntil = null,
            account = account,
        )
        return threadRow to rows
    }
}
