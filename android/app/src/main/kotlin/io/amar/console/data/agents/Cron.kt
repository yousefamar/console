package io.amar.console.data.agents

import io.amar.console.core.HubClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Hub-side cron mirror — the port of src/store/cron.ts. Polls GET /cron on
 * demand (when a panel is open); mutations re-fetch. No WS sync in v1.
 * A single [HubClient] must be handed in once via [attach] (from the Agents
 * screen mount) since this object lives outside AppGraph.
 */
object Cron {
    private val json = Json { ignoreUnknownKeys = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var hub: HubClient? = null

    data class Task(
        val id: String,
        val claudeSessionId: String,
        val trigger: String,
        val recurring: Boolean,
        val prompt: String,
        val guard: String?,
        val lastFiredAt: Long?,
        val lastGuardResult: String?,
        val lastSkipReason: String?,
        val consecutiveSkips: Int,
        val disabledAt: Long?,
    )

    private val _tasksBySession = MutableStateFlow<Map<String, List<Task>>>(emptyMap())
    val tasksBySession: StateFlow<Map<String, List<Task>>> = _tasksBySession
    private val _icsUrl = MutableStateFlow<String?>(null)
    val icsUrl: StateFlow<String?> = _icsUrl
    private val _icsPublic = MutableStateFlow(true)
    val icsPublic: StateFlow<Boolean> = _icsPublic

    fun attach(client: HubClient) { hub = client }

    /** Live flow of tasks for one claudeSessionId (empty when null). */
    fun tasksFor(claudeSessionId: String?): kotlinx.coroutines.flow.Flow<List<Task>> =
        _tasksBySession.map { if (claudeSessionId == null) emptyList() else it[claudeSessionId] ?: emptyList() }

    private fun taskFrom(o: JsonObject) = Task(
        id = o["id"]!!.jsonPrimitive.content,
        claudeSessionId = o["claudeSessionId"]?.jsonPrimitive?.content ?: "",
        trigger = o["trigger"]?.jsonPrimitive?.content ?: "",
        recurring = o["recurring"]?.jsonPrimitive?.booleanOrNull ?: true,
        prompt = o["prompt"]?.jsonPrimitive?.content ?: "",
        guard = o["guard"]?.jsonPrimitive?.content,
        lastFiredAt = o["lastFiredAt"]?.jsonPrimitive?.longOrNull,
        lastGuardResult = o["lastGuardResult"]?.jsonPrimitive?.content,
        lastSkipReason = o["lastSkipReason"]?.jsonPrimitive?.content,
        consecutiveSkips = o["consecutiveSkips"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        disabledAt = o["disabledAt"]?.jsonPrimitive?.longOrNull,
    )

    fun refresh(claudeSessionId: String) {
        val client = hub ?: return
        scope.launch {
            runCatching {
                val body = client.get("/cron?session=${java.net.URLEncoder.encode(claudeSessionId, "UTF-8")}")
                val arr = json.parseToJsonElement(body).jsonArray.mapNotNull { runCatching { taskFrom(it.jsonObject) }.getOrNull() }
                _tasksBySession.value = _tasksBySession.value + (claudeSessionId to arr)
            }
        }
    }

    /** Refresh every session's cron tasks (Agents-tab 30s poll parity). */
    fun refreshAll() {
        val client = hub ?: return
        scope.launch {
            runCatching {
                val body = client.get("/cron")
                val all = json.parseToJsonElement(body).jsonArray.mapNotNull { runCatching { taskFrom(it.jsonObject) }.getOrNull() }
                _tasksBySession.value = all.groupBy { it.claudeSessionId }
            }
        }
    }

    suspend fun add(claudeSessionId: String, trigger: String, prompt: String, recurring: Boolean): String? {
        val client = hub ?: return "not connected"
        return runCatching {
            client.post("/cron", buildJsonObject {
                put("claudeSessionId", claudeSessionId); put("trigger", trigger); put("prompt", prompt); put("recurring", recurring)
            }.toString())
            refresh(claudeSessionId)
            null
        }.getOrElse { e -> (e as? HubClient.HttpException)?.let { extractError(it.body) } ?: e.message }
    }

    fun remove(id: String, claudeSessionId: String) {
        val client = hub ?: return
        scope.launch { runCatching { client.delete("/cron/${java.net.URLEncoder.encode(id, "UTF-8")}") }; refresh(claudeSessionId) }
    }

    suspend fun runOnce(id: String): Pair<Boolean, String?> {
        val client = hub ?: return false to "not connected"
        return runCatching {
            val body = client.post("/cron/${java.net.URLEncoder.encode(id, "UTF-8")}/run")
            val o = json.parseToJsonElement(body).jsonObject
            (o["ok"]?.jsonPrimitive?.booleanOrNull ?: false) to o["reason"]?.jsonPrimitive?.content
        }.getOrElse { false to it.message }
    }

    fun fetchIcsToken() {
        val client = hub ?: return
        scope.launch {
            runCatching {
                val o = json.parseToJsonElement(client.get("/cron/ics-token")).jsonObject
                val public = o["publicUrl"]?.jsonPrimitive?.content
                if (public != null) { _icsUrl.value = public; _icsPublic.value = true }
                else {
                    val token = o["token"]?.jsonPrimitive?.content
                    _icsUrl.value = token?.let { "${io.amar.console.core.HubConfig.publicOrigin}/public/cron.ics?token=$it" }
                    _icsPublic.value = false
                }
            }
        }
    }

    private fun extractError(body: String): String? = runCatching {
        json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.content
    }.getOrNull() ?: body.take(120)
}
