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
        const val INITIAL_LIMIT = 50
        const val BODY_KEEP = 50
        const val TYPE_ARCHIVE = "mailArchive"
        const val TYPE_UNARCHIVE = "mailUnarchive"
        const val TYPE_READ = "mailRead"
        const val TYPE_UNREAD = "mailUnread"
        const val TYPE_TRASH = "mailTrash"
        const val TYPE_SEND = "mailSend"
        const val TYPE_REPLY = "mailReply"
    }

    // ---------------------------------------------------------------- //
    // Reads

    fun observeInbox(): Flow<List<MailThreadRow>> =
        db.mailThreads().observeInbox(System.currentTimeMillis())

    fun observeThread(id: String): Flow<MailThreadRow?> = db.mailThreads().observeThread(id)
    fun observeMessages(threadId: String): Flow<List<MailMessageRow>> =
        db.mailMessages().observeForThread(threadId)

    // ---------------------------------------------------------------- //
    // Triage mutations — optimistic + queued (all idempotent hub-side)

    suspend fun archive(threadId: String) {
        db.mailThreads().setInbox(threadId, false)
        enqueueSimple(TYPE_ARCHIVE, threadId)
    }

    /** Undo of archive within the toast window: restore + cancel the queue row. */
    suspend fun undoArchive(threadId: String) {
        db.mailThreads().setInbox(threadId, true)
        outbox.cancel(threadId, TYPE_ARCHIVE)
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

    suspend fun send(to: String, subject: String, body: String) {
        val account = db.meta().get(ACCOUNT_KEY) ?: ""
        val payload = buildJsonObject {
            put("to", to)
            put("subject", subject)
            put("body", body)
            put("account", account)
        }
        outbox.enqueue(TYPE_SEND, payload.toString())
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
                    // 4xx = permanent (thread gone etc.) — don't retry forever.
                    if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}")
                    else Outbox.Result.Retry("HTTP ${e.code}")
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

        outbox.register(TYPE_SEND) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val account = p["account"]?.jsonPrimitive?.content ?: ""
            try {
                val sendBody = buildJsonObject {
                    put("to", p["to"]!!.jsonPrimitive.content)
                    put("subject", p["subject"]!!.jsonPrimitive.content)
                    put("body", p["body"]!!.jsonPrimitive.content)
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
            fullHydrate(email)
            return
        }
        val cursor = db.meta().get("$CURSOR_PREFIX$account")
        if (cursor == null) {
            fullHydrate(account)
        } else {
            catchUp(account)
        }
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
            // Threads no longer in the inbox listing leave the inbox (keep
            // snoozed rows — they're deliberately archived server-side).
            val listedIds = threadRows.map { it.id }.toSet()
            val stale = db.mailThreads().inboxIds().filter { it !in listedIds }
            for (id in stale) {
                val row = db.mailThreads().byId(id)
                if (row?.snoozedUntil == null) db.mailThreads().setInbox(id, false)
            }
            if (historyId != null) db.meta().put(MetaRow("$CURSOR_PREFIX$account", historyId))
        }
    }

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
    }

    /** Daily prune: evict bodies outside the newest N inbox threads. */
    suspend fun prune() {
        db.mailMessages().evictBodiesOutsideNewest(BODY_KEEP)
    }

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
    private fun accountQuery(account: String): String =
        if (account.isEmpty()) "" else "?account=${enc(account)}"
}
