package io.amar.console.data.mail

import androidx.room.withTransaction
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.MailMessageRow
import io.amar.console.data.db.MailThreadRow
import io.amar.console.data.db.MetaRow
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URLEncoder

/**
 * Mail domain: inbox mirror + queued triage + offline compose.
 *
 * Sync model (mirrors src/gmail/sync.ts):
 *  - initial hydrate: GET /mail/threads?full=1&limit=N (one request — the M3
 *    hub endpoint), persists threads+messages+historyId cursor transactionally.
 *  - catch-up: GET /mail/history?startHistoryId=<cursor> → changed thread ids
 *    → POST /mail/threads/batch hydration. Expired cursor (404/400) → full re-init.
 *  - live: mail.delta broadcasts (ids only) → same batch hydration.
 *  - mutations: label ops are idempotent REST via outbox; send/reply carry
 *    clientToken (dedupeToken) so a queued retry can't double-send. Reply
 *    conflict detection: thread's messageCount at flush vs at enqueue.
 */
class MailRepository(
    private val db: ConsoleDb,
    private val hub: HubClient,
    private val syncBus: SyncBusClient,
    private val outbox: Outbox,
) {
    private val json = Json { ignoreUnknownKeys = true }

    companion object {
        const val CURSOR_PREFIX = "mail:historyId:"
        const val ACCOUNT_KEY = "mail:primaryAccount"
        const val ALIASES_KEY = "mail:sendAsAliases"
        const val LABEL_MAP_KEY = "mail:labelMap"
        const val CAL_PREFIX = "mail:cal:"        // per-message calendar invite JSON
        const val LABELS_PREFIX = "mail:labels:"  // per-thread user-label id list (JSON array)
        const val DRAFT_PREFIX = "mail:draft:"    // per-context compose draft (JSON)
        const val INITIAL_LIMIT = 50
        const val BODY_KEEP = 50
        const val TYPE_ARCHIVE = "mailArchive"
        const val TYPE_UNARCHIVE = "mailUnarchive"
        const val TYPE_READ = "mailRead"
        const val TYPE_UNREAD = "mailUnread"
        const val TYPE_TRASH = "mailTrash"
        const val TYPE_SEND = "mailSend"
        const val TYPE_REPLY = "mailReply"       // legacy text-only reply (hub builds headers)
        const val TYPE_REPLY_SEND = "mailReplySend" // reply/forward with attachments + explicit fields
        const val TYPE_FORWARD = "mailForward"
    }

    // ---------------------------------------------------------------- //
    // Reads

    fun observeInbox(): Flow<List<MailThreadRow>> =
        db.mailThreads().observeInbox(System.currentTimeMillis())

    fun observeThread(id: String): Flow<MailThreadRow?> = db.mailThreads().observeThread(id)
    fun observeSnoozed(): Flow<List<MailThreadRow>> =
        db.mailThreads().observeSnoozed(System.currentTimeMillis())
    suspend fun search(q: String): List<MailThreadRow> = db.mailThreads().search(q)
    fun observeMessages(threadId: String): Flow<List<MailMessageRow>> =
        db.mailMessages().observeForThread(threadId)

    /** Cached send-as aliases (compose From picker). Recency-sorted by hydrate. */
    suspend fun aliases(): List<MailFormat.Alias> {
        val raw = db.meta().get(ALIASES_KEY) ?: return emptyList()
        return runCatching {
            (json.parseToJsonElement(raw) as JsonArray).mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val email = o["email"]?.jsonPrimitive?.content ?: return@mapNotNull null
                MailFormat.Alias(
                    email = email,
                    name = o["name"]?.jsonPrimitive?.content ?: "",
                    isDefault = o["isDefault"]?.jsonPrimitive?.content == "true",
                )
            }
        }.getOrElse { emptyList() }
    }

    suspend fun userEmail(): String = db.meta().get(ACCOUNT_KEY) ?: ""

    /** id→name map for Gmail user labels (thread-row tags). */
    suspend fun labelMap(): Map<String, String> {
        val raw = db.meta().get(LABEL_MAP_KEY) ?: return emptyMap()
        return runCatching {
            (json.parseToJsonElement(raw) as JsonObject).mapValues { it.value.jsonPrimitive.content }
        }.getOrElse { emptyMap() }
    }

    /** User-label ids stored for a thread during hydration (Label_* only). */
    suspend fun threadLabels(threadId: String): List<String> {
        val raw = db.meta().get("$LABELS_PREFIX$threadId") ?: return emptyList()
        return runCatching {
            (json.parseToJsonElement(raw) as JsonArray).mapNotNull { it.jsonPrimitive.content }
        }.getOrElse { emptyList() }
    }

    /** Parsed calendar invite for a message (rendered as an invite card), or null. */
    suspend fun calendarInvite(messageId: String): CalendarInvite? {
        val raw = db.meta().get("$CAL_PREFIX$messageId") ?: return null
        return runCatching { json.decodeFromString(CalendarInvite.serializer(), raw) }.getOrNull()
    }

    /** Local contacts (from/to/cc across cached messages), recency-sorted. */
    suspend fun localContacts(): List<MailContact> {
        val seen = LinkedHashMap<String, MailContact>()
        fun upsert(email: String, name: String, date: Long) {
            val key = email.lowercase()
            val existing = seen[key]
            if (existing == null) seen[key] = MailContact(name, email, date)
            else if (date > existing.lastSeen) {
                seen[key] = existing.copy(
                    lastSeen = date,
                    name = if (existing.name.isBlank() && name.isNotBlank()) name else existing.name,
                )
            }
        }
        // Scan cached messages across all retained threads. search("") → LIKE '%%'
        // returns every cached thread (limit 50 — the whole inbox cache), giving a
        // practical contact pool without a schema/DAO change.
        for (t in db.mailThreads().search("")) {
            for (m in db.mailMessages().forThread(t.id)) {
                val (fn, fe) = GmailParse.parseAddress(m.fromHeader)
                if (fe.contains('@')) upsert(fe, fn, m.date)
                for (addr in MailFormat.splitAddresses(listOfNotNull(m.toHeader, m.ccHeader).joinToString(", "))) {
                    val (n, e) = GmailParse.parseAddress(addr)
                    if (e.contains('@')) upsert(e, n, m.date)
                }
            }
        }
        return seen.values.sortedByDescending { it.lastSeen }
    }

    /** Remote contact search via hub People proxy; empty/errors → []. */
    suspend fun searchContacts(q: String): List<MailContact> {
        if (q.isBlank()) return emptyList()
        return runCatching {
            val resp = hub.get("/mail/contacts?q=${enc(q)}")
            (json.parseToJsonElement(resp) as? JsonArray)?.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val email = o["email"]?.jsonPrimitive?.content ?: return@mapNotNull null
                MailContact(o["name"]?.jsonPrimitive?.content ?: "", email, 0, remote = true)
            } ?: emptyList()
        }.getOrElse { emptyList() }
    }

    data class MailContact(val name: String, val email: String, val lastSeen: Long, val remote: Boolean = false)

    // ---------------------------------------------------------------- //
    // Compose drafts (mail #89) — persisted in the meta KV so an in-progress
    // compose survives sheet dismiss AND process death. Text fields only:
    // attachment content-Uri permission grants don't outlive the process, so
    // persisting them would restore dead references.

    @kotlinx.serialization.Serializable
    data class ComposeDraft(
        val from: String = "", val to: String = "", val cc: String = "",
        val bcc: String = "", val subject: String = "", val body: String = "",
    ) {
        fun isEmpty() = to.isBlank() && cc.isBlank() && bcc.isBlank() && subject.isBlank() && body.isBlank()
    }

    suspend fun saveDraft(key: String, draft: ComposeDraft) {
        if (draft.isEmpty()) { db.meta().delete("$DRAFT_PREFIX$key"); return }
        db.meta().put(MetaRow("$DRAFT_PREFIX$key", json.encodeToString(ComposeDraft.serializer(), draft)))
    }

    suspend fun loadDraft(key: String): ComposeDraft? {
        val raw = db.meta().get("$DRAFT_PREFIX$key") ?: return null
        return runCatching { json.decodeFromString(ComposeDraft.serializer(), raw) }.getOrNull()?.takeIf { !it.isEmpty() }
    }

    suspend fun clearDraft(key: String) = db.meta().delete("$DRAFT_PREFIX$key")

    /** (messageId, attachmentId, filename) for every non-inline attachment in a thread. */
    suspend fun threadAttachments(threadId: String): List<Triple<String, String, String>> {
        val out = mutableListOf<Triple<String, String, String>>()
        for (m in db.mailMessages().forThread(threadId)) {
            val aj = m.attachmentsJson ?: continue
            val arr = runCatching { json.parseToJsonElement(aj) as? JsonArray }.getOrNull() ?: continue
            for (el in arr) {
                val o = el as? JsonObject ?: continue
                if (o["contentId"] != null) continue // inline CID — rendered in body
                val mid = o["messageId"]?.jsonPrimitive?.content ?: m.id
                val aid = o["attachmentId"]?.jsonPrimitive?.content ?: continue
                val name = o["filename"]?.jsonPrimitive?.content ?: "file"
                out.add(Triple(mid, aid, name))
            }
        }
        return out
    }

    /** Attachment ids across the newest [limit] inbox threads (background preload). */
    suspend fun inboxAttachmentTargets(limit: Int = INITIAL_LIMIT): List<Triple<String, String, String>> {
        val out = mutableListOf<Triple<String, String, String>>()
        for (id in db.mailThreads().inboxIds().take(limit)) out.addAll(threadAttachments(id))
        return out
    }

    /**
     * Non-inline attachments of a specific message, fetched + re-encoded to
     * standard base64 as [OutAttachment]s — used to carry a forwarded message's
     * files into the new send (SPA loadForwardAttachments). Best-effort: a
     * failed fetch is skipped.
     */
    suspend fun forwardAttachments(messageId: String): List<OutAttachment> {
        val msg = db.mailMessages().forThread(threadIdOf(messageId) ?: return emptyList())
            .firstOrNull { it.id == messageId } ?: return emptyList()
        val aj = msg.attachmentsJson ?: return emptyList()
        val arr = runCatching { json.parseToJsonElement(aj) as? JsonArray }.getOrNull() ?: return emptyList()
        val out = mutableListOf<OutAttachment>()
        for (el in arr) {
            val o = el as? JsonObject ?: continue
            if (o["contentId"] != null) continue // inline CID
            val aid = o["attachmentId"]?.jsonPrimitive?.content ?: continue
            val name = o["filename"]?.jsonPrimitive?.content ?: "file"
            val mime = o["mimeType"]?.jsonPrimitive?.content ?: "application/octet-stream"
            val urlSafe = fetchAttachmentData(messageId, aid) ?: continue
            // Gmail returns URL-safe base64; the RFC822 builder needs standard base64.
            val std = runCatching {
                android.util.Base64.encodeToString(
                    android.util.Base64.decode(urlSafe, android.util.Base64.URL_SAFE),
                    android.util.Base64.NO_WRAP,
                )
            }.getOrNull() ?: continue
            out.add(OutAttachment(name, mime, std))
        }
        return out
    }

    /** Find which thread a message belongs to (scan cached threads). */
    private suspend fun threadIdOf(messageId: String): String? {
        for (t in db.mailThreads().search("")) {
            if (db.mailMessages().forThread(t.id).any { it.id == messageId }) return t.id
        }
        return null
    }

    // ---------------------------------------------------------------- //
    // Triage mutations — optimistic + queued (all idempotent hub-side)

    suspend fun archive(threadId: String) {
        db.mailThreads().setInbox(threadId, false)
        enqueueSimple(TYPE_ARCHIVE, threadId)
    }

    /** Undo of archive within the toast window: restore the row, cancel a
     *  still-pending archive, and enqueue an unarchive to cover the case the
     *  archive already flushed to Gmail (add-INBOX is idempotent, so this is a
     *  no-op when the thread was never archived server-side). Mirrors the SPA's
     *  undoArchive (removeByThread('archive') + enqueue('unarchive')). */
    suspend fun undoArchive(threadId: String) {
        db.mailThreads().setInbox(threadId, true)
        outbox.cancel(threadId, TYPE_ARCHIVE)
        enqueueSimple(TYPE_UNARCHIVE, threadId)
    }

    suspend fun markRead(threadId: String) {
        db.mailThreads().setUnread(threadId, false)
        enqueueSimple(TYPE_READ, threadId)
    }

    suspend fun markUnread(threadId: String) {
        db.mailThreads().setUnread(threadId, true)
        enqueueSimple(TYPE_UNREAD, threadId)
    }

    suspend fun trash(threadId: String) {
        db.mailThreads().setInbox(threadId, false)
        enqueueSimple(TYPE_TRASH, threadId)
    }

    /** Snooze is CLIENT state (Gmail has no snooze API): archive + local timer. */
    suspend fun snooze(threadId: String, untilMs: Long) {
        db.mailThreads().setSnoozed(threadId, untilMs)
        db.mailThreads().setInbox(threadId, false)
        enqueueSimple(TYPE_ARCHIVE, threadId)
    }

    /** Re-inbox expired snoozes (called from reconcile + a periodic check). */
    suspend fun checkSnoozes() {
        val expired = db.mailThreads().expiredSnoozes(System.currentTimeMillis())
        for (t in expired) {
            db.mailThreads().setSnoozed(t.id, null)
            db.mailThreads().setInbox(t.id, true)
            enqueueSimple(TYPE_UNARCHIVE, t.id)
        }
    }

    private suspend fun enqueueSimple(type: String, threadId: String) {
        val account = db.meta().get(ACCOUNT_KEY) ?: ""
        val payload = buildJsonObject {
            put("threadId", threadId)
            put("account", account)
        }
        outbox.enqueue(type, payload.toString(), entityId = threadId)
    }

    /** Reply (offline-safe). Records the thread's current messageCount for
     *  flush-time conflict detection — if new messages arrived while queued,
     *  the reply parks as `conflict` instead of sending into a stale thread. */
    suspend fun reply(threadId: String, body: String, replyAll: Boolean = false) {
        val thread = db.mailThreads().byId(threadId) ?: return
        val account = db.meta().get(ACCOUNT_KEY) ?: ""
        val payload = buildJsonObject {
            put("threadId", threadId)
            put("body", body)
            put("replyAll", replyAll)
            put("account", account)
            put("baseMessageCount", thread.messageCount)
        }
        outbox.enqueue(TYPE_REPLY, payload.toString(), entityId = threadId)
        // Auto-archive on reply (SPA behaviour).
        archive(threadId)
    }

    suspend fun send(to: String, subject: String, body: String, cc: String? = null) {
        val account = db.meta().get(ACCOUNT_KEY) ?: ""
        val payload = buildJsonObject {
            put("to", to)
            put("subject", subject)
            put("body", body)
            cc?.takeIf { it.isNotBlank() }?.let { put("cc", it) }
            put("account", account)
        }
        outbox.enqueue(TYPE_SEND, payload.toString())
    }

    /** An attachment to send: base64-encoded body (built UI-side from a Uri). */
    data class OutAttachment(val filename: String, val mimeType: String, val data: String)

    private fun attachmentsArray(attachments: List<OutAttachment>) = buildJsonArray {
        for (a in attachments) add(buildJsonObject {
            put("filename", a.filename); put("mimeType", a.mimeType); put("data", a.data)
        })
    }

    /**
     * Full compose (new email) with cc, explicit from, html body, and
     * attachments — POSTs /mail/send (multipart) at flush. `html=true` so the
     * body is treated as HTML by the hub's RFC822 builder.
     */
    suspend fun sendCompose(
        to: String, cc: String?, subject: String, html: String,
        from: String?, attachments: List<OutAttachment> = emptyList(),
    ) {
        val account = db.meta().get(ACCOUNT_KEY) ?: ""
        val payload = buildJsonObject {
            put("to", to)
            cc?.takeIf { it.isNotBlank() }?.let { put("cc", it) }
            put("subject", subject)
            put("body", html)
            put("html", true)
            from?.takeIf { it.isNotBlank() }?.let { put("from", it) }
            if (attachments.isNotEmpty()) put("attachments", attachmentsArray(attachments))
            put("account", account)
        }
        outbox.enqueue(TYPE_SEND, payload.toString())
    }

    /**
     * Reply / reply-all / forward carrying an already-assembled HTML body
     * (user text + quoted original), explicit To/Cc/Subject/From, and
     * attachments. Threaded via the thread's last-message headers, which the
     * flush handler derives (the message row has no Message-ID column).
     * Records baseMessageCount for conflict detection. Auto-archives the thread
     * when [autoArchive] (reply/replyAll — SPA parity).
     */
    suspend fun sendReply(
        threadId: String, to: String, cc: String?, subject: String, html: String,
        from: String?, attachments: List<OutAttachment> = emptyList(), autoArchive: Boolean = true,
    ) {
        val thread = db.mailThreads().byId(threadId)
        val account = db.meta().get(ACCOUNT_KEY) ?: ""
        val payload = buildJsonObject {
            put("threadId", threadId)
            put("to", to)
            cc?.takeIf { it.isNotBlank() }?.let { put("cc", it) }
            put("subject", subject)
            put("body", html)
            put("html", true)
            from?.takeIf { it.isNotBlank() }?.let { put("from", it) }
            if (attachments.isNotEmpty()) put("attachments", attachmentsArray(attachments))
            thread?.messageCount?.let { put("baseMessageCount", it) }
            put("account", account)
        }
        outbox.enqueue(TYPE_REPLY_SEND, payload.toString(), entityId = threadId)
        if (autoArchive) archive(threadId)
    }

    /** Forward a thread (hub builds Fwd: subject + header block; text-only, legacy). */
    suspend fun forward(threadId: String, to: String, note: String?) {
        val account = db.meta().get(ACCOUNT_KEY) ?: ""
        val payload = buildJsonObject {
            put("threadId", threadId)
            put("to", to)
            note?.takeIf { it.isNotBlank() }?.let { put("body", it) }
            put("account", account)
        }
        outbox.enqueue(TYPE_FORWARD, payload.toString(), entityId = threadId)
    }

    /** Delete → Gmail trash. Optimistic remove from inbox; undoable pre-flush. */
    suspend fun deleteThread(threadId: String) {
        db.mailThreads().setInbox(threadId, false)
        enqueueSimple(TYPE_TRASH, threadId)
    }

    /** Undo delete within the toast window: restore + drop the queued trash.
     *  (Gmail has no untrash route — like the SPA, undo only reverses pre-flush.) */
    suspend fun undoDelete(threadId: String) {
        db.mailThreads().setInbox(threadId, true)
        outbox.cancel(threadId, TYPE_TRASH)
    }

    // ---------------------------------------------------------------- //
    // Outbox handlers

    fun registerOutboxHandlers() {
        val labelOp = { pathSuffix: String ->
            Outbox.Handler { row, _ ->
                val p = json.parseToJsonElement(row.payloadJson).jsonObject
                val threadId = p["threadId"]!!.jsonPrimitive.content
                val account = p["account"]?.jsonPrimitive?.content ?: ""
                try {
                    hub.post("/mail/threads/${enc(threadId)}/$pathSuffix${accountQuery(account)}")
                    Outbox.Result.Done
                } catch (e: HubClient.HttpException) {
                    when {
                        // Thread already gone from Gmail — the label op is moot;
                        // treat as success or the row wedges the sync banner.
                        e.code == 404 || e.code == 410 -> Outbox.Result.Done
                        // Other 4xx = permanent — don't retry forever.
                        e.code in 400..499 -> Outbox.Result.Fail("HTTP ${e.code}")
                        else -> Outbox.Result.Retry("HTTP ${e.code}")
                    }
                } catch (e: Exception) {
                    Outbox.Result.Retry(e.message ?: "network")
                }
            }
        }
        outbox.register(TYPE_ARCHIVE, labelOp("archive"))
        outbox.register(TYPE_UNARCHIVE, labelOp("unarchive"))
        outbox.register(TYPE_READ, labelOp("read"))
        outbox.register(TYPE_UNREAD, labelOp("unread"))
        outbox.register(TYPE_TRASH, labelOp("trash"))

        outbox.register(TYPE_REPLY) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val threadId = p["threadId"]!!.jsonPrimitive.content
            val account = p["account"]?.jsonPrimitive?.content ?: ""
            val baseCount = p["baseMessageCount"]?.jsonPrimitive?.content?.toIntOrNull()
            try {
                // Conflict detection (port of the SPA's processQueue check):
                // refetch the thread; more messages than at enqueue → park.
                if (baseCount != null) {
                    val fresh = hub.get("/mail/threads/${enc(threadId)}${accountQuery(account)}")
                    val freshCount = (json.parseToJsonElement(fresh).jsonObject["messages"] as? JsonArray)?.size ?: 0
                    if (freshCount > baseCount) {
                        return@register Outbox.Result.Conflict("New messages arrived — review before sending")
                    }
                }
                val sendBody = buildJsonObject {
                    put("threadId", threadId)
                    put("body", p["body"]!!.jsonPrimitive.content)
                    put("replyAll", p["replyAll"]?.jsonPrimitive?.content == "true")
                    put("clientToken", row.dedupeToken)
                }
                hub.post("/mail/reply${accountQuery(account)}", sendBody.toString())
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}")
                else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }

        // Reply / reply-all / forward WITH attachments + a client-assembled HTML
        // body. Derives threading headers from the live thread, does the same
        // conflict check as TYPE_REPLY, then POSTs /mail/send (multipart-capable).
        outbox.register(TYPE_REPLY_SEND) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val threadId = p["threadId"]!!.jsonPrimitive.content
            val account = p["account"]?.jsonPrimitive?.content ?: ""
            val baseCount = p["baseMessageCount"]?.jsonPrimitive?.content?.toIntOrNull()
            try {
                var inReplyTo: String? = null
                var references: String? = null
                runCatching {
                    val fresh = hub.get("/mail/threads/${enc(threadId)}${accountQuery(account)}")
                    val msgs = (json.parseToJsonElement(fresh).jsonObject["messages"] as? JsonArray)
                    if (baseCount != null && (msgs?.size ?: 0) > baseCount) {
                        return@register Outbox.Result.Conflict("New messages arrived — review before sending")
                    }
                    val last = msgs?.lastOrNull() as? JsonObject
                    val headers = ((last?.get("payload") as? JsonObject)?.get("headers") as? JsonArray)
                    headers?.forEach { h ->
                        val o = h as? JsonObject ?: return@forEach
                        when (o["name"]?.jsonPrimitive?.content?.lowercase()) {
                            "message-id" -> inReplyTo = o["value"]?.jsonPrimitive?.content
                            "references" -> references = o["value"]?.jsonPrimitive?.content
                        }
                    }
                }
                val refs = when {
                    inReplyTo != null && references != null -> "$references $inReplyTo"
                    inReplyTo != null -> inReplyTo
                    else -> references
                }
                val sendBody = buildJsonObject {
                    put("to", p["to"]!!.jsonPrimitive.content)
                    p["cc"]?.jsonPrimitive?.content?.let { put("cc", it) }
                    put("subject", p["subject"]?.jsonPrimitive?.content ?: "")
                    put("body", p["body"]!!.jsonPrimitive.content)
                    put("html", true)
                    p["from"]?.jsonPrimitive?.content?.let { put("from", it) }
                    put("threadId", threadId)
                    inReplyTo?.let { put("inReplyTo", it) }
                    refs?.let { put("references", it) }
                    (p["attachments"] as? JsonArray)?.let { put("attachments", it) }
                    put("clientToken", row.dedupeToken)
                }
                hub.post("/mail/send${accountQuery(account)}", sendBody.toString())
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }

        outbox.register(TYPE_FORWARD) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val account = p["account"]?.jsonPrimitive?.content ?: ""
            try {
                val body = buildJsonObject {
                    put("threadId", p["threadId"]!!.jsonPrimitive.content)
                    put("to", p["to"]!!.jsonPrimitive.content)
                    p["body"]?.jsonPrimitive?.content?.let { put("body", it) }
                    put("clientToken", row.dedupeToken)
                }
                hub.post("/mail/forward${accountQuery(account)}", body.toString())
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }
        outbox.register(TYPE_SEND) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val account = p["account"]?.jsonPrimitive?.content ?: ""
            try {
                val sendBody = buildJsonObject {
                    put("to", p["to"]!!.jsonPrimitive.content)
                    put("subject", p["subject"]?.jsonPrimitive?.content ?: "")
                    put("body", p["body"]!!.jsonPrimitive.content)
                    p["cc"]?.jsonPrimitive?.content?.let { put("cc", it) }
                    p["from"]?.jsonPrimitive?.content?.let { put("from", it) }
                    // html=true → hub treats body as HTML instead of wrapping in <pre>.
                    if (p["html"]?.jsonPrimitive?.content == "true") put("html", true)
                    (p["attachments"] as? JsonArray)?.let { put("attachments", it) }
                    put("clientToken", row.dedupeToken)
                }
                hub.post("/mail/send${accountQuery(account)}", sendBody.toString())
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}")
                else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }
    }

    // ---------------------------------------------------------------- //
    // Sync

    fun wireLiveDeltas(scope: CoroutineScope) {
        syncBus.on("mail", "delta") { data ->
            scope.launch {
                runCatching {
                    val obj = data.jsonObject
                    val account = obj["account"]?.jsonPrimitive?.content ?: return@runCatching
                    val added = (obj["added"] as? JsonArray)?.mapNotNull {
                        runCatching { it.jsonPrimitive.content }.getOrNull()
                    } ?: emptyList()
                    // labelChanged + removed affect flags/membership; a full
                    // catch-up pass handles them uniformly.
                    catchUp(account)
                    if (added.isNotEmpty()) hydrateThreads(added, account)
                }
            }
        }
    }

    suspend fun reconcile() {
        checkSnoozes()
        val account = db.meta().get(ACCOUNT_KEY)
        if (account == null) {
            // First run: discover the primary account, then full hydrate.
            val profile = runCatching { json.parseToJsonElement(hub.get("/mail/profile")).jsonObject }.getOrNull() ?: return
            val email = profile["emailAddress"]?.jsonPrimitive?.content ?: return
            db.meta().put(MetaRow(ACCOUNT_KEY, email))
            syncAuxData(email)
            fullHydrate(email)
            return
        }
        syncAuxData(account)
        val cursor = db.meta().get("$CURSOR_PREFIX$account")
        if (cursor == null) {
            fullHydrate(account)
        } else {
            catchUp(account)
        }
    }

    /** Fetch send-as aliases (recency-sorted) + label id→name map; store in meta.
     *  Failures are independent (parity with the SPA's allSettled). */
    internal suspend fun syncAuxData(account: String) {
        runCatching {
            val resp = hub.get("/mail/aliases${accountQuery(account)}")
            val arr = json.parseToJsonElement(resp) as? JsonArray ?: return@runCatching
            db.meta().put(MetaRow(ALIASES_KEY, sortAliasesByRecency(arr).toString()))
        }
        runCatching {
            val resp = hub.get("/mail/labels${accountQuery(account)}")
            val arr = json.parseToJsonElement(resp) as? JsonArray ?: return@runCatching
            val map = buildJsonObject {
                for (el in arr) {
                    val o = el as? JsonObject ?: continue
                    val id = o["id"]?.jsonPrimitive?.content ?: continue
                    put(id, o["name"]?.jsonPrimitive?.content ?: id)
                }
            }
            db.meta().put(MetaRow(LABEL_MAP_KEY, map.toString()))
        }
    }

    /** Sort aliases by recency of appearance in cached messages' To/Cc (ComposeEditor). */
    private suspend fun sortAliasesByRecency(arr: JsonArray): JsonArray {
        val aliases = arr.mapNotNull { it as? JsonObject }
        if (aliases.size <= 1) return arr
        val emails = aliases.mapNotNull { it["email"]?.jsonPrimitive?.content?.lowercase() }
        val recency = HashMap<String, Long>()
        outer@ for (t in db.mailThreads().search("")) {
            for (m in db.mailMessages().forThread(t.id)) {
                val recipients = listOfNotNull(m.toHeader, m.ccHeader).joinToString(", ").lowercase()
                for (e in emails) if (e !in recency && recipients.contains(e)) recency[e] = m.date
                if (recency.size >= emails.size) break@outer
            }
        }
        val sorted = aliases.sortedByDescending { recency[it["email"]?.jsonPrimitive?.content?.lowercase()] ?: 0L }
        return buildJsonArray { sorted.forEach { add(it) } }
    }

    /** One-request initial hydrate via the M3 batch endpoint. */
    internal suspend fun fullHydrate(account: String) {
        val resp = runCatching {
            hub.get("/mail/threads?full=1&limit=$INITIAL_LIMIT&account=${enc(account)}")
        }.getOrNull() ?: return
        val obj = json.parseToJsonElement(resp).jsonObject
        val threads = (obj["threads"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: return
        val historyId = obj["historyId"]?.jsonPrimitive?.content

        db.withTransaction {
            val parsed = threads.mapNotNull { GmailParse.threadRows(it, account) }
            val threadRows = parsed.map { it.first }
            // Preserve local snooze state across re-hydration.
            val withSnooze = threadRows.map { row ->
                val existing = db.mailThreads().byId(row.id)
                if (existing?.snoozedUntil != null) row.copy(snoozedUntil = existing.snoozedUntil, isInbox = existing.isInbox) else row
            }
            db.mailThreads().upsertAll(withSnooze)
            db.mailMessages().upsertAll(parsed.flatMap { it.second })
            if (historyId != null) db.meta().put(MetaRow("$CURSOR_PREFIX$account", historyId))
        }
        persistThreadAux(threads, account)
        // Stale rows are handled by the bidirectional membership sweep, which
        // keys off the id-LISTING — never off which threads happened to
        // hydrate successfully (a flaky per-thread fetch is not an archive).
        reconcileInboxMembership(account)
    }

    /**
     * Store per-thread aux data in the meta KV table (no schema change):
     *  - user Gmail label ids (Label_*) for the thread-row tags,
     *  - parsed calendar invite per message carrying a text/calendar part
     *    (fetching the ICS attachment body when it's not inlined).
     */
    private suspend fun persistThreadAux(threads: List<JsonObject>, account: String) {
        for (thread in threads) {
            val tid = thread["id"]?.jsonPrimitive?.content ?: continue
            val labels = GmailParse.userLabelIds(thread)
            if (labels.isNotEmpty()) {
                db.meta().put(MetaRow("$LABELS_PREFIX$tid",
                    buildJsonArray { labels.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }.toString()))
            } else {
                db.meta().delete("$LABELS_PREFIX$tid")
            }
            val messages = (thread["messages"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: continue
            for (msg in messages) {
                val part = GmailParse.calendarPart(msg) ?: continue
                val (inlineData, attId, mid) = part
                val icsBase64 = inlineData ?: attId?.let { fetchAttachmentData(mid, it) } ?: continue
                val ics = runCatching {
                    String(android.util.Base64.decode(icsBase64, android.util.Base64.URL_SAFE), Charsets.UTF_8)
                }.getOrNull() ?: continue
                val invite = runCatching { IcsParser.parse(ics) }.getOrNull() ?: continue
                db.meta().put(MetaRow("$CAL_PREFIX$mid",
                    json.encodeToString(CalendarInvite.serializer(), invite)))
            }
        }
    }

    private suspend fun fetchAttachmentData(messageId: String, attachmentId: String): String? = runCatching {
        val resp = hub.get("/mail/messages/${enc(messageId)}/attachments/${enc(attachmentId)}")
        json.parseToJsonElement(resp).jsonObject["data"]?.jsonPrimitive?.content
    }.getOrNull()

    /** History catch-up from the persisted cursor; expired → full re-init. */
    internal suspend fun catchUp(account: String) {
        val cursor = db.meta().get("$CURSOR_PREFIX$account") ?: return fullHydrate(account)
        val resp = try {
            hub.get("/mail/history?startHistoryId=${enc(cursor)}&account=${enc(account)}")
        } catch (e: HubClient.HttpException) {
            if (e.code == 404 || e.code == 400) {
                // History expired — Gmail forgot our cursor. Full re-init.
                fullHydrate(account)
            }
            return
        } catch (_: Exception) {
            return
        }
        val obj = json.parseToJsonElement(resp).jsonObject
        val history = (obj["history"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
        val newHistoryId = obj["historyId"]?.jsonPrimitive?.content

        // Collect every thread id touched by any history record type.
        val touched = mutableSetOf<String>()
        for (h in history) {
            for (key in listOf("messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved")) {
                (h[key] as? JsonArray)?.forEach { rec ->
                    val msg = (rec as? JsonObject)?.get("message") as? JsonObject
                    msg?.get("threadId")?.jsonPrimitive?.content?.let { touched.add(it) }
                }
            }
        }
        if (touched.isNotEmpty()) hydrateThreads(touched.toList(), account)
        if (newHistoryId != null) db.meta().put(MetaRow("$CURSOR_PREFIX$account", newHistoryId))
        reconcileInboxMembership(account)
    }

    /** BIDIRECTIONAL membership sweep against a cheap in:inbox id-listing —
     *  the listing is the authority on what belongs in the inbox.
     *  Remove: local rows Gmail no longer lists (outright deletions never show
     *  in history catch-up). Restore: listed threads that are locally
     *  de-inboxed (e.g. a past partial hydrate dropped them — hydration
     *  failures must never masquerade as archives) or missing entirely.
     *  Local intent wins: snoozed rows and rows with a queued archive/trash/
     *  unarchive keep their optimistic state. */
    internal suspend fun reconcileInboxMembership(account: String) {
        val resp = runCatching {
            hub.get("/mail/threads?q=${enc("in:inbox")}&limit=$INITIAL_LIMIT&account=${enc(account)}")
        }.getOrNull() ?: return
        val listed = ((json.parseToJsonElement(resp).jsonObject["threads"] as? JsonArray) ?: return)
            .mapNotNull { (it as? JsonObject)?.get("id")?.jsonPrimitive?.content }
            .toSet()
        if (listed.isEmpty()) return // implausible empty inbox — likely an API hiccup; don't wipe
        val pending = db.outbox().pending()
        val pendingDeinbox = pending
            .filter { it.type == TYPE_ARCHIVE || it.type == TYPE_TRASH }
            .mapNotNull { it.entityId }.toSet()
        val pendingReinbox = pending
            .filter { it.type == TYPE_UNARCHIVE }
            .mapNotNull { it.entityId }.toSet()
        for (id in db.mailThreads().inboxIds()) {
            if (id in listed || id in pendingReinbox) continue
            val row = db.mailThreads().byId(id)
            if (row?.snoozedUntil == null) db.mailThreads().setInbox(id, false)
        }
        val toHydrate = mutableListOf<String>()
        for (id in listed) {
            if (id in pendingDeinbox) continue
            val row = db.mailThreads().byId(id)
            when {
                row == null -> toHydrate.add(id)
                !row.isInbox && row.snoozedUntil == null -> db.mailThreads().setInbox(id, true)
            }
        }
        if (toHydrate.isNotEmpty()) hydrateThreads(toHydrate, account)
    }

    /** Batch-hydrate specific thread ids (delta/catch-up path). */
    internal suspend fun hydrateThreads(ids: List<String>, account: String) {
        if (ids.isEmpty()) return
        val body = buildJsonObject {
            put("ids", buildJsonArray { ids.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
        }
        val resp = runCatching {
            hub.post("/mail/threads/batch?account=${enc(account)}", body.toString())
        }.getOrNull() ?: return
        val threads = (json.parseToJsonElement(resp).jsonObject["threads"] as? JsonArray)
            ?.mapNotNull { it as? JsonObject } ?: return
        db.withTransaction {
            val parsed = threads.mapNotNull { GmailParse.threadRows(it, account) }
            val withSnooze = parsed.map { (row, _) ->
                val existing = db.mailThreads().byId(row.id)
                if (existing?.snoozedUntil != null) row.copy(snoozedUntil = existing.snoozedUntil, isInbox = false) else row
            }
            db.mailThreads().upsertAll(withSnooze)
            db.mailMessages().upsertAll(parsed.flatMap { it.second })
        }
        persistThreadAux(threads, account)
    }

    /** Daily prune: evict bodies outside the newest N inbox threads. */
    suspend fun prune() {
        db.mailMessages().evictBodiesOutsideNewest(BODY_KEEP)
    }

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
    private fun accountQuery(account: String): String =
        if (account.isEmpty()) "" else "?account=${enc(account)}"
}
