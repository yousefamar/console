package io.amar.console.sync

import io.amar.console.HubTokenStore
import io.amar.console.core.HubConfig
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * SyncBus WebSocket client — Kotlin port of the SPA's `src/sync-bus.ts`.
 *
 * Wire protocol (JSON):
 *   C→S: {t:'sub'|'unsub', service} | {t:'rpc', id, service, op, args} | {t:'ping'}
 *   S→C: {t:'hello'} | {t:'evt', service, op, data} | {t:'rpc', id, ok, result|error} | {t:'pong'}
 *
 * Semantics ported verbatim:
 *  - client-driven heartbeat: ping every 15s; any inbound refreshes
 *    lastInboundAt; >30s stale → force reconnect. (Designed for exactly the
 *    Android-backgrounding failure mode: timers pause, TCP dies while the
 *    socket still looks OPEN.)
 *  - exponential backoff 500ms → ×2 → cap 30s, reset on open.
 *  - on open: re-send `sub` for every subscribed service, fail pending RPCs
 *    (idempotency is the caller's responsibility — the outbox retries).
 *  - the hub buffers NOTHING for disconnected clients; every connect must be
 *    followed by a reconcile (SyncEngine wires onConnect handlers).
 */
class SyncBusClient(
    private val scope: CoroutineScope,
    private val okHttp: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // WS: no read timeout, heartbeat handles staleness
        .build(),
) {
    val json = Json { ignoreUnknownKeys = true }

    private val _connected = MutableStateFlow(false)
    val connectedFlow: StateFlow<Boolean> = _connected
    val connected: Boolean get() = _connected.value

    private var ws: WebSocket? = null
    private var wantConnected = false
    private var backoffMs = 500L
    private var reconnectJob: Job? = null
    private var heartbeatJob: Job? = null
    @Volatile private var lastInboundAt = 0L
    /** Bumped on every (re)connect attempt; stale sockets are ignored. */
    private val generation = AtomicLong(0)

    private val rpcId = AtomicLong(1)
    private val pendingRpcs = ConcurrentHashMap<Long, CompletableDeferred<JsonElement>>()

    // service -> handlers keyed by "op" or "*"
    private val handlers = ConcurrentHashMap<String, CopyOnWriteArrayList<Pair<String, (JsonElement) -> Unit>>>()
    private val onConnectHandlers = CopyOnWriteArrayList<(first: Boolean) -> Unit>()
    private var everConnected = false

    fun start() {
        if (wantConnected) return
        wantConnected = true
        openSocket()
    }

    fun stop() {
        wantConnected = false
        reconnectJob?.cancel()
        heartbeatJob?.cancel()
        ws?.close(1000, "client-stop")
        ws = null
        _connected.value = false
        failPendingRpcs("client stopped")
    }

    fun onConnect(handler: (first: Boolean) -> Unit): () -> Unit {
        onConnectHandlers.add(handler)
        return { onConnectHandlers.remove(handler) }
    }

    /** Subscribe to `service` events. `op` may be "*" for all ops. */
    fun on(service: String, op: String, handler: (JsonElement) -> Unit): () -> Unit {
        val list = handlers.getOrPut(service) { CopyOnWriteArrayList() }
        val wasEmpty = list.isEmpty()
        val entry = op to handler
        list.add(entry)
        if (wasEmpty && connected) send(buildJsonObject { put("t", "sub"); put("service", service) })
        return {
            list.remove(entry)
            if (list.isEmpty() && connected) {
                send(buildJsonObject { put("t", "unsub"); put("service", service) })
            }
        }
    }

    /** RPC to a hub-registered service op. Throws on error/timeout/disconnect. */
    suspend fun rpc(service: String, op: String, args: JsonElement = JsonNull, timeoutMs: Long = 30_000): JsonElement {
        val socket = ws ?: throw IllegalStateException("hub disconnected")
        if (!connected) throw IllegalStateException("hub disconnected")
        val id = rpcId.getAndIncrement()
        val deferred = CompletableDeferred<JsonElement>()
        pendingRpcs[id] = deferred
        val msg = buildJsonObject {
            put("t", "rpc")
            put("id", id)
            put("service", service)
            put("op", op)
            put("args", args)
        }
        if (!socket.send(msg.toString())) {
            pendingRpcs.remove(id)
            throw IllegalStateException("hub send failed")
        }
        return try {
            withTimeout(timeoutMs) { deferred.await() }
        } finally {
            pendingRpcs.remove(id)
        }
    }

    // ------------------------------------------------------------------ //

    private fun openSocket() {
        if (!wantConnected) return
        val gen = generation.incrementAndGet()
        val builder = Request.Builder().url(HubConfig.syncWsUrl)
        HubTokenStore.get()?.let { builder.header("Authorization", "Bearer $it") }
        ws = okHttp.newWebSocket(builder.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (gen != generation.get()) { webSocket.close(1000, "stale"); return }
                backoffMs = 500L
                lastInboundAt = System.currentTimeMillis()
                _connected.value = true
                // Re-subscribe every service with live handlers.
                for ((service, list) in handlers) {
                    if (list.isNotEmpty()) {
                        webSocket.send(buildJsonObject { put("t", "sub"); put("service", service) }.toString())
                    }
                }
                val first = !everConnected
                everConnected = true
                for (h in onConnectHandlers) runCatching { h(first) }
                startHeartbeat(gen)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (gen != generation.get()) return
                lastInboundAt = System.currentTimeMillis()
                handleMessage(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // Complete the close handshake (OkHttp's default does nothing,
                // leaving the socket half-closed and onClosed never firing).
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (gen != generation.get()) return
                handleDisconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (gen != generation.get()) return
                handleDisconnect()
            }
        })
    }

    private fun handleMessage(text: String) {
        val msg = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
        when (msg["t"]?.jsonPrimitive?.content) {
            "evt" -> {
                val service = msg["service"]?.jsonPrimitive?.content ?: return
                val op = msg["op"]?.jsonPrimitive?.content ?: return
                val data = msg["data"] ?: JsonNull
                val list = handlers[service] ?: return
                for ((hop, handler) in list) {
                    if (hop == op || hop == "*") runCatching { handler(data) }
                }
            }
            "rpc" -> {
                val id = msg["id"]?.jsonPrimitive?.content?.toLongOrNull() ?: return
                val deferred = pendingRpcs.remove(id) ?: return
                val ok = msg["ok"]?.jsonPrimitive?.content == "true"
                if (ok) {
                    deferred.complete(msg["result"] ?: JsonNull)
                } else {
                    val err = msg["error"]?.jsonPrimitive?.content ?: "rpc error"
                    deferred.completeExceptionally(RuntimeException(err))
                }
            }
            // "pong", "hello" — inbound traffic already refreshed lastInboundAt.
        }
    }

    private fun handleDisconnect() {
        _connected.value = false
        heartbeatJob?.cancel()
        failPendingRpcs("hub disconnected")
        if (!wantConnected) return
        val wait = backoffMs
        backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(wait)
            if (wantConnected) openSocket()
        }
    }

    private fun startHeartbeat(gen: Long) {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive && gen == generation.get()) {
                delay(15_000)
                if (!connected) break
                val now = System.currentTimeMillis()
                if (now - lastInboundAt > 30_000) {
                    // Half-dead socket (backgrounding, network flap). Kill it;
                    // onFailure path schedules the reconnect.
                    ws?.cancel()
                    break
                }
                send(buildJsonObject { put("t", "ping") })
            }
        }
    }

    private fun send(obj: JsonObject) {
        ws?.send(obj.toString())
    }

    private fun failPendingRpcs(reason: String) {
        val ids = pendingRpcs.keys.toList()
        for (id in ids) {
            pendingRpcs.remove(id)?.completeExceptionally(RuntimeException(reason))
        }
    }
}
