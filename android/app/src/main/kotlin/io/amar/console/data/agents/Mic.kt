package io.amar.console.data.agents

import io.amar.console.HubTokenStore
import io.amar.console.core.HubConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Push-to-talk mic ownership, mirrored from the hub SyncBus `mic` service —
 * the mobile port of src/store/mic.ts. `owner` is a hub session id (default
 * owner = Al); `hot` = the owner is actively recording; the `compose` event
 * (transient, not replayed) drops a finished PTT utterance into the owner's
 * composer UNSENT (vs /mic/say which auto-sends) — surfaced via [composeSeq].
 *
 * Runs its own minimal `/sync` WS subscribed to just the `mic` service. (Ideally
 * this would share AppGraph's SyncBusClient — see the wave report's
 * sharedFileNeeds — but that needs an AppGraph wiring change we don't own.)
 */
object Mic {
    private val json = Json { ignoreUnknownKeys = true }

    private val _owner = MutableStateFlow<String?>(null)
    val owner: StateFlow<String?> = _owner
    private val _ownerName = MutableStateFlow<String?>(null)
    val ownerName: StateFlow<String?> = _ownerName
    private val _hot = MutableStateFlow(false)
    val hot: StateFlow<Boolean> = _hot

    // PTT compose: transcript to drop into the owner's composer for review.
    data class Compose(val owner: String?, val text: String, val seq: Long)
    private val _compose = MutableStateFlow(Compose(null, "", 0))
    val compose: StateFlow<Compose> = _compose
    private val seq = AtomicLong(0)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var ws: WebSocket? = null
    private var wantConnected = false
    private var reconnectJob: Job? = null
    private var heartbeatJob: Job? = null
    private val rpcId = AtomicLong(1)
    @Volatile private var lastInbound = 0L
    private val okHttp = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    /** Idempotent — subscribe to the mic service + fetch current owner. */
    fun init() {
        if (wantConnected) return
        wantConnected = true
        open()
    }

    private fun open() {
        if (!wantConnected) return
        val b = Request.Builder().url(HubConfig.syncWsUrl)
        HubTokenStore.get()?.let { b.header("Authorization", "Bearer $it") }
        ws = okHttp.newWebSocket(b.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                lastInbound = System.currentTimeMillis()
                webSocket.send(buildJsonObject { put("t", "sub"); put("service", "mic") }.toString())
                fetchStatus()
                startHeartbeat()
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                lastInbound = System.currentTimeMillis()
                runCatching { handle(text) }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { reconnect() }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { reconnect() }
        })
    }

    private fun reconnect() {
        if (!wantConnected) return
        heartbeatJob?.cancel()
        reconnectJob?.cancel()
        reconnectJob = scope.launch { delay(2000); if (wantConnected) open() }
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (wantConnected) {
                delay(15_000)
                if (System.currentTimeMillis() - lastInbound > 30_000) { ws?.cancel(); break }
                ws?.send(buildJsonObject { put("t", "ping") }.toString())
            }
        }
    }

    private fun handle(text: String) {
        val msg = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (msg["t"]?.jsonPrimitive?.content) {
            "evt" -> {
                if (msg["service"]?.jsonPrimitive?.content != "mic") return
                val data = msg["data"] as? JsonObject ?: return
                when (msg["op"]?.jsonPrimitive?.content) {
                    "state" -> applyState(data)
                    "compose" -> {
                        val t = data["text"]?.jsonPrimitive?.content ?: return
                        if (t.isEmpty()) return
                        _compose.value = Compose(data["owner"]?.jsonPrimitive?.content, t, seq.incrementAndGet())
                    }
                }
            }
            "rpc" -> {
                val result = msg["result"] as? JsonObject ?: return
                applyState(result)
            }
        }
    }

    private fun applyState(d: JsonObject) {
        _owner.value = d["owner"]?.jsonPrimitive?.content
        _ownerName.value = d["ownerName"]?.jsonPrimitive?.content
        _hot.value = d["hot"]?.jsonPrimitive?.content == "true"
    }

    private fun fetchStatus() {
        ws?.send(buildJsonObject {
            put("t", "rpc"); put("id", rpcId.getAndIncrement()); put("service", "mic"); put("op", "status")
            put("args", buildJsonObject {})
        }.toString())
    }

    /** Hand the mic to a target (session id / name / agentKey; 'al' resets to Al). */
    fun setMic(target: String) {
        ws?.send(buildJsonObject {
            put("t", "rpc"); put("id", rpcId.getAndIncrement()); put("service", "mic"); put("op", "set")
            put("args", buildJsonObject { put("target", target) })
        }.toString())
    }
}
