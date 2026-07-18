package io.amar.console.data.agents

import io.amar.console.HubTokenStore
import io.amar.console.core.HubClient
import io.amar.console.core.HubConfig
import io.amar.console.data.db.AgentMessageRow
import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * Agents domain: session list + transcripts cached in Room (readable
 * offline), queued sends with dedupeKey, approve/deny (online-only —
 * single-shot on a requestId), live streaming while foreground.
 *
 * Transport: the hub's agent protocol rides the DEFAULT WS upgrade path
 * (not /sync). Connect burst = sessions_list + last-50 replay per session;
 * we additionally page gaps via the M5 REST endpoint
 * GET /agents/sessions/:id/messages?since=.
 */
class AgentsRepository(
    private val scope: CoroutineScope,
    private val db: ConsoleDb,
    private val hub: HubClient,
    private val outbox: Outbox,
) {
    private val json = Json { ignoreUnknownKeys = true }

    companion object {
        const val TYPE_SEND = "agentSend"
        const val SESSION_CACHE_LIMIT = 200
    }

    // Live approval requests (transient — not persisted; approvals are
    // meaningless offline since the CLI is blocked waiting).
    data class Approval(
        val sessionId: String,
        val requestId: String,
        val toolName: String,
        val inputJson: String,       // FULL input — echoed back on approve (CLI requires it)
    )
    private val _approvals = MutableStateFlow<List<Approval>>(emptyList())
    val approvals: StateFlow<List<Approval>> = _approvals

    private val _connected = MutableStateFlow(false)
    val connectedFlow: StateFlow<Boolean> = _connected

    /** Live per-session activity — THE "is the agent doing something" signal
     *  (streaming, current tool, status line). Transient; not persisted. */
    data class Activity(
        val running: Boolean = false,
        val currentTool: String? = null,
        val statusText: String? = null,
        val streamingText: String = "",
    )
    private val _activity = MutableStateFlow<Map<String, Activity>>(emptyMap())
    val activity: StateFlow<Map<String, Activity>> = _activity
    private fun setActivity(sessionId: String, fn: (Activity) -> Activity) {
        _activity.value = _activity.value + (sessionId to fn(_activity.value[sessionId] ?: Activity()))
    }

    /** Sessions whose REST catch-up has run this connection. Stream messages
     *  for sessions NOT in this set are skipped: the hub replays the last 50
     *  messages per session right after `sessions_list` on every connect, and
     *  appending those at maxIndex+1 would duplicate what the REST catch-up
     *  (which has authoritative absolute indices) also delivers. */
    private val caughtUp = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** Live-turn delta buffer per session. The hub streams `text_delta`
     *  chunks; the coalesced `text` goes only into its LOG (replay/REST), not
     *  the live wire — so without local coalescing a live reply never renders.
     *  Mirrors server/src/session.ts flushPendingDeltas: accumulate, flush to
     *  a Room row when a non-delta message arrives for the session. */
    private val pendingText = java.util.concurrent.ConcurrentHashMap<String, StringBuilder>()

    private var ws: WebSocket? = null
    private var wantConnected = false
    private var reconnectJob: Job? = null
    private val okHttp = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    fun observeSessions(): Flow<List<AgentSessionRow>> = db.agents().observeSessions()
    fun observeMessages(sessionId: String, limit: Int = 100): Flow<List<AgentMessageRow>> =
        db.agents().observeRecent(sessionId, limit)

    // ---------------------------------------------------------------- //
    // WS lifecycle (foreground-gated by SyncEngine-style start/stop)

    fun start() {
        if (wantConnected) return
        wantConnected = true
        open()
    }

    fun stop() {
        wantConnected = false
        reconnectJob?.cancel()
        ws?.close(1000, "bg")
        ws = null
        _connected.value = false
    }

    private fun open() {
        if (!wantConnected) return
        val builder = Request.Builder().url(HubConfig.agentsWsUrl)
        HubTokenStore.get()?.let { builder.header("Authorization", "Bearer $it") }
        ws = okHttp.newWebSocket(builder.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                caughtUp.clear() // fresh replay burst incoming — re-gate appends
                _connected.value = true
                // Flush any prompts queued while offline now that sends can land.
                outbox.scheduleDrain()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { runCatching { handleHubMessage(text) } }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onDisconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onDisconnect()
            }
        })
    }

    private fun onDisconnect() {
        _connected.value = false
        _approvals.value = emptyList()
        if (!wantConnected) return
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(3000)
            if (wantConnected) open()
        }
    }

    // ---------------------------------------------------------------- //
    // Inbound protocol

    private suspend fun handleHubMessage(text: String) {
        val msg = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (msg["type"]?.jsonPrimitive?.content) {
            "sessions_list" -> {
                val sessions = (msg["sessions"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: return
                val rows = sessions.mapNotNull { sessionRow(it) }
                db.agents().upsertSessions(rows)
                db.agents().deleteAbsent(rows.map { it.id })
                // Catch up transcripts for sessions we lag on (REST — indices
                // are authoritative); then open the live-append gate.
                for (row in rows) {
                    val cached = db.agents().maxIndex(row.id) ?: -1L
                    if (row.messageLogLength - 1 > cached) {
                        catchUpSession(row.id, cached + 1)
                    }
                    caughtUp.add(row.id)
                }
            }
            // Live streaming: the hub sends text as `text_delta` chunks (the
            // coalesced `text` only lands in its log for replay/REST).
            // Accumulate per session; flush on any non-delta message —
            // mirrors server/src/session.ts flushPendingDeltas.
            "text_delta" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                if (sessionId !in caughtUp) return
                val chunk = msg["content"]?.jsonPrimitive?.content ?: return
                val sb = pendingText.getOrPut(sessionId) { StringBuilder() }.append(chunk)
                setActivity(sessionId) { it.copy(running = true, streamingText = sb.toString().takeLast(2000)) }
                // Live-render the partial: upsert a rolling `text` row at the
                // NEXT index (replaced in place until the flush finalizes it).
                upsertPendingTextRow(sessionId)
            }
            // Loggable stream messages — persist at the next absolute index.
            // Gated on catch-up so the hub's connect replay can't double-append.
            "text", "user_prompt", "tool_use", "tool_result", "thinking", "result", "tool_diff", "bg_task", "session_ended" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                if (sessionId !in caughtUp) return
                when (msg["type"]?.jsonPrimitive?.content) {
                    "text" -> {
                        // Finalized text supersedes the delta buffer (same content,
                        // coalesced hub-side) — replace the rolling row.
                        pendingText.remove(sessionId)
                        replacePendingTextRow(sessionId, msg)
                        setActivity(sessionId) { it.copy(streamingText = "") }
                        return
                    }
                    "tool_use" -> setActivity(sessionId) {
                        it.copy(running = true, currentTool = msg["toolName"]?.jsonPrimitive?.content)
                    }
                    "tool_result" -> setActivity(sessionId) { it.copy(currentTool = null) }
                    "user_prompt" -> setActivity(sessionId) { it.copy(running = true) }
                    "result" -> setActivity(sessionId) {
                        it.copy(running = false, currentTool = null, statusText = null, streamingText = "")
                    }
                }
                flushPendingText(sessionId)
                appendMessage(sessionId, msg)
            }
            "approval_required" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                val requestId = msg["requestId"]?.jsonPrimitive?.content ?: return
                val toolName = msg["toolName"]?.jsonPrimitive?.content ?: "tool"
                val inputJson = msg["input"]?.toString() ?: "{}"
                val approval = Approval(sessionId, requestId, toolName, inputJson)
                if (toolName in autoApproveTools) {
                    _approvals.value = _approvals.value + approval // approve() reads input from the list
                    approve(sessionId, requestId)
                } else {
                    _approvals.value = _approvals.value + approval
                }
            }
            "tool_approved", "tool_denied" -> {
                val requestId = msg["requestId"]?.jsonPrimitive?.content ?: return
                _approvals.value = _approvals.value.filter { it.requestId != requestId }
            }
            "status" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                val text = msg["text"]?.jsonPrimitive?.content ?: ""
                setActivity(sessionId) { it.copy(statusText = text) }
            }
            "session_init" -> {
                // Turn started / respawned — mark running.
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                setActivity(sessionId) { it.copy(running = false, statusText = null) }
            }
            "error" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                appendMessage(sessionId, msg)
                setActivity(sessionId) { it.copy(running = false, currentTool = null, statusText = null) }
            }
            "session_read_state" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                val lastRead = msg["lastReadIndex"]?.jsonPrimitive?.longOrNull ?: return
                val len = msg["messageLogLength"]?.jsonPrimitive?.longOrNull ?: return
                db.agents().byId(sessionId)?.let {
                    db.agents().upsertSessions(listOf(it.copy(hasUnread = len > lastRead, messageLogLength = len)))
                }
            }
        }
    }

    /** Fixed index the current streaming turn's text row occupies. */
    private val pendingRowIndex = java.util.concurrent.ConcurrentHashMap<String, Long>()

    private suspend fun upsertPendingTextRow(sessionId: String) {
        val buffer = pendingText[sessionId]?.toString() ?: return
        val index = pendingRowIndex.getOrPut(sessionId) { (db.agents().maxIndex(sessionId) ?: -1L) + 1 }
        db.agents().replaceMessage(
            AgentMessageRow(
                sessionId = sessionId, absIndex = index, kind = "text",
                payloadJson = buildJsonObject {
                    put("type", "text")
                    put("sessionId", sessionId)
                    put("content", buffer)
                }.toString(),
            )
        )
    }

    /** Finalized `text` message replaces the rolling row (or appends fresh). */
    private suspend fun replacePendingTextRow(sessionId: String, msg: JsonObject) {
        val index = pendingRowIndex.remove(sessionId) ?: (db.agents().maxIndex(sessionId) ?: -1L) + 1
        db.agents().replaceMessage(
            AgentMessageRow(sessionId = sessionId, absIndex = index, kind = "text", payloadJson = msg.toString())
        )
        bumpCachedIndex(sessionId, index)
    }

    private suspend fun flushPendingText(sessionId: String) {
        val buffer = pendingText.remove(sessionId)?.toString()?.takeIf { it.isNotEmpty() }
        val index = pendingRowIndex.remove(sessionId)
        if (buffer != null && index != null) bumpCachedIndex(sessionId, index)
    }

    private suspend fun bumpCachedIndex(sessionId: String, index: Long) {
        db.agents().byId(sessionId)?.let {
            db.agents().upsertSessions(
                listOf(it.copy(lastCachedIndex = maxOf(it.lastCachedIndex, index), messageLogLength = maxOf(it.messageLogLength, index + 1)))
            )
        }
    }

    private suspend fun appendMessage(sessionId: String, msg: JsonObject) {
        val next = (db.agents().maxIndex(sessionId) ?: -1L) + 1
        db.agents().insertMessages(
            listOf(
                AgentMessageRow(
                    sessionId = sessionId,
                    absIndex = next,
                    kind = msg["type"]?.jsonPrimitive?.content ?: "unknown",
                    payloadJson = msg.toString(),
                )
            )
        )
        db.agents().byId(sessionId)?.let {
            db.agents().upsertSessions(listOf(it.copy(lastCachedIndex = next, messageLogLength = maxOf(it.messageLogLength, next + 1))))
        }
    }

    /** REST catch-up (M5 hub endpoint): page forward from our high-water. */
    private suspend fun catchUpSession(sessionId: String, since: Long) {
        val resp = runCatching {
            hub.get("/agents/sessions/${java.net.URLEncoder.encode(sessionId, "UTF-8")}/messages?since=$since&limit=$SESSION_CACHE_LIMIT")
        }.getOrNull() ?: return
        val obj = json.parseToJsonElement(resp).jsonObject
        val messages = (obj["messages"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: return
        val fromIndex = obj["fromIndex"]?.jsonPrimitive?.longOrNull ?: since
        val rows = messages.mapIndexed { i, m ->
            AgentMessageRow(
                sessionId = sessionId,
                absIndex = fromIndex + i,
                kind = m["type"]?.jsonPrimitive?.content ?: "unknown",
                payloadJson = m.toString(),
            )
        }
        if (rows.isNotEmpty()) db.agents().insertMessages(rows)
        val last = rows.lastOrNull()?.absIndex
        if (last != null) {
            db.agents().byId(sessionId)?.let {
                db.agents().upsertSessions(listOf(it.copy(lastCachedIndex = maxOf(it.lastCachedIndex, last))))
            }
        }
    }

    private fun sessionRow(s: JsonObject): AgentSessionRow? {
        val id = s["id"]?.jsonPrimitive?.content ?: return null
        val logLen = s["messageLogLength"]?.jsonPrimitive?.longOrNull ?: 0L
        val lastRead = s["lastReadIndex"]?.jsonPrimitive?.longOrNull ?: 0L
        return AgentSessionRow(
            id = id,
            name = s["name"]?.jsonPrimitive?.content ?: id,
            status = s["status"]?.jsonPrimitive?.content ?: "idle",
            hasUnread = logLen > lastRead,
            needsAttention = s["needsAttention"] != null && s["needsAttention"] !is kotlinx.serialization.json.JsonNull,
            attentionSnippet = (s["needsAttention"] as? JsonObject)?.get("snippet")?.jsonPrimitive?.content,
            agentKey = s["agentKey"]?.jsonPrimitive?.content,
            modelLabel = s["model"]?.jsonPrimitive?.content,
            hibernated = s["hibernated"]?.jsonPrimitive?.booleanOrNull ?: false,
            cwd = s["cwd"]?.jsonPrimitive?.content,
            lastCachedIndex = -1L, // filled after catch-up
            messageLogLength = logLen,
        )
    }

    // ---------------------------------------------------------------- //
    // Mutations

    /** Send a prompt — queued offline, deduped by key on the hub. */
    suspend fun sendPrompt(sessionId: String, content: String) {
        val payload = buildJsonObject {
            put("sessionId", sessionId)
            put("content", content)
        }
        // Optimistic local user_prompt row so the transcript shows it now.
        appendMessage(sessionId, buildJsonObject {
            put("type", "user_prompt")
            put("sessionId", sessionId)
            put("content", content)
        })
        outbox.enqueue(TYPE_SEND, payload.toString(), entityId = sessionId)
    }

    /** Approve/deny — online-only by design (single-shot requestId).
     *  The Claude CLI REQUIRES the input echoed back in the approve response
     *  (`modifiedInput`), so pass the approval's original input (or an edited
     *  version) — approving with nothing silently breaks the tool call. */
    fun approve(sessionId: String, requestId: String, modifiedInputJson: String? = null) {
        val approval = _approvals.value.firstOrNull { it.requestId == requestId }
        val inputJson = modifiedInputJson ?: approval?.inputJson ?: "{}"
        val inputEl = runCatching { json.parseToJsonElement(inputJson) }.getOrNull()
            ?: kotlinx.serialization.json.JsonObject(emptyMap())
        sendWs(buildJsonObject {
            put("type", "approve_tool")
            put("sessionId", sessionId)
            put("requestId", requestId)
            put("modifiedInput", inputEl)
        })
    }

    /** Client-side "always allow <tool>" set (session-scoped, like the SPA). */
    private val autoApproveTools = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    fun approveAlways(sessionId: String, requestId: String, toolName: String) {
        autoApproveTools.add(toolName)
        approve(sessionId, requestId)
    }

    /** Interrupt the session's running turn (Esc / stop button). */
    fun interrupt(sessionId: String) {
        sendWs(buildJsonObject {
            put("type", "interrupt")
            put("sessionId", sessionId)
        })
    }

    fun deny(sessionId: String, requestId: String, reason: String? = null) {
        sendWs(buildJsonObject {
            put("type", "deny_tool")
            put("sessionId", sessionId)
            put("requestId", requestId)
            reason?.let { put("reason", it) }
        })
    }

    fun markRead(sessionId: String) {
        sendWs(buildJsonObject {
            put("type", "mark_session_read")
            put("sessionId", sessionId)
        })
        // The @amar attention marker is sticky hub-side until explicitly
        // cleared — without this, other clients keep the red badge forever.
        sendWs(buildJsonObject {
            put("type", "clear_attention")
            put("sessionId", sessionId)
        })
        scope.launch {
            db.agents().byId(sessionId)?.let {
                db.agents().upsertSessions(listOf(it.copy(hasUnread = false, needsAttention = false)))
            }
        }
    }

    private fun sendWs(obj: JsonObject): Boolean = ws?.send(obj.toString()) ?: false

    fun registerOutboxHandlers() {
        outbox.register(TYPE_SEND) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val sent = sendWs(buildJsonObject {
                put("type", "send_message")
                put("sessionId", p["sessionId"]!!.jsonPrimitive.content)
                put("content", p["content"]!!.jsonPrimitive.content)
                put("dedupeKey", row.dedupeToken)
            })
            if (sent && _connected.value) Outbox.Result.Done
            else Outbox.Result.Retry("agents ws disconnected")
        }
    }

    suspend fun prune() {
        for (sessionId in db.agents().sessionsWithMessages()) {
            db.agents().pruneSession(sessionId, SESSION_CACHE_LIMIT)
        }
    }
}
