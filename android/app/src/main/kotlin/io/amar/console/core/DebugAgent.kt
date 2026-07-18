package io.amar.console.core

import android.app.Activity
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.PixelCopy
import io.amar.console.BuildConfig
import io.amar.console.HubTokenStore
import io.amar.console.data.db.ConsoleDb
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * Native debug agent — the RCE/observability channel for Claude to drive the
 * app remotely, mirroring the SPA's src/debug-agent.ts. Connects to the
 * hub's existing /debug WS with UA `ConsoleAPK-Native/<ver>` so the existing
 * routes target it: `curl /debug/eval?target=ConsoleAPK-Native -d '{"code":"…"}'`.
 *
 * "code" is a command DSL, not JS:
 *   route                    → current nav route
 *   nav <route>              → navigate (chat/<roomId>, mail, settings, …)
 *   back                     → pop back stack
 *   sql <query>              → raw SQL against console.db (SELECT only)
 *   state                    → app state summary (also debug_get_state)
 *   reconcile                → trigger a full sync reconcile
 *   drain                    → drain the outbox now
 *   help                     → command list
 *
 * `debug_screenshot` captures the live window via PixelCopy → PNG dataUrl —
 * exactly what's on screen, Compose and all.
 *
 * Event streaming: app-side logs/net/errors batch every 2s as debug_events
 * into the hub's shared NDJSON debug log (visible via GET /debug/log).
 */
object DebugAgent {
    private const val BATCH_MS = 2000L
    private const val MAX_QUEUE = 500

    private lateinit var scope: CoroutineScope
    private var db: ConsoleDb? = null
    private var ws: WebSocket? = null
    private var wantConnected = false
    private var reconnectJob: Job? = null
    private var batchJob: Job? = null
    private val events = ConcurrentLinkedQueue<JSONObject>()

    @Volatile private var currentActivity: WeakReference<Activity>? = null
    /** Registered by AppShell's composition: navigate / pop the real NavController. */
    @Volatile var navigate: ((String) -> Boolean)? = null
    @Volatile var goBack: (() -> Boolean)? = null
    /** Extra state contributors (AppGraph wires syncBus/outbox/etc. summaries). */
    @Volatile var stateProvider: (() -> JSONObject)? = null
    @Volatile var reconcileTrigger: (() -> Unit)? = null
    @Volatile var drainTrigger: (() -> Unit)? = null

