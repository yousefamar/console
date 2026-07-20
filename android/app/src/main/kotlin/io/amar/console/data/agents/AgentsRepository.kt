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
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
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
 * (not /sync). Connect burst = project_dirs, model_state, agents_list, tasks,
 * sessions_list, session_order, collapsed_groups, then last-50 replay per
 * session; we additionally page gaps via the REST endpoint
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
     *  (streaming, current tool, status line, thinking preview, tool-input
     *  being typed, active sub-agents). Transient; not persisted. */
    data class Activity(
        val running: Boolean = false,
        val currentTool: String? = null,
        val statusText: String? = null,
        val streamingText: String = "",
        /** Live thinking preview (thinking_delta accumulation). */
        val streamingThinking: String = "",
        /** Live tool-call arguments streaming in (tool_input_delta): the raw
         *  partial JSON of the current tool being typed. Cleared when the
         *  finalized tool_use lands or the turn ends. */
        val toolInputName: String? = null,
        val toolInputId: String? = null,
        val toolInputJson: String = "",
        /** Active sub-agents: toolUseId → description (tool_use w/o result). */
        val subagents: Map<String, String> = emptyMap(),
    )
    private val _activity = MutableStateFlow<Map<String, Activity>>(emptyMap())
    val activity: StateFlow<Map<String, Activity>> = _activity
    private fun setActivity(sessionId: String, fn: (Activity) -> Activity) {
        _activity.value = _activity.value + (sessionId to fn(_activity.value[sessionId] ?: Activity()))
    }

    // --- Org-chart roles + delegation tasks + fleet model state (transient) ---
    private val _roles = MutableStateFlow<List<AgentRole>>(emptyList())
    val roles: StateFlow<List<AgentRole>> = _roles
    private val _tasks = MutableStateFlow<List<AgentTask>>(emptyList())
    val tasks: StateFlow<List<AgentTask>> = _tasks
    private val _modelState = MutableStateFlow(ModelState())
    val modelState: StateFlow<ModelState> = _modelState
    private val _pastSessions = MutableStateFlow<List<PastSession>>(emptyList())
    val pastSessions: StateFlow<List<PastSession>> = _pastSessions
    private val _projectDirs = MutableStateFlow<List<String>>(emptyList())
    val projectDirs: StateFlow<List<String>> = _projectDirs
    private val _slashCommands = MutableStateFlow<List<String>>(emptyList())
    val slashCommands: StateFlow<List<String>> = _slashCommands
    private val _handoff = MutableStateFlow<Handoff?>(null)
    val handoff: StateFlow<Handoff?> = _handoff
    private val _fallbackNotice = MutableStateFlow<FallbackNotice?>(null)
    val fallbackNotice: StateFlow<FallbackNotice?> = _fallbackNotice
    private val _generatingTitles = MutableStateFlow<Set<String>>(emptySet())
    val generatingTitles: StateFlow<Set<String>> = _generatingTitles

    data class AgentRole(
        val key: String,
        val title: String,
        val manager: String?,
        val goals: List<String>,
        val cwd: String?,
        val charter: String,
        val folder: Boolean,
        val fork: Boolean,
    )

    data class AgentTask(
        val id: String,
        val title: String,
        val brief: String,
        val fromKey: String,
        val toKey: String,
        val origin: String,
        val chain: List<String>,
        val status: String,
        val result: String?,
        val updatedAt: Long,
    )

    data class ModelState(
        val model: String = "",
        val chain: List<String> = emptyList(),
        val lockedByEnv: Boolean = false,
        val backend: String? = null,
    )

    data class PastSession(val sessionId: String, val prompt: String, val date: Long)
    data class Handoff(val fromSessionId: String, val targetAgentKey: String)
    data class FallbackNotice(val failedModel: String, val model: String)

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

    /** WS messages are handled on a single-consumer channel: OkHttp delivers
     *  onMessage in order, but fanning each one out via scope.launch on the
     *  multi-threaded Default dispatcher let text_delta chunks (and the final
     *  text swap) race — the cause of visibly mangled streamed replies. */
    private val inbound = kotlinx.coroutines.channels.Channel<String>(capacity = kotlinx.coroutines.channels.Channel.UNLIMITED)
    private val inboundJob = scope.launch {
        for (text in inbound) runCatching { handleHubMessage(text) }
    }

    private var ws: WebSocket? = null
    private var wantConnected = false
    private var reconnectJob: Job? = null
    private var pollJob: Job? = null
    private val okHttp = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    fun observeSessions(): Flow<List<AgentSessionRow>> = db.agents().observeSessions()
    fun observeMessages(sessionId: String, limit: Int = 300): Flow<List<AgentMessageRow>> =
        db.agents().observeRecent(sessionId, limit)

    /**
     * Live (non-ended) sessions whose cwd sits under a given vault subpath —
     * powers Notes' "Jump to agent" / "Start agent in <project>" (FEATURES
     * notes #9/#10/#119/#120). Additive projection over the existing session
     * stream; matches when the session cwd equals or contains [pathFragment]
     * (e.g. "/projects/<slug>"). */
    fun observeSessionsUnderCwd(pathFragment: String): Flow<List<AgentSessionRow>> =
        db.agents().observeSessions().map { rows ->
            rows.filter { it.status != "ended" && (it.cwd?.contains(pathFragment) == true) }
        }

    /** sessionId → latest text/user_prompt snippet (100 chars) for the sidebar. */
    fun observeLastSnippets(): Flow<Map<String, String>> =
        db.agents().observeLastSnippets().map { rows ->
            rows.associate { r ->
                val content = runCatching {
                    json.parseToJsonElement(r.payloadJson).jsonObject["content"]?.jsonPrimitive?.content
                }.getOrNull() ?: ""
                r.sessionId to content.replace('\n', ' ').take(100)
            }
        }

    // ---------------------------------------------------------------- //
    // WS lifecycle (foreground-gated by SyncEngine-style start/stop)

    fun start() {
        if (wantConnected) return
        wantConnected = true
        open()
        // Keep backgroundProcessCount fresh (the hub only recomputes on getInfo).
        pollJob?.cancel()
        pollJob = scope.launch {
            while (wantConnected) {
                delay(10_000)
                if (_connected.value) sendWs(buildJsonObject { put("type", "list_sessions") })
            }
        }
    }

    fun stop() {
        wantConnected = false
        reconnectJob?.cancel()
        pollJob?.cancel()
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
                inbound.trySend(text)
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
                // Detect hub-restart ID remaps via matching claudeSessionId (a
                // restarted hub mints new hub ids; without remapping the open
                // transcript would look like a brand-new session).
                val existing = db.agents().allSessions()
                val claudeToOldId = existing.mapNotNull { r -> r.claudeSessionId?.let { it to r.id } }.toMap()
                val idRemap = mutableMapOf<String, String>()
                for (s in sessions) {
                    val csid = s["claudeSessionId"]?.jsonPrimitive?.content ?: continue
                    val id = s["id"]?.jsonPrimitive?.content ?: continue
                    val oldId = claudeToOldId[csid]
                    if (oldId != null && oldId != id) idRemap[oldId] = id
                }
                for ((oldId, newId) in idRemap) remapSession(oldId, newId)

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
            "project_dirs" -> {
                _projectDirs.value = (msg["dirs"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.content } ?: emptyList()
            }
            "model_state" -> {
                val chain = (msg["chain"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.content } ?: emptyList()
                _modelState.value = ModelState(
                    model = msg["model"]?.jsonPrimitive?.content ?: "",
                    chain = chain,
                    lockedByEnv = msg["lockedByEnv"]?.jsonPrimitive?.booleanOrNull ?: false,
                    backend = msg["backend"]?.jsonPrimitive?.content,
                )
                if (msg["autoFellBack"]?.jsonPrimitive?.booleanOrNull == true) {
                    _fallbackNotice.value = FallbackNotice(
                        failedModel = msg["failedModel"]?.jsonPrimitive?.content ?: "?",
                        model = msg["model"]?.jsonPrimitive?.content ?: "?",
                    )
                }
            }
            "agents_list" -> {
                _roles.value = (msg["roles"] as? JsonArray)?.mapNotNull { runCatching { roleFrom(it.jsonObject) }.getOrNull() } ?: emptyList()
            }
            "agent_role" -> {
                (msg["role"] as? JsonObject)?.let { r ->
                    val role = runCatching { roleFrom(r) }.getOrNull() ?: return@let
                    _roles.value = (_roles.value.filter { it.key != role.key } + role)
                }
            }
            "tasks" -> {
                _tasks.value = (msg["tasks"] as? JsonArray)?.mapNotNull { runCatching { taskFrom(it.jsonObject) }.getOrNull() } ?: emptyList()
            }
            "session_handoff" -> {
                _handoff.value = Handoff(
                    fromSessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return,
                    targetAgentKey = msg["targetAgentKey"]?.jsonPrimitive?.content ?: return,
                )
            }
            "past_sessions" -> {
                _pastSessions.value = (msg["sessions"] as? JsonArray)?.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    PastSession(
                        sessionId = o["sessionId"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                        prompt = o["prompt"]?.jsonPrimitive?.content ?: "",
                        date = o["date"]?.jsonPrimitive?.longOrNull ?: 0,
                    )
                } ?: emptyList()
            }
            "session_history" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                val history = (msg["messages"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: return
                // Full reload: replace the cached window from index 0.
                val rows = history.mapIndexed { i, m ->
                    AgentMessageRow(sessionId = sessionId, absIndex = i.toLong(), kind = m["type"]?.jsonPrimitive?.content ?: "unknown", payloadJson = m.toString())
                }
                db.agents().clearMessages(sessionId)
                if (rows.isNotEmpty()) db.agents().insertMessages(rows)
            }
            // Live streaming: the hub sends text as `text_delta` chunks (the
            // coalesced `text` only lands in its log for replay/REST).
            "text_delta" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                if (sessionId !in caughtUp) return
                val chunk = msg["content"]?.jsonPrimitive?.content ?: return
                val sb = pendingText.getOrPut(sessionId) { StringBuilder() }.append(chunk)
                setActivity(sessionId) { it.copy(running = true, streamingText = sb.toString().takeLast(4000)) }
                upsertPendingTextRow(sessionId)
            }
            "thinking_delta" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                val chunk = msg["content"]?.jsonPrimitive?.content ?: return
                setActivity(sessionId) { it.copy(running = true, streamingThinking = (it.streamingThinking + chunk).takeLast(2000)) }
            }
            "tool_input_delta" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                val toolUseId = msg["toolUseId"]?.jsonPrimitive?.content ?: return
                val toolName = msg["toolName"]?.jsonPrimitive?.content ?: ""
                val chunk = msg["content"]?.jsonPrimitive?.content ?: return
                setActivity(sessionId) {
                    // A new toolUseId resets the accumulator — without this,
                    // consecutive edits concatenate into garbled previews.
                    val prior = if (it.toolInputId == toolUseId) it.toolInputJson else ""
                    it.copy(running = true, toolInputId = toolUseId, toolInputName = toolName, toolInputJson = (prior + chunk).takeLast(4000))
                }
            }
            // Loggable stream messages — persist at the next absolute index.
            "text", "user_prompt", "tool_use", "tool_result", "thinking", "result",
            "tool_diff", "bg_task", "session_ended", "session_init", "session_created" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                val kind = msg["type"]?.jsonPrimitive?.content
                if (kind == "session_created") { setActivity(sessionId) { it.copy(running = true) }; return }
                if (kind == "session_init") {
                    val slash = (msg["slashCommands"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.content } ?: emptyList()
                    if (slash.isNotEmpty()) _slashCommands.value = slash
                    // Persist claudeSessionId + permissionMode + model onto the row.
                    db.agents().byId(sessionId)?.let { r ->
                        db.agents().upsertSessions(listOf(r.copy(
                            claudeSessionId = msg["claudeSessionId"]?.jsonPrimitive?.content ?: r.claudeSessionId,
                            permissionMode = msg["permissionMode"]?.jsonPrimitive?.content ?: r.permissionMode,
                            modelLabel = msg["model"]?.jsonPrimitive?.content ?: r.modelLabel,
                        )))
                    }
                    setActivity(sessionId) { it.copy(statusText = null) }
                    return
                }
                if (sessionId !in caughtUp) return
                when (kind) {
                    "text" -> {
                        pendingText.remove(sessionId)
                        replacePendingTextRow(sessionId, msg)
                        setActivity(sessionId) { it.copy(streamingText = "", streamingThinking = "") }
                        return
                    }
                    "tool_use" -> {
                        val toolName = msg["toolName"]?.jsonPrimitive?.content
                        val toolUseId = msg["toolUseId"]?.jsonPrimitive?.content ?: ""
                        setActivity(sessionId) {
                            var next = it.copy(running = true, currentTool = toolName, toolInputName = null, toolInputJson = "")
                            if (toolName == "Agent") {
                                val input = msg["input"] as? JsonObject
                                val desc = input?.get("description")?.jsonPrimitive?.content
                                    ?: input?.get("prompt")?.jsonPrimitive?.content?.take(40) ?: "Sub-agent"
                                next = next.copy(subagents = next.subagents + (toolUseId to desc))
                            }
                            next
                        }
                        // Track permission mode from plan tools.
                        if (toolName == "EnterPlanMode") persistPermissionMode(sessionId, "plan")
                        else if (toolName == "ExitPlanMode") persistPermissionMode(sessionId, "default")
                    }
                    "tool_result" -> {
                        val toolUseId = msg["toolUseId"]?.jsonPrimitive?.content ?: ""
                        setActivity(sessionId) { it.copy(currentTool = null, subagents = it.subagents - toolUseId) }
                    }
                    "user_prompt" -> setActivity(sessionId) { it.copy(running = true) }
                    "result" -> {
                        setActivity(sessionId) { Activity(running = false) }
                        msg["cost"]?.jsonPrimitive?.doubleOrNull?.let { cost ->
                            db.agents().byId(sessionId)?.let { r ->
                                db.agents().upsertSessions(listOf(r.copy(totalCostMicros = (cost * 1_000_000).toLong())))
                            }
                        }
                    }
                    "session_ended" -> {
                        db.agents().byId(sessionId)?.let { db.agents().upsertSessions(listOf(it.copy(status = "ended"))) }
                        _approvals.value = _approvals.value.filter { it.sessionId != sessionId }
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
                val txt = msg["text"]?.jsonPrimitive?.content ?: ""
                setActivity(sessionId) { it.copy(statusText = txt) }
            }
            "error" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                appendMessage(sessionId, msg)
                setActivity(sessionId) { it.copy(running = false, currentTool = null, statusText = null) }
            }
            "context_update" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                val used = msg["used"]?.jsonPrimitive?.longOrNull ?: return
                val total = msg["total"]?.jsonPrimitive?.longOrNull ?: return
                val breakdown = (msg["breakdown"] as? JsonArray)?.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    ContextCategory(o["name"]?.jsonPrimitive?.content ?: "", o["tokens"]?.jsonPrimitive?.longOrNull ?: 0)
                } ?: emptyList()
                _contextUsage.value = _contextUsage.value + (sessionId to ContextUsage(used, total, breakdown))
            }
            "session_read_state" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                val lastRead = msg["lastReadIndex"]?.jsonPrimitive?.longOrNull ?: return
                val len = msg["messageLogLength"]?.jsonPrimitive?.longOrNull ?: return
                db.agents().byId(sessionId)?.let {
                    val newLen = maxOf(it.messageLogLength, len)
                    db.agents().upsertSessions(listOf(it.copy(hasUnread = newLen > lastRead, messageLogLength = newLen, lastReadIndex = lastRead)))
                }
            }
            "session_attention" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                val att = msg["needsAttention"] as? JsonObject
                db.agents().byId(sessionId)?.let {
                    db.agents().upsertSessions(listOf(it.copy(
                        needsAttention = att != null,
                        attentionSnippet = att?.get("snippet")?.jsonPrimitive?.content,
                    )))
                }
            }
            "session_renamed" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                val name = msg["name"]?.jsonPrimitive?.content ?: return
                db.agents().byId(sessionId)?.let { db.agents().upsertSessions(listOf(it.copy(name = name))) }
                _generatingTitles.value = _generatingTitles.value - sessionId
            }
            "older_messages" -> {
                val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return
                val older = (msg["messages"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: return
                val oldest = db.agents().minIndex(sessionId) ?: 0
                // Prepend: assign indices below the current oldest.
                val rows = older.mapIndexed { i, m ->
                    AgentMessageRow(sessionId = sessionId, absIndex = oldest - older.size + i, kind = m["type"]?.jsonPrimitive?.content ?: "unknown", payloadJson = m.toString())
                }.filter { it.absIndex < oldest }
                if (rows.isNotEmpty()) db.agents().insertMessages(rows)
            }
            "session_order" -> {
                _sessionOrder.value = (msg["order"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.content } ?: emptyList()
            }
            "collapsed_groups" -> {
                _collapsedGroups.value = ((msg["collapsed"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.content } ?: emptyList()).toSet()
            }
            "session_merged" -> { /* sessions_list drops the fork; nothing local to do */ }
        }
    }

    private suspend fun persistPermissionMode(sessionId: String, mode: String) {
        db.agents().byId(sessionId)?.let { db.agents().upsertSessions(listOf(it.copy(permissionMode = mode))) }
    }

    private suspend fun remapSession(oldId: String, newId: String) {
        db.agents().remapMessages(oldId, newId)
        _activity.value[oldId]?.let { setActivity(newId) { _ -> it } }
        _activity.value = _activity.value - oldId
    }

    private fun roleFrom(o: JsonObject) = AgentRole(
        key = o["key"]!!.jsonPrimitive.content,
        title = o["title"]?.jsonPrimitive?.content ?: o["key"]!!.jsonPrimitive.content,
        manager = o["manager"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content },
        goals = (o["goals"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.content } ?: emptyList(),
        cwd = o["cwd"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content },
        charter = o["charter"]?.jsonPrimitive?.content ?: "",
        folder = o["folder"]?.jsonPrimitive?.booleanOrNull ?: false,
        fork = o["fork"]?.jsonPrimitive?.booleanOrNull ?: false,
    )

    private fun taskFrom(o: JsonObject) = AgentTask(
        id = o["id"]!!.jsonPrimitive.content,
        title = o["title"]?.jsonPrimitive?.content ?: "",
        brief = o["brief"]?.jsonPrimitive?.content ?: "",
        fromKey = o["fromKey"]?.jsonPrimitive?.content ?: "",
        toKey = o["toKey"]?.jsonPrimitive?.content ?: "",
        origin = o["origin"]?.jsonPrimitive?.content ?: "agent",
        chain = (o["chain"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.content } ?: emptyList(),
        status = o["status"]?.jsonPrimitive?.content ?: "pending",
        result = o["result"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content },
        updatedAt = o["updatedAt"]?.jsonPrimitive?.longOrNull ?: 0,
    )

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
        val git = s["gitStats"] as? JsonObject
        val cost = s["totalCost"]?.jsonPrimitive?.doubleOrNull ?: 0.0
        return AgentSessionRow(
            id = id,
            name = s["name"]?.jsonPrimitive?.content ?: id,
            status = s["status"]?.jsonPrimitive?.content ?: "idle",
            hasUnread = logLen > lastRead,
            needsAttention = s["needsAttention"] != null && s["needsAttention"] !is JsonNull,
            attentionSnippet = (s["needsAttention"] as? JsonObject)?.get("snippet")?.jsonPrimitive?.content,
            agentKey = s["agentKey"]?.jsonPrimitive?.content,
            modelLabel = s["model"]?.jsonPrimitive?.content,
            hibernated = s["hibernated"]?.jsonPrimitive?.booleanOrNull ?: false,
            cwd = s["cwd"]?.jsonPrimitive?.content,
            lastCachedIndex = -1L, // filled after catch-up
            messageLogLength = logLen,
            lastReadIndex = lastRead,
            parentClaudeSessionId = s["parentClaudeSessionId"]?.jsonPrimitive?.content,
            claudeSessionId = s["claudeSessionId"]?.jsonPrimitive?.content,
            modelOverride = s["modelOverride"]?.jsonPrimitive?.content,
            permissionMode = null, // set on session_init; keep null in list rows
            gitBranch = s["gitBranch"]?.jsonPrimitive?.content,
            gitDirty = s["gitDirty"]?.jsonPrimitive?.booleanOrNull ?: false,
            gitAdded = git?.get("added")?.jsonPrimitive?.intOrNull ?: -1,
            gitDeleted = git?.get("deleted")?.jsonPrimitive?.intOrNull ?: -1,
            backgroundProcessCount = s["backgroundProcessCount"]?.jsonPrimitive?.intOrNull ?: 0,
            createdAt = s["createdAt"]?.jsonPrimitive?.longOrNull ?: 0,
            isAl = id == "al",
            totalCostMicros = (cost * 1_000_000).toLong(),
        )
    }

    // ---------------------------------------------------------------- //
    // Mutations

    suspend fun sendPrompt(
        sessionId: String,
        content: String,
        imageUris: List<android.net.Uri> = emptyList(),
        context: android.content.Context? = null,
    ) {
        // /clear wipes the session's chat UI locally (no user_prompt bubble).
        if (content.trim() == "/clear") {
            sendWs(buildJsonObject { put("type", "send_message"); put("sessionId", sessionId); put("content", content) })
            db.agents().clearMessages(sessionId)
            pendingText.remove(sessionId)
            pendingRowIndex.remove(sessionId)
            return
        }
        val imagePaths = mutableListOf<String>()
        if (context != null) {
            val spool = java.io.File(context.filesDir, "outbox-media").apply { mkdirs() }
            for (uri in imageUris) {
                val mime = context.contentResolver.getType(uri) ?: continue
                if (!mime.startsWith("image/")) continue
                val f = java.io.File(spool, "agent-${System.currentTimeMillis()}-${imagePaths.size}.img")
                context.contentResolver.openInputStream(uri)?.use { input ->
                    f.outputStream().use { input.copyTo(it) }
                } ?: continue
                imagePaths.add(f.absolutePath + "|" + mime)
            }
        }
        val payload = buildJsonObject {
            put("sessionId", sessionId)
            put("content", content)
            if (imagePaths.isNotEmpty()) {
                put("imagePaths", JsonArray(imagePaths.map { JsonPrimitive(it) }))
            }
        }
        // Optimistic local user_prompt row so the transcript shows it now.
        appendMessage(sessionId, buildJsonObject {
            put("type", "user_prompt")
            put("sessionId", sessionId)
            put("content", content)
        })
        outbox.enqueue(TYPE_SEND, payload.toString(), entityId = sessionId)
    }

    fun approve(sessionId: String, requestId: String, modifiedInputJson: String? = null) {
        val approval = _approvals.value.firstOrNull { it.requestId == requestId }
        val inputJson = modifiedInputJson ?: approval?.inputJson ?: "{}"
        val inputEl = runCatching { json.parseToJsonElement(inputJson) }.getOrNull() ?: JsonObject(emptyMap())
        sendWs(buildJsonObject {
            put("type", "approve_tool")
            put("sessionId", sessionId)
            put("requestId", requestId)
            put("modifiedInput", inputEl)
        })
        _approvals.value = _approvals.value.filter { it.requestId != requestId }
    }

    data class ContextCategory(val name: String, val tokens: Long)
    data class ContextUsage(val totalTokens: Long, val maxTokens: Long, val breakdown: List<ContextCategory> = emptyList())
    private val _contextUsage = MutableStateFlow<Map<String, ContextUsage>>(emptyMap())
    val contextUsage: StateFlow<Map<String, ContextUsage>> = _contextUsage

    fun createSession(prompt: String, cwd: String, name: String? = null) {
        sendWs(buildJsonObject {
            put("type", "create_session")
            put("prompt", prompt)
            put("cwd", cwd)
            name?.let { put("name", it) }
        })
    }

    /** Resume a past Claude session (sessionId is a claudeSessionId). */
    fun resumeSession(claudeSessionId: String, prompt: String, cwd: String? = null) {
        sendWs(buildJsonObject {
            put("type", "resume_session")
            put("sessionId", claudeSessionId)
            put("prompt", prompt)
            cwd?.let { put("cwd", it) }
        })
    }

    fun listPastSessions(cwd: String) {
        _pastSessions.value = emptyList()
        sendWs(buildJsonObject { put("type", "list_past_sessions"); put("cwd", cwd) })
    }

    fun killSession(sessionId: String) {
        sendWs(buildJsonObject { put("type", "kill_session"); put("sessionId", sessionId) })
    }

    fun renameSession(sessionId: String, name: String) {
        sendWs(buildJsonObject {
            put("type", "rename_session")
            put("sessionId", sessionId)
            put("name", name)
        })
        scope.launch {
            db.agents().byId(sessionId)?.let { db.agents().upsertSessions(listOf(it.copy(name = name))) }
        }
    }

    fun generateTitle(sessionId: String) {
        sendWs(buildJsonObject { put("type", "generate_title"); put("sessionId", sessionId) })
        _generatingTitles.value = _generatingTitles.value + sessionId
    }

    fun reloadSession(sessionId: String) {
        sendWs(buildJsonObject { put("type", "reload_session"); put("sessionId", sessionId) })
    }

    fun reloadSessionHistory(sessionId: String) {
        scope.launch { db.agents().clearMessages(sessionId) }
        pendingText.remove(sessionId)
        pendingRowIndex.remove(sessionId)
        sendWs(buildJsonObject { put("type", "get_session_history"); put("sessionId", sessionId) })
    }

    fun forkSession(sessionId: String, cwd: String? = null) {
        sendWs(buildJsonObject {
            put("type", "fork_session")
            put("sessionId", sessionId)
            put("seed", true)
            put("seedRole", true)
            cwd?.let { put("cwd", it) }
        })
    }

    fun mergeSession(sessionId: String) {
        sendWs(buildJsonObject { put("type", "merge_session"); put("sessionId", sessionId) })
    }

    fun markUnread(sessionId: String) {
        sendWs(buildJsonObject { put("type", "mark_session_unread"); put("sessionId", sessionId) })
        scope.launch {
            db.agents().byId(sessionId)?.let {
                val len = it.messageLogLength
                db.agents().upsertSessions(listOf(it.copy(hasUnread = len > 0, lastReadIndex = maxOf(0, len - 1))))
            }
        }
    }

    /** Request older transcript history over the WS (pagination on scroll-up). */
    fun loadOlder(sessionId: String) {
        scope.launch {
            val oldest = db.agents().minIndex(sessionId) ?: return@launch
            if (oldest <= 0) return@launch
            sendWs(buildJsonObject {
                put("type", "get_older_messages")
                put("sessionId", sessionId)
                put("beforeIndex", oldest)
                put("limit", 100)
            })
        }
    }

    /** Whether more history exists before the oldest cached message. */
    suspend fun hasOlder(sessionId: String): Boolean {
        val oldest = db.agents().minIndex(sessionId) ?: return false
        return oldest > 0
    }

    private val autoApproveTools = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    fun approveAlways(sessionId: String, requestId: String, toolName: String) {
        autoApproveTools.add(toolName)
        approve(sessionId, requestId)
    }

    fun interrupt(sessionId: String) {
        sendWs(buildJsonObject { put("type", "interrupt"); put("sessionId", sessionId) })
    }

    fun deny(sessionId: String, requestId: String, reason: String? = null) {
        sendWs(buildJsonObject {
            put("type", "deny_tool")
            put("sessionId", sessionId)
            put("requestId", requestId)
            reason?.let { put("reason", it) }
        })
        _approvals.value = _approvals.value.filter { it.requestId != requestId }
    }

    fun markRead(sessionId: String) {
        scope.launch {
            val sess = db.agents().byId(sessionId)
            // Reading an ENDED session acknowledges + removes it (delete_session).
            if (sess != null && sess.status == "ended") {
                db.agents().deleteSession(sessionId)
                sendWs(buildJsonObject { put("type", "delete_session"); put("sessionId", sessionId) })
                return@launch
            }
            sendWs(buildJsonObject { put("type", "mark_session_read"); put("sessionId", sessionId) })
            sendWs(buildJsonObject { put("type", "clear_attention"); put("sessionId", sessionId) })
            sess?.let {
                db.agents().upsertSessions(listOf(it.copy(hasUnread = false, needsAttention = false, lastReadIndex = it.messageLogLength)))
            }
        }
    }

    // --- Model / backend / pin ---
    fun setAgentModel(model: String) = sendWs(buildJsonObject { put("type", "set_model"); put("model", model) })

    fun setSessionModel(sessionId: String, model: String?) = sendWs(buildJsonObject {
        put("type", "set_session_model"); put("sessionId", sessionId)
        if (model == null) put("model", JsonNull) else put("model", model)
    })

    suspend fun setAgentBackend(backend: String) {
        hub.post("/agents/backend", buildJsonObject { put("backend", backend) }.toString())
        _modelState.value = _modelState.value.copy(backend = backend)
    }

    fun dismissFallbackNotice() { _fallbackNotice.value = null }

    // --- Org chart / roles ---
    fun setManager(agentKey: String, manager: String?) = sendWs(buildJsonObject {
        put("type", "set_manager"); put("agentKey", agentKey)
        if (manager == null) put("manager", JsonNull) else put("manager", manager)
    })
    fun renameRole(agentKey: String, title: String) = sendWs(buildJsonObject { put("type", "rename_role"); put("agentKey", agentKey); put("title", title) })
    fun createFolder(title: String, manager: String? = null) = sendWs(buildJsonObject {
        put("type", "create_folder"); put("title", title)
        if (manager == null) put("manager", JsonNull) else put("manager", manager)
    })
    fun reviveAgent(agentKey: String) = sendWs(buildJsonObject { put("type", "revive_agent"); put("agentKey", agentKey) })
    fun deleteRole(agentKey: String) = sendWs(buildJsonObject { put("type", "delete_role"); put("agentKey", agentKey) })

    // --- Delegation ---
    fun delegate(toKey: String, brief: String, fromKey: String = "al") = sendWs(buildJsonObject {
        put("type", "delegate"); put("toKey", toKey); put("brief", brief); put("fromKey", fromKey)
    })
    fun cancelTask(taskId: String) {
        _tasks.value = _tasks.value.map { if (it.id == taskId) it.copy(status = "cancelled") else it }
        sendWs(buildJsonObject { put("type", "cancel_task"); put("taskId", taskId) })
    }

    // --- Handoff ---
    fun dismissHandoff() { _handoff.value = null }
    fun clearHandoff() { _handoff.value = null }

    // --- Sidebar ordering (cwd groups + drag reorder) ---
    private val _sessionOrder = MutableStateFlow<List<String>>(emptyList())
    val sessionOrder: StateFlow<List<String>> = _sessionOrder
    private val _collapsedGroups = MutableStateFlow<Set<String>>(emptySet())
    val collapsedGroups: StateFlow<Set<String>> = _collapsedGroups

    fun reorderSessions(order: List<String>) {
        _sessionOrder.value = order
        sendWs(buildJsonObject { put("type", "reorder_sessions"); put("order", JsonArray(order.map { JsonPrimitive(it) })) })
    }

    fun toggleGroupCollapsed(cwd: String) {
        val next = _collapsedGroups.value.toMutableSet()
        if (!next.add(cwd)) next.remove(cwd)
        _collapsedGroups.value = next
        sendWs(buildJsonObject { put("type", "set_collapsed_groups"); put("collapsed", JsonArray(next.map { JsonPrimitive(it) })) })
    }

    private fun sendWs(obj: JsonObject): Boolean = ws?.send(obj.toString()) ?: false

    fun registerOutboxHandlers() {
        // Cron store mirrors hub state over REST; hand it our HubClient once.
        Cron.attach(hub)
        outbox.register(TYPE_SEND) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val images = (p["imagePaths"] as? JsonArray)?.mapNotNull { el ->
                val spec = runCatching { el.jsonPrimitive.content }.getOrNull() ?: return@mapNotNull null
                val path = spec.substringBeforeLast('|')
                val mime = spec.substringAfterLast('|')
                val f = java.io.File(path)
                if (!f.exists()) return@mapNotNull null
                buildJsonObject {
                    put("media_type", mime)
                    put("data", android.util.Base64.encodeToString(f.readBytes(), android.util.Base64.NO_WRAP))
                }
            } ?: emptyList()
            val sent = sendWs(buildJsonObject {
                put("type", "send_message")
                put("sessionId", p["sessionId"]!!.jsonPrimitive.content)
                put("content", p["content"]!!.jsonPrimitive.content)
                put("dedupeKey", row.dedupeToken)
                if (images.isNotEmpty()) put("images", JsonArray(images))
            })
            if (sent && _connected.value) {
                (p["imagePaths"] as? JsonArray)?.forEach { el ->
                    runCatching { java.io.File(el.jsonPrimitive.content.substringBeforeLast('|')).delete() }
                }
                Outbox.Result.Done
            } else Outbox.Result.Retry("agents ws disconnected")
        }
    }

    suspend fun prune() {
        for (sessionId in db.agents().sessionsWithMessages()) {
            db.agents().pruneSession(sessionId, SESSION_CACHE_LIMIT)
        }
    }
}