    private val okHttp = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    fun start(appScope: CoroutineScope, database: ConsoleDb) {
        if (wantConnected) return
        scope = appScope
        db = database
        wantConnected = true
        open()
        batchJob = scope.launch {
            while (isActive) {
                delay(BATCH_MS)
                flushEvents()
            }
        }
        // Crashes are the #1 thing to see remotely.
        val prior = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            log("error", message = "${e.javaClass.simpleName}: ${e.message}", stack = e.stackTraceToString().take(4000))
            flushEvents()
            prior?.uncaughtException(t, e)
        }
    }

    fun onActivity(activity: Activity?) {
        currentActivity = activity?.let { WeakReference(it) }
    }

    /** App-wide event emit — HubClient net interceptor + WS lifecycles call this. */
    fun log(cat: String, level: String = "log", vararg args: String, message: String? = null, stack: String? = null,
            method: String? = null, url: String? = null, status: Int? = null, duration: Long? = null) {
        val e = JSONObject().put("ts", System.currentTimeMillis()).put("cat", cat)
        if (cat == "console") { e.put("level", level); e.put("args", JSONArray(args.toList())) }
        message?.let { e.put("message", it) }
        stack?.let { e.put("stack", it) }
        method?.let { e.put("method", it) }
        url?.let { e.put("url", it) }
        status?.let { e.put("status", it) }
        duration?.let { e.put("duration", it) }
        events.add(e)
        while (events.size > MAX_QUEUE) events.poll()
    }

    // ------------------------------------------------------------------ //

    private fun open() {
        if (!wantConnected) return
        val builder = Request.Builder()
            .url(HubConfig.hubBase.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/debug")
            .header("User-Agent", "ConsoleAPK-Native/${BuildConfig.VERSION_NAME}")
        HubTokenStore.get()?.let { builder.header("Authorization", "Bearer $it") }
        ws = okHttp.newWebSocket(builder.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                log("console", "info", "debug agent connected v${BuildConfig.VERSION_NAME}")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { runCatching { handle(JSONObject(text)) } }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = scheduleReconnect()
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = scheduleReconnect()
        })
    }

    private fun scheduleReconnect() {
        if (!wantConnected) return
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(5000)
            if (wantConnected) open()
        }
    }

    private fun flushEvents() {
        if (events.isEmpty()) return
        val socket = ws ?: return
        val batch = JSONArray()
        while (true) {
            val e = events.poll() ?: break
            batch.put(e)
        }
        if (batch.length() > 0) {
            socket.send(JSONObject().put("type", "debug_events").put("events", batch).toString())
        }
    }

    private suspend fun handle(msg: JSONObject) {
        when (msg.optString("type")) {
            "debug_eval" -> {
                val id = msg.optString("id")
                val result = runCatching { runCommand(msg.optString("code").trim()) }
                ws?.send(
                    JSONObject().put("type", "debug_eval_result").put("id", id)
                        .put("result", result.getOrElse { "" })
                        .apply { result.exceptionOrNull()?.let { put("error", it.message ?: it.javaClass.simpleName) } }
                        .toString()
                )
            }
            "debug_get_state" -> {
                val id = msg.optString("id")
                ws?.send(JSONObject().put("type", "debug_state").put("id", id).put("stores", stateSummary()).toString())
            }
            "debug_screenshot" -> {
                val id = msg.optString("id")
                val shot = runCatching { screenshot() }
                ws?.send(
                    JSONObject().put("type", "debug_screenshot").put("id", id)
                        .put("dataUrl", shot.getOrElse { "" })
                        .apply { shot.exceptionOrNull()?.let { put("error", it.message ?: "capture failed") } }
                        .toString()
                )
            }
        }
    }

    // ------------------------------------------------------------------ //
    // Command DSL

    private suspend fun runCommand(code: String): String {
        val cmd = code.substringBefore(' ')
        val arg = code.substringAfter(' ', "").trim()
        return when (cmd) {
            "route" -> AppLifecycle.currentRoute.ifEmpty { "(none)" }
            "nav" -> {
                val ok = withContext(Dispatchers.Main) { navigate?.invoke(arg) ?: false }
                if (ok) "navigated to $arg — route now ${AppLifecycle.currentRoute}" else "nav handler missing or route rejected: $arg"
            }
            "back" -> {
                val ok = withContext(Dispatchers.Main) { goBack?.invoke() ?: false }
                if (ok) "popped — route now ${AppLifecycle.currentRoute}" else "back stack empty"
            }
            "sql" -> {
                require(arg.lowercase().startsWith("select") || arg.lowercase().startsWith("pragma")) { "SELECT/PRAGMA only" }
                sqlQuery(arg)
            }
            "state" -> stateSummary().toString(2)
            "reconcile" -> { reconcileTrigger?.invoke(); "reconcile triggered" }
            "drain" -> { drainTrigger?.invoke(); "outbox drain scheduled" }
            "help" -> "route | nav <route> | back | sql <select…> | state | reconcile | drain"
            else -> throw IllegalArgumentException("unknown command '$cmd' — try help")
        }
    }

    private fun sqlQuery(query: String): String {
        val database = db ?: return "db not ready"
        val cursor = database.openHelper.readableDatabase.query(query)
        val out = StringBuilder()
        cursor.use { c ->
            out.append(c.columnNames.joinToString(" | ")).append('\n')
            var rows = 0
            while (c.moveToNext() && rows < 100) {
                val row = (0 until c.columnCount).joinToString(" | ") { i ->
                    when (c.getType(i)) {
                        android.database.Cursor.FIELD_TYPE_NULL -> "NULL"
                        android.database.Cursor.FIELD_TYPE_BLOB -> "<blob ${c.getBlob(i).size}b>"
                        else -> c.getString(i)?.take(200) ?: ""
                    }
                }
                out.append(row).append('\n')
                rows++
            }
            out.append("($rows rows)")
        }
        return out.toString()
    }

    private fun stateSummary(): JSONObject {
        val base = JSONObject()
            .put("version", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            .put("route", AppLifecycle.currentRoute)
            .put("foreground", AppLifecycle.foreground)
            .put("online", Connectivity.online)
            .put("hubBase", HubConfig.hubBase)
            .put("hasToken", HubTokenStore.get() != null)
        stateProvider?.let { provider ->
            runCatching { base.put("app", provider()) }
        }
        return base
    }

    /** PixelCopy of the live window — exactly what's rendered (Compose incl). */
    private suspend fun screenshot(): String {
        val activity = currentActivity?.get() ?: throw IllegalStateException("no foreground activity")
        val view = activity.window.decorView
        require(view.width > 0 && view.height > 0) { "window not laid out" }
        // Downscale 2× to keep the payload sane on a 1080p+ panel.
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        val ok = suspendCancellableCoroutine { cont ->
            PixelCopy.request(activity.window, bitmap, { result ->
                cont.resume(result == PixelCopy.SUCCESS)
            }, Handler(Looper.getMainLooper()))
        }
        if (!ok) throw IllegalStateException("PixelCopy failed")
        val scaled = Bitmap.createScaledBitmap(bitmap, view.width / 2, view.height / 2, true)
        bitmap.recycle()
        val bytes = ByteArrayOutputStream().use { buf ->
            scaled.compress(Bitmap.CompressFormat.PNG, 90, buf)
            buf.toByteArray()
        }
        scaled.recycle()
        return "data:image/png;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
}
