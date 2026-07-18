package io.amar.console

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.graphics.drawable.IconCompat
import android.util.Base64
import io.amar.console.glasses.BleManager
import io.amar.console.glasses.G1Protocol
import io.amar.console.glasses.GlassesController
import io.amar.console.pen.PenBleManager
import io.amar.console.pen.PenController
import io.amar.console.pen.PenProtocol
import io.amar.console.pen.PenState
import io.amar.console.glasses.GlassesState
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Foreground service holding a persistent WebSocket to the hub's `/push`
 * endpoint. When the APK is backgrounded the WebView freezes, so the web
 * app's Notification API and in-app toasts go silent. This service stays
 * alive (required by Android: foreground service + persistent notification)
 * and translates hub pushes into system notifications.
 *
 * Chat notifications use `NotificationCompat.MessagingStyle` to render like
 * other modern messaging apps: sender avatar, stacked message history per
 * room, grouped under a "Chat" bundle. Vibration is debounced per room
 * (max once per 60s) so rapid-fire messages don't rattle the phone.
 */
class PushService : Service() {

    companion object {
        const val ONGOING_NOTIFICATION_ID = 1
        const val CHANNEL_ONGOING = "ongoing"
        const val CHANNEL_MAIL = "mail"
        const val CHANNEL_CHAT = "chat"
        const val CHANNEL_CALENDAR = "calendar"
        const val CHANNEL_AGENT = "agent"
        const val CHANNEL_MONEY = "money"
        const val CHANNEL_GENERIC = "generic"

        /** Summary notification for grouped chat messages. */
        const val CHAT_GROUP_KEY = "console.chat"
        const val CHAT_SUMMARY_ID = 100

        /** Summary notification for grouped mail messages. */
        const val MAIL_GROUP_KEY = "console.mail"
        const val MAIL_SUMMARY_ID = 101

        // Endpoints resolve from HubConfig (set on the pairing screen).
        private val PUSH_URL: String get() = io.amar.console.core.HubConfig.pushWsUrl
        private val HUB_HTTPS: String get() = io.amar.console.core.HubConfig.hubBase
        private const val RECONNECT_MIN_MS = 2_000L
        private const val RECONNECT_MAX_MS = 60_000L
        private const val VIBRATE_DEBOUNCE_MS = 60_000L
        private const val AVATAR_PX = 128
        /** Keep the last N messages rendered in a per-room MessagingStyle stack. */
        private const val ROOM_HISTORY_LIMIT = 8
        /**
         * Audio frame buffer cap while the hub WS is down. Mic emits ~50 fps,
         * so 3000 frames = ~60 s = ~840 KB at ~280 B per serialized JSON frame.
         * When full we drop from the front (keep the tail fresh) — an STT
         * consumer reading buffered frames after reconnect will still get the
         * most recent 60 s of speech.
         */
        private const val AUDIO_BUFFER_MAX = 3000
        private val HEX_CHARS = "0123456789abcdef".toCharArray()

        fun start(ctx: Context) {
            val i = Intent(ctx, PushService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i)
            } else {
                ctx.startService(i)
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, PushService::class.java))
        }

        /** Bounce the WebSocket so a freshly-set hub bearer takes effect. */
        fun kick(ctx: Context) {
            val i = Intent(ctx, PushService::class.java).setAction(ACTION_KICK)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i)
            } else {
                ctx.startService(i)
            }
        }

        const val ACTION_KICK = "io.amar.console.PUSH_KICK"
        private const val NOTIF_NEEDS_PAIR_ID = 200
    }

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .pingInterval(30, TimeUnit.SECONDS)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS) // long-lived
            .retryOnConnectionFailure(true)
            .build()
    }
    private var webSocket: WebSocket? = null
    private var reconnectDelayMs = RECONNECT_MIN_MS
    private val reconnectHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var stopped = false

    /**
     * LC3 audio frames queued while the hub WS is down. Guarded by itself
     * (`synchronized(audioBuffer) { ... }`). Writer is the BLE worker thread
     * via `onAudioFrame`; drainers are the same thread plus the OkHttp WS
     * thread on `onOpen`. A pre-serialized JSON string (not the raw bytes)
     * lives in the queue so we don't re-encode on flush.
     */
    private val audioBuffer = ArrayDeque<String>()

    /**
     * When true, the BLE raw-frame forwarder also ships heartbeats to the
     * hub's research log. Unknown/unhandled frames are always forwarded
     * regardless; audio frames are never forwarded here (they'd drown the
     * log). Toggled via the `setResearch` RPC (see `handleHubRpc`).
     */
    @Volatile private var researchVerbose = false

    /** Per-room notification state: messages + last-vibrate timestamp. */
    private data class ChatMessage(val text: String, val ts: Long, val sender: Person)
    private data class RoomState(
        val history: ArrayDeque<ChatMessage> = ArrayDeque(),
        var lastVibrateMs: Long = 0L,
        var roomName: String? = null,
        var isDirect: Boolean = true,
    )
    private val roomStates = ConcurrentHashMap<String, RoomState>()
    /** Cache of mxc://... → Bitmap so we don't re-fetch every notification. */
    private val avatarCache = ConcurrentHashMap<String, Bitmap>()
    /** Global mail-vibrate debounce — one buzz per 60s no matter how many threads land. */
    @Volatile private var lastMailVibrateMs: Long = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    /** GlassesState snapshot enriched with the phone's own battery %, which the
     *  pure GlassesState singleton can't read (no Context). Used everywhere we
     *  ship a `glasses_state` frame / answer the `status` RPC so the HUD can
     *  show phone battery alongside the glasses arms. */
    private fun glassesStateJson(): JSONObject =
        GlassesState.toJson().put("phoneBattery", readPhoneBatteryPct() ?: JSONObject.NULL)

    /** Current phone battery 0..100, or null if unavailable. */
    private fun readPhoneBatteryPct(): Int? = try {
        val bm = getSystemService(Context.BATTERY_SERVICE) as? android.os.BatteryManager
        bm?.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)?.takeIf { it in 0..100 }
    } catch (_: Throwable) { null }

    /** Listener that streams GlassesState snapshots to the hub on every change. */
    private val glassesListener: () -> Unit = {
        val ws = webSocket
        if (ws != null) {
            try {
                val frame = JSONObject()
                    .put("type", "glasses_state")
                    .put("state", glassesStateJson())
                ws.send(frame.toString())
            } catch (_: Exception) { /* ignore */ }
        }
    }

    /**
     * BLE listener that forwards raw G1 audio (LC3) frames to the hub. The
     * glasses only emit audio when the mic is active (see `setMic` RPC), so
     * no filtering needed. Frames are small (~200 B LC3) at ~50 fps = ~10 KB/s;
     * cheap to pipe over the existing push WS as base64.
     */
    private val bleListener = object : BleManager.Listener {
        override fun onAudioFrame(seq: Int, lc3Bytes: ByteArray) {
            try {
                val frame = JSONObject()
                    .put("type", "glasses_audio")
                    .put("seq", seq)
                    .put("lc3b64", Base64.encodeToString(lc3Bytes, Base64.NO_WRAP))
                // Always go through the buffer so mid-utterance WS drops
                // don't lose audio. flushAudioLocked() sends immediately if
                // the WS is up.
                bufferOrSendAudio(frame.toString())
            } catch (_: Exception) { /* ignore */ }
        }
        override fun onTouch(arm: G1Protocol.Arm, subcmd: Byte) {
            // Not buffered — touches are transient user input and would be
            // stale by the time the hub comes back. Drop if offline.
            val ws = webSocket ?: return
            try {
                val frame = JSONObject()
                    .put("type", "glasses_touch")
                    .put("arm", arm.name.lowercase())
                    .put("subcmd", subcmd.toInt() and 0xFF)
                ws.send(frame.toString())
            } catch (_: Exception) { /* ignore */ }
        }
        override fun onScanObservation(name: String, mac: String, rssi: Int) {
            // Forward every named advertisement seen during a scan so the
            // hub research log can show what's in range. Not filtered by
            // researchVerbose — scans are user-initiated and rare.
            val ws = webSocket ?: return
            try {
                val frame = JSONObject()
                    .put("type", "glasses_scan_observation")
                    .put("name", name)
                    .put("mac", mac)
                    .put("rssi", rssi)
                    .put("ts", System.currentTimeMillis())
                ws.send(frame.toString())
            } catch (_: Exception) { /* ignore */ }
        }
        override fun onFrame(arm: G1Protocol.Arm, data: ByteArray, kind: String) {
            // Never forward audio here — already handled via onAudioFrame
            // and far too high-volume for the research log.
            if (kind == "audio") return
            // Heartbeat is pure noise unless the user has explicitly enabled
            // verbose research mode. Unhandled/touch/ack always go through.
            if (kind == "heartbeat" && !researchVerbose) return
            val ws = webSocket ?: return
            try {
                val frame = JSONObject()
                    .put("type", "glasses_frame")
                    .put("arm", arm.name.lowercase())
                    .put("kind", kind)
                    .put("hex", data.toHex())
                    .put("ts", System.currentTimeMillis())
                ws.send(frame.toString())
            } catch (_: Exception) { /* ignore */ }
        }
    }

    // --- Pen (Neo smartpen) — mirrors the glasses listeners above ----------
    /** Streams PenState snapshots to the hub on every change. */
    private val penListener: () -> Unit = {
        val ws = webSocket
        if (ws != null) {
            try { ws.send(JSONObject().put("type", "pen_state").put("state", PenState.toJson()).toString()) }
            catch (_: Exception) { /* ignore */ }
        }
    }

    /** Forwards pen BLE frames + scan observations to the hub research pipeline. */
    private val penBleListener = object : PenBleManager.Listener {
        override fun onFrame(body: ByteArray, kind: String) {
            if (kind == "heartbeat" && !researchVerbose) return
            val ws = webSocket ?: return
            try {
                ws.send(
                    JSONObject()
                        .put("type", "pen_frame").put("kind", kind)
                        .put("hex", body.toHex()).put("ts", System.currentTimeMillis())
                        .toString(),
                )
            } catch (_: Exception) { /* ignore */ }
        }
        override fun onRaw(data: ByteArray) {
            // Raw GATT notifications only when verbose — the safety net if framing looks wrong.
            if (!researchVerbose) return
            val ws = webSocket ?: return
            try {
                ws.send(
                    JSONObject()
                        .put("type", "pen_frame").put("kind", "raw")
                        .put("hex", data.toHex()).put("ts", System.currentTimeMillis())
                        .toString(),
                )
            } catch (_: Exception) { /* ignore */ }
        }
        override fun onScanObservation(name: String, mac: String, rssi: Int, has19f1: Boolean) {
            val ws = webSocket ?: return
            try {
                ws.send(
                    JSONObject()
                        .put("type", "pen_scan_observation")
                        .put("name", name).put("mac", mac).put("rssi", rssi).put("has19f1", has19f1)
                        .put("ts", System.currentTimeMillis()).toString(),
                )
            } catch (_: Exception) { /* ignore */ }
        }
        override fun onOfflineNotes(notes: List<PenProtocol.OfflineNote>) {
            val ws = webSocket ?: return
            val arr = org.json.JSONArray()
            for (n in notes) arr.put(JSONObject().put("section", n.section).put("owner", n.owner).put("note", n.note))
            try { ws.send(JSONObject().put("type", "pen_offline_notes").put("notes", arr).toString()) } catch (_: Exception) {}
        }
        override fun onOfflinePages(pages: PenProtocol.OfflinePages) {
            val ws = webSocket ?: return
            val arr = org.json.JSONArray()
            for (p in pages.pages) arr.put(p)
            try {
                ws.send(
                    JSONObject().put("type", "pen_offline_pages")
                        .put("section", pages.section).put("owner", pages.owner).put("note", pages.note)
                        .put("pages", arr).toString(),
                )
            } catch (_: Exception) {}
        }
        override fun onOfflineXferStart(section: Int, owner: Int, note: Long, page: Long, header: PenProtocol.OfflineHeader) {
            val ws = webSocket ?: return
            try {
                ws.send(
                    JSONObject().put("type", "pen_offline_start")
                        .put("section", section).put("owner", owner).put("note", note).put("page", page)
                        .put("strokeCount", header.strokeCount).put("totalSize", header.totalSize)
                        .put("compressed", header.compressed).toString(),
                )
            } catch (_: Exception) {}
        }
        override fun onOfflineChunk(section: Int, owner: Int, note: Long, page: Long, packetId: Int, position: Int, raw: ByteArray) {
            val ws = webSocket ?: return
            try {
                ws.send(
                    JSONObject().put("type", "pen_offline_chunk")
                        .put("section", section).put("owner", owner).put("note", note).put("page", page)
                        .put("packetId", packetId).put("position", position).put("hex", raw.toHex()).toString(),
                )
            } catch (_: Exception) {}
        }
        override fun onOfflineDone(section: Int, owner: Int, note: Long, page: Long) {
            val ws = webSocket ?: return
            try {
                ws.send(
                    JSONObject().put("type", "pen_offline_done")
                        .put("section", section).put("owner", owner).put("note", note).put("page", page).toString(),
                )
            } catch (_: Exception) {}
        }
    }

    /**
     * Enqueue a serialized audio frame and attempt to flush. Holding the
     * monitor on `audioBuffer` for the whole transaction keeps the queue's
     * tail consistent across the BLE worker and OkHttp WS threads.
     */
    private fun bufferOrSendAudio(frameStr: String) {
        synchronized(audioBuffer) {
            audioBuffer.addLast(frameStr)
            while (audioBuffer.size > AUDIO_BUFFER_MAX) audioBuffer.removeFirst()
            flushAudioLocked()
        }
    }

    /** Drain pending audio frames to the WS. Caller must hold `audioBuffer`. */
    private fun flushAudioLocked() {
        val ws = webSocket ?: return
        while (audioBuffer.isNotEmpty()) {
            val f = audioBuffer.first()
            val sent = try { ws.send(f) } catch (_: Throwable) { false }
            if (!sent) break // socket backpressure or dead — stop and try later
            audioBuffer.removeFirst()
        }
    }

    private fun hexToBytes(s: String): ByteArray {
        val clean = s.trim().replace(" ", "")
        if (clean.isEmpty() || clean.length % 2 != 0) return ByteArray(0)
        return try {
            ByteArray(clean.length / 2) { ((clean[it * 2].digitToInt(16) shl 4) or clean[it * 2 + 1].digitToInt(16)).toByte() }
        } catch (_: Throwable) { ByteArray(0) }
    }

    private fun ByteArray.toHex(): String {
        val sb = StringBuilder(size * 2)
        for (b in this) {
            val v = b.toInt() and 0xFF
            sb.append(HEX_CHARS[v ushr 4]).append(HEX_CHARS[v and 0x0F])
        }
        return sb.toString()
    }

    override fun onCreate() {
        super.onCreate()
        // The service can start in a fresh process (BootReceiver path) where
        // Application.onCreate hasn't run these; init is idempotent + cheap.
        io.amar.console.core.HubConfig.init(this)
        HubTokenStore.init(this)
        ensureChannels()
        startForegroundCompat()
        connect()
        // Keep the hub's cached state in sync with BLE reality.
        GlassesState.addListener(glassesListener)
        // Forward BLE audio + touch to the hub. BleManager may not be ready
        // yet (GlassesService starts async); poll until it is.
        attachBleListener()
        PenState.addListener(penListener)
        attachPenListener()
        registerPttProbe()
    }

    // --- PTT hardware-button probe ------------------------------------------
    // The rugged phone's Custom key can be set (Settings → SOS/Custom key →
    // Long press → "Open Zello") to emit Zello-style PTT broadcasts. We don't
    // know which action this firmware uses, so register the widest plausible
    // set and forward anything that fires to the hub for inspection. Real
    // hold-to-talk gets wired to whichever down/up pair actually shows up.
    private val pttActions = listOf(
        "com.zello.ptt.down", "com.zello.ptt.up", "com.zello.ptt.toggle",
        "com.zello.ptt.action.down", "com.zello.ptt.action.up",
        "android.intent.action.PTT", "com.ptt.down", "com.ptt.up",
        "com.ulefone.ptt.down", "com.ulefone.ptt.up", "com.ptt.intent.action.PTT",
    )
    private val pttReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            val action = intent?.action ?: return
            // Forward to the hub for visibility (kept from the probe build).
            try { webSocket?.send(JSONObject().put("type", "ptt_button").put("action", action).toString()) } catch (_: Exception) {}
            when {
                action.endsWith(".down") -> pttDown()
                action.endsWith(".up") -> pttUp()
            }
        }
    }

    // --- Hold-to-talk capture: mic → hub /stt → owner -----------------------
    @Volatile private var pttRecord: AudioRecord? = null
    @Volatile private var pttWs: WebSocket? = null
    @Volatile private var pttActive = false
    private val pttFinals = StringBuilder()
    @Volatile private var pttPending = ""
    private fun pttFullText(): String =
        (pttFinals.toString() + pttPending).trim().replace(Regex("\\s+"), " ")

    private fun hubPost(path: String, json: String) {
        try {
            val rb = Request.Builder().url("$HUB_HTTPS$path")
                .post(json.toRequestBody("application/json".toMediaType()))
            HubTokenStore.get()?.let { rb.header("Authorization", "Bearer $it") }
            client.newCall(rb.build()).enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {}
                override fun onResponse(call: okhttp3.Call, response: Response) { response.close() }
            })
        } catch (_: Exception) {}
    }

    private fun pttDown() {
        if (pttActive) return
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            // No mic permission — the WebView grant doesn't cover a background
            // service. Nudge the user to open the app + grant it.
            postNeedsPairNotification() // reuse the open-app notification path
            return
        }
        pttActive = true
        pttFinals.setLength(0); pttPending = ""
        setForegroundType(withMic = true)        // assert mic FGS type for AudioRecord
        hubPost("/mic/hot", "{\"hot\":true}")
        // Stream to the hub /stt realtime transcription WS (origin-gated; a
        // no-origin native client passes verifyClient).
        val reqB = Request.Builder().url(io.amar.console.core.HubConfig.sttWsUrl)
        HubTokenStore.get()?.let { reqB.header("Authorization", "Bearer $it") }
        val req = reqB.build()
        pttWs = client.newWebSocket(req, object : WebSocketListener() {
            override fun onMessage(ws: WebSocket, text: String) {
                try {
                    val m = JSONObject(text)
                    when (m.optString("type")) {
                        "interim" -> { pttPending += m.optString("text"); }
                        "final" -> { val t = m.optString("text"); if (t.isNotEmpty()) pttFinals.append(t).append(' '); pttPending = "" }
                    }
                } catch (_: Exception) {}
            }
        })
        startAudioStream()
    }

    private fun startAudioStream() {
        val sr = 24000
        val minBuf = AudioRecord.getMinBufferSize(sr, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = try {
            @Suppress("MissingPermission")
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, sr, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, sr / 5 * 2))
        } catch (_: Throwable) { return }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { try { rec.release() } catch (_: Throwable) {}; return }
        pttRecord = rec
        try { rec.startRecording() } catch (_: Throwable) { return }
        Thread {
            val buf = ByteArray(sr / 20 * 2)     // ~50ms frames
            while (pttActive) {
                val n = try { rec.read(buf, 0, buf.size) } catch (_: Throwable) { -1 }
                if (n > 0) {
                    val b64 = Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)
                    try { pttWs?.send(JSONObject().put("type", "audio").put("data", b64).toString()) } catch (_: Exception) {}
                } else if (n < 0) break
            }
        }.start()
    }

    private fun pttUp() {
        if (!pttActive) return
        pttActive = false
        try { pttRecord?.stop() } catch (_: Throwable) {}
        try { pttRecord?.release() } catch (_: Throwable) {}
        pttRecord = null
        hubPost("/mic/hot", "{\"hot\":false}")
        setForegroundType(withMic = false)
        // Give OpenAI a beat to flush a trailing final, then route + close.
        reconnectHandler.postDelayed({
            try { pttWs?.close(1000, "ptt-end") } catch (_: Exception) {}
            pttWs = null
            val text = pttFullText()
            if (text.isNotEmpty()) {
                val payload = JSONObject().put("text", text).toString()
                // Compose into the SPA composer when Console is foreground (its
                // sync-bus is live); otherwise auto-send so it isn't lost.
                hubPost(if (io.amar.console.core.AppLifecycle.foreground) "/mic/compose" else "/mic/say", payload)
            }
        }, 700)
    }
    private fun registerPttProbe() {
        try {
            val filter = IntentFilter()
            pttActions.forEach { filter.addAction(it) }
            // Cross-app broadcasts require an EXPORTED dynamic receiver on API 33+.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(pttReceiver, filter, Context.RECEIVER_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                registerReceiver(pttReceiver, filter)
            }
        } catch (_: Throwable) {}
    }

    private fun attachBleListener(attempt: Int = 0) {
        if (GlassesController.isReady()) {
            try { GlassesController.requireBle().addListener(bleListener) } catch (_: Throwable) {}
            return
        }
        if (attempt >= 50) return
        android.os.Handler(android.os.Looper.getMainLooper())
            .postDelayed({ attachBleListener(attempt + 1) }, 100L)
    }

    private fun attachPenListener(attempt: Int = 0) {
        if (PenController.isReady()) {
            try { PenController.requireBle().addListener(penBleListener) } catch (_: Throwable) {}
            return
        }
        if (attempt >= 50) return
        android.os.Handler(android.os.Looper.getMainLooper())
            .postDelayed({ attachPenListener(attempt + 1) }, 100L)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_KICK) {
            // SPA just set a new hub bearer — reconnect with the fresh token.
            reconnectDelayMs = RECONNECT_MIN_MS
            reconnectHandler.removeCallbacksAndMessages(null)
            try { webSocket?.close(1000, "rekey") } catch (_: Exception) {}
            webSocket = null
            cancelNeedsPairNotification()
            connect()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        GlassesState.removeListener(glassesListener)
        if (GlassesController.isReady()) {
            try { GlassesController.requireBle().removeListener(bleListener) } catch (_: Throwable) {}
        }
        PenState.removeListener(penListener)
        if (PenController.isReady()) {
            try { PenController.requireBle().removeListener(penBleListener) } catch (_: Throwable) {}
        }
        reconnectHandler.removeCallbacksAndMessages(null)
        try { unregisterReceiver(pttReceiver) } catch (_: Throwable) {}
        try { webSocket?.close(1000, "shutdown") } catch (_: Exception) {}
        webSocket = null
        super.onDestroy()
    }

    // --- Foreground + channels -----------------------------------------------

    private fun startForegroundCompat() = setForegroundType(withMic = false)

    /** (Re)assert the foreground service, optionally adding the microphone
     *  type so AudioRecord is permitted while the app is backgrounded. The
     *  service is ALREADY foreground, so this updates its active type rather
     *  than starting from background (which Android 14+ would block for mic). */
    private fun setForegroundType(withMic: Boolean) {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notif = NotificationCompat.Builder(this, CHANNEL_ONGOING)
            .setContentTitle("Console")
            .setContentText(if (withMic) "Listening…" else "Connected")
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(pi)
            .setGroup("console.ongoing")
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            if (withMic) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            try { startForeground(ONGOING_NOTIFICATION_ID, notif, type) }
            catch (_: Throwable) { try { startForeground(ONGOING_NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) } catch (_: Throwable) {} }
        } else {
            startForeground(ONGOING_NOTIFICATION_ID, notif)
        }
    }

    private fun ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannels(listOf(
            NotificationChannel(CHANNEL_ONGOING, "Console connection", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Persistent notification while Console push is connected"
                setShowBadge(false)
            },
            NotificationChannel(CHANNEL_MAIL, "Mail", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(CHANNEL_CHAT, "Chat", NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(CHANNEL_CALENDAR, "Calendar", NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(CHANNEL_AGENT, "Agents", NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(CHANNEL_MONEY, "Money", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(CHANNEL_GENERIC, "Other", NotificationManager.IMPORTANCE_DEFAULT),
        ))
    }

    // --- WebSocket lifecycle --------------------------------------------------

    private fun connect() {
        if (stopped) return
        val builder = Request.Builder().url(PUSH_URL)
        // Authorization: Bearer <token> — the hub validates this in log-only
        // mode (decorative pre-enforcement) and starts rejecting after Phase 8
        // flips CONSOLE_AUTH_ENABLED. If we never received a token (fresh
        // install / clear), connect anyway so the loopback log path still has
        // something useful.
        HubTokenStore.get()?.let { builder.header("Authorization", "Bearer $it") }
        webSocket = client.newWebSocket(builder.build(), listener)
    }

    /**
     * Show a persistent notification telling the user to re-pair from the
     * SPA. Tapping it opens the app where they can hit "Pair this APK" again.
     */
    private fun postNeedsPairNotification() {
        HubTokenStore.markNeedsRepair()
        val openApp = android.content.Intent(this, MainActivity::class.java)
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = android.app.PendingIntent.getActivity(
            this,
            0,
            openApp,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        val n = androidx.core.app.NotificationCompat.Builder(this, CHANNEL_GENERIC)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("Console: re-pair needed")
            .setContentText("The hub rejected this device's token. Open the app and hit Pair this APK.")
            .setContentIntent(pending)
            .setOngoing(false)
            .setAutoCancel(true)
            .build()
        androidx.core.app.NotificationManagerCompat.from(this).notify(NOTIF_NEEDS_PAIR_ID, n)
    }

    private fun cancelNeedsPairNotification() {
        try {
            androidx.core.app.NotificationManagerCompat.from(this).cancel(NOTIF_NEEDS_PAIR_ID)
        } catch (_: Exception) {}
    }

    private fun scheduleReconnect() {
        if (stopped) return
        reconnectHandler.postDelayed({ connect() }, reconnectDelayMs)
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(RECONNECT_MAX_MS)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(ws: WebSocket, response: Response) {
            reconnectDelayMs = RECONNECT_MIN_MS
            // Send the current glasses snapshot on (re)connect so the hub's
            // cache is correct even if no BLE event fires soon after.
            try {
                val frame = JSONObject()
                    .put("type", "glasses_state")
                    .put("state", glassesStateJson())
                ws.send(frame.toString())
            } catch (_: Exception) { /* ignore */ }
            // Flush any audio frames that piled up while the hub was down —
            // e.g. mid-utterance WS drop while mic is live.
            synchronized(audioBuffer) { flushAudioLocked() }
        }
        override fun onMessage(ws: WebSocket, text: String) {
            try { handlePush(JSONObject(text)) } catch (_: Exception) {}
        }
        override fun onClosing(ws: WebSocket, code: Int, reason: String) {
            ws.close(1000, null)
        }
        override fun onClosed(ws: WebSocket, code: Int, reason: String) {
            webSocket = null
            // Per RFC 6455, the server can send an application-level 4401/4403
            // close code to signal an auth problem. Treat that as "needs re-pair"
            // rather than retrying in a tight loop.
            if (code == 4401 || code == 4403) {
                postNeedsPairNotification()
                reconnectDelayMs = RECONNECT_MAX_MS
            }
            scheduleReconnect()
        }
        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
            webSocket = null
            // Standard HTTP upgrade rejection — the hub said 401 before the
            // WS handshake completed. OkHttp surfaces it via onFailure with
            // Response.code() = 401.
            val status = response?.code
            if (status == 401 || status == 403) {
                postNeedsPairNotification()
                reconnectDelayMs = RECONNECT_MAX_MS
            }
            scheduleReconnect()
        }
    }

    // --- Push handling --------------------------------------------------------

    private fun handlePush(json: JSONObject) {
        val type = json.optString("type")
        if (type == "hello") return
        if (type == "rpc_request") {
            handleHubRpc(json)
            return
        }
        if (type == "notif_reconcile") {
            handleReconcile(json)
            return
        }
        if (json.optBoolean("cancel", false)) {
            handleCancelPush(json, type)
            return
        }
        if (type == "chat") {
            handleChatPush(json)
            return
        }
        if (type == "mail") {
            handleMailPush(json)
            return
        }
        handleGenericPush(json, type)
    }

    /**
     * Dismiss a previously-posted notification. Match key derivation mirrors
     * the per-channel post path: chat uses `roomId.hashCode()`, mail uses
     * `"mail:$account:$threadId".hashCode()`, everything else uses `id`.
     * Fired by the hub when the underlying item is handled (archived, read,
     * approval answered) — includes both in-app and external actions (e.g.
     * stock Gmail app archive) via the normal sync loop.
     */
    private fun handleCancelPush(json: JSONObject, type: String) {
        val nm = NotificationManagerCompat.from(this)
        when (type) {
            "chat" -> {
                val roomId = json.optString("roomId").takeIf { it.isNotEmpty() } ?: return
                try { nm.cancel(roomId.hashCode()) } catch (_: SecurityException) {}
                roomStates.remove(roomId)
            }
            "mail" -> {
                val account = json.optString("account").takeIf { it.isNotEmpty() } ?: return
                val threadId = json.optString("threadId").takeIf { it.isNotEmpty() } ?: return
                try { nm.cancel(("mail:$account:$threadId").hashCode()) } catch (_: SecurityException) {}
            }
            else -> {
                val idStr = json.optString("id").takeIf { it.isNotEmpty() } ?: return
                try { nm.cancel(idStr.hashCode()) } catch (_: SecurityException) {}
            }
        }
    }

    /**
     * Reconcile active notifications against the hub's "keep" sets, sent on
     * every push (re)connect. The hub can't know what we're showing after a
     * restart (its in-memory push tracking is gone), so it sends the set of
     * items that are STILL unread; we cancel any chat/mail notification not
     * in that set. Only the chat + mail channels are touched — point-in-time
     * types (money, flights, calendar, agent) have no read-state and are
     * left alone. A key absent from the frame (e.g. `mail` omitted on a hub
     * Gmail-fetch failure) means "don't reconcile that channel this round".
     */
    private fun handleReconcile(json: JSONObject) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return // getActiveNotifications: API 23+
        val nm = getSystemService(NotificationManager::class.java) ?: return

        // chat keep — roomId.hashCode() mirrors handleChatPush's notifId.
        val keepIds = HashSet<Int>()
        var reconcileChat = false
        json.optJSONArray("chat")?.let { arr ->
            reconcileChat = true
            for (i in 0 until arr.length()) {
                val roomId = arr.optString(i)
                if (roomId.isNotEmpty()) keepIds.add(roomId.hashCode())
            }
        }
        // mail keep — "mail:$account:$threadId".hashCode() mirrors handleMailPush.
        var reconcileMail = false
        json.optJSONArray("mail")?.let { arr ->
            reconcileMail = true
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val account = o.optString("account")
                val threadId = o.optString("threadId")
                if (account.isNotEmpty() && threadId.isNotEmpty()) {
                    keepIds.add(("mail:$account:$threadId").hashCode())
                }
            }
        }

        // Never cancel the foreground-service notif, the group summaries, or
        // the needs-pair notice.
        val reserved = setOf(ONGOING_NOTIFICATION_ID, CHAT_SUMMARY_ID, MAIL_SUMMARY_ID, NOTIF_NEEDS_PAIR_ID)
        try {
            for (sbn in nm.activeNotifications) {
                if (sbn.id in reserved) continue
                val channel = sbn.notification?.channelId
                val isChat = channel == CHANNEL_CHAT
                val isMail = channel == CHANNEL_MAIL
                if (isChat && !reconcileChat) continue
                if (isMail && !reconcileMail) continue
                if (!isChat && !isMail) continue // leave money/flights/calendar/agent alone
                if (sbn.id !in keepIds) {
                    nm.cancel(sbn.id)
                    // Drop the MessagingStyle history for a cancelled chat room
                    // (ConcurrentHashMap rejects a null key, so guard the lookup).
                    if (isChat) {
                        roomStates.keys.firstOrNull { it.hashCode() == sbn.id }?.let { roomStates.remove(it) }
                    }
                }
            }
        } catch (_: Exception) { /* getActiveNotifications can throw on some OEMs */ }
    }

    /**
     * Gmail-style per-thread notification. One notif per threadId, grouped
     * under a "Mail" summary. Title = sender name, big-text body = subject +
     * snippet. Tap opens the mail pane; Archive + Mark-as-Read actions act
     * on the single thread. Global vibrate debounce prevents rattling on a
     * batch arrival (e.g. after waking from sleep).
     */
    private fun handleMailPush(json: JSONObject) {
        val account = json.optString("account").takeIf { it.isNotEmpty() } ?: return
        val threadId = json.optString("threadId").takeIf { it.isNotEmpty() } ?: run {
            handleGenericPush(json, "mail")
            return
        }
        val subject = json.optString("subject").takeIf { it.isNotEmpty() }
            ?: json.optString("body").takeIf { it.isNotEmpty() }
            ?: "(no subject)"
        val snippet = json.optString("snippet")
        val fromName = json.optString("fromName").takeIf { it.isNotEmpty() }
        val fromEmail = json.optString("fromEmail").takeIf { it.isNotEmpty() }
        val title = fromName ?: fromEmail ?: account

        val now = System.currentTimeMillis()
        val shouldVibrate = now - lastMailVibrateMs >= VIBRATE_DEBOUNCE_MS
        if (shouldVibrate) lastMailVibrateMs = now

        val notifId = ("mail:$account:$threadId").hashCode()

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            action = Intent.ACTION_VIEW
            data = Uri.parse("console://pane/mail")
        }
        val tapPi = PendingIntent.getActivity(
            this, notifId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val bigText = if (snippet.isNotEmpty()) "$subject\n\n$snippet" else subject
        val nb = NotificationCompat.Builder(this, CHANNEL_MAIL)
            .setContentTitle(title)
            .setContentText(subject)
            .setSubText(account)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText).setSummaryText(account))
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentIntent(tapPi)
            .setAutoCancel(true)
            .setWhen(now)
            .setShowWhen(true)
            .setGroup(MAIL_GROUP_KEY)
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setOnlyAlertOnce(!shouldVibrate)
            .setSilent(!shouldVibrate)
            .setPriority(
                if (shouldVibrate) NotificationCompat.PRIORITY_DEFAULT
                else NotificationCompat.PRIORITY_LOW
            )

        // --- Archive action -------------------------------------------------
        val archiveIntent = Intent(this, NotificationActionReceiver::class.java).apply {
            action = NotificationActionReceiver.ACTION_MAIL_ARCHIVE
            putExtra(NotificationActionReceiver.EXTRA_NOTIF_ID, notifId)
            putExtra(NotificationActionReceiver.EXTRA_ACCOUNT, account)
            putExtra(
                NotificationActionReceiver.EXTRA_THREAD_IDS,
                arrayOf(threadId),
            )
        }
        val archivePi = PendingIntent.getBroadcast(
            this, notifId, archiveIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val archiveAction = NotificationCompat.Action.Builder(
            R.drawable.ic_launcher_foreground, "Archive", archivePi,
        )
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_ARCHIVE)
            .setShowsUserInterface(false)
            .build()

        // --- Mark as Read action --------------------------------------------
        val readIntent = Intent(this, NotificationActionReceiver::class.java).apply {
            action = NotificationActionReceiver.ACTION_MAIL_READ
            putExtra(NotificationActionReceiver.EXTRA_NOTIF_ID, notifId)
            putExtra(NotificationActionReceiver.EXTRA_ACCOUNT, account)
            putExtra(NotificationActionReceiver.EXTRA_THREAD_IDS, arrayOf(threadId))
        }
        val readPi = PendingIntent.getBroadcast(
            // Offset req code so it doesn't collide with the archive PI.
            this, notifId xor 0x1, readIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val readAction = NotificationCompat.Action.Builder(
            R.drawable.ic_launcher_foreground, "Mark as Read", readPi,
        )
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build()

        nb.addAction(archiveAction).addAction(readAction)

        val nm = NotificationManagerCompat.from(this)
        try {
            nm.notify(notifId, nb.build())
            val summary = NotificationCompat.Builder(this, CHANNEL_MAIL)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("Mail")
                .setGroup(MAIL_GROUP_KEY)
                .setGroupSummary(true)
                .setAutoCancel(true)
                .setSilent(true)
                .build()
            nm.notify(MAIL_SUMMARY_ID, summary)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS not granted; silently skip.
        }
    }

    // --- Hub-originated RPC --------------------------------------------------
    //
    // The hub can ask us to drive the glasses from a distance. Shape:
    //   hub → APK:  { type: 'rpc_request', id, method, params }
    //   APK → hub:  { type: 'rpc_response', id, ok, result?, error? }

    private fun handleHubRpc(json: JSONObject) {
        val id = json.optString("id").takeIf { it.isNotEmpty() } ?: return
        val method = json.optString("method")
        val params = json.optJSONObject("params") ?: JSONObject()
        if (method.startsWith("pen_")) { handlePenRpc(id, method, params); return }
        try {
            if (!GlassesController.isReady()) {
                replyRpcError(id, "glasses controller not initialized")
                return
            }
            when (method) {
                "status" -> replyRpc(id, glassesStateJson())
                "sendText" -> {
                    val text = params.optString("text")
                    if (text.isEmpty()) { replyRpcError(id, "text required"); return }
                    GlassesController.sendText(text)
                    replyRpc(id, JSONObject().put("ok", true))
                }
                "clear" -> {
                    GlassesController.sendExit()
                    replyRpc(id, JSONObject().put("ok", true))
                }
                "sendBmp" -> {
                    val b64 = params.optString("bmp")
                    if (b64.isEmpty()) { replyRpcError(id, "bmp required"); return }
                    val bytes = Base64.decode(b64, Base64.DEFAULT)
                    GlassesController.sendBmp(bytes) { result ->
                        val obj = JSONObject()
                            .put("leftOk", result.leftOk)
                            .put("rightOk", result.rightOk)
                            .put("error", result.error ?: JSONObject.NULL)
                        replyRpc(id, obj)
                    }
                }
                "notify" -> {
                    // app_identifier MUST match a whitelisted id or firmware
                    // drops the 0x4B push (see BleManager on-connect whitelist).
                    // We register a single Console id; the human-readable source
                    // rides display_name so the card still reads "Mail"/"Chat".
                    val appId = params.optString("appIdentifier", G1Protocol.NOTIFY_APP_ID)
                    val displayName = params.optString("displayName", G1Protocol.NOTIFY_APP_NAME)
                    val msgId = (System.currentTimeMillis() and 0xFF).toInt()
                    val tsMs = params.optLong("timestamp", System.currentTimeMillis())
                    // Firmware expects the EvenDemoApp NCS envelope — a flat
                    // object is acked (valid 0x4B chunk) but never rendered.
                    // See docs/g1-protocol.md §9.
                    val inner = JSONObject()
                        .put("msg_id", msgId)
                        .put("app_identifier", appId)
                        .put("title", params.optString("title"))
                        .put("subtitle", params.optString("subtitle"))
                        .put("message", params.optString("message"))
                        .put("time_s", tsMs / 1000)
                        .put("date", java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date(tsMs)))
                        .put("display_name", displayName)
                    val payload = JSONObject().put("ncs_notification", inner)
                    GlassesController.sendNotification(msgId, payload.toString())
                    replyRpc(id, JSONObject().put("ok", true))
                }
                "setMic" -> {
                    GlassesController.setMic(params.optBoolean("active", false))
                    replyRpc(id, JSONObject().put("ok", true))
                }
                "setHeadUpAngle" -> {
                    GlassesController.requireBle().setHeadUpAngle(params.optInt("deg", 30))
                    replyRpc(id, JSONObject().put("ok", true))
                }
                "disconnect" -> {
                    GlassesController.requireBle().disconnect()
                    replyRpc(id, JSONObject().put("ok", true))
                }
                "startScan" -> {
                    val durationMs = params.optLong("durationMs", 15_000L)
                    GlassesController.requireBle().startScan(durationMs)
                    replyRpc(id, JSONObject().put("ok", true).put("durationMs", durationMs))
                }
                "stopScan" -> {
                    GlassesController.requireBle().stopScan()
                    replyRpc(id, JSONObject().put("ok", true))
                }
                "setResearch" -> {
                    // Toggle verbose raw-frame forwarding. Heartbeats only
                    // reach the hub when verbose=true. Unknown opcodes are
                    // always forwarded regardless (APK-side policy).
                    researchVerbose = params.optBoolean("verbose", false)
                    replyRpc(id, JSONObject().put("verbose", researchVerbose))
                }
                else -> replyRpcError(id, "unknown method: $method")
            }
        } catch (t: Throwable) {
            replyRpcError(id, t.message ?: t.toString())
        }
    }

    private fun handlePenRpc(id: String, method: String, params: JSONObject) {
        try {
            if (!PenController.isReady()) { replyRpcError(id, "pen controller not initialized"); return }
            when (method) {
                "pen_status" -> replyRpc(id, PenState.toJson())
                "pen_listDevices" -> replyRpc(id, JSONObject().put("devices", PenController.listDevices()))
                "pen_connect" -> {
                    val mac = params.optString("mac").takeIf { it.isNotEmpty() }
                    PenController.connect(mac)
                    replyRpc(id, JSONObject().put("ok", true).put("mac", mac ?: JSONObject.NULL))
                }
                "pen_disconnect" -> { PenController.disconnect(); replyRpc(id, JSONObject().put("ok", true)) }
                "pen_scan" -> {
                    val durationMs = params.optLong("durationMs", 15_000L)
                    PenController.startScan(durationMs)
                    replyRpc(id, JSONObject().put("ok", true).put("durationMs", durationMs))
                }
                "pen_stopScan" -> { PenController.stopScan(); replyRpc(id, JSONObject().put("ok", true)) }
                "pen_unlock" -> {
                    val pw = params.optString("password")
                    if (pw.isEmpty()) { replyRpcError(id, "password required"); return }
                    PenController.sendPassword(pw)
                    replyRpc(id, JSONObject().put("ok", true))
                }
                "pen_setResearch" -> {
                    researchVerbose = params.optBoolean("verbose", false)
                    replyRpc(id, JSONObject().put("verbose", researchVerbose))
                }
                "pen_offline_notes" -> { PenController.reqOfflineNotes(); replyRpc(id, JSONObject().put("ok", true)) }
                "pen_offline_pages" -> {
                    PenController.reqOfflinePages(params.optInt("section"), params.optInt("owner"), params.optLong("note"))
                    replyRpc(id, JSONObject().put("ok", true))
                }
                "pen_offline_pull" -> {
                    PenController.pullPage(
                        params.optInt("section"), params.optInt("owner"), params.optLong("note"), params.optLong("page"),
                    )
                    replyRpc(id, JSONObject().put("ok", true))
                }
                "pen_raw" -> {
                    val cmd = params.optInt("cmd", -1)
                    if (cmd < 0) { replyRpcError(id, "cmd required"); return }
                    val ok = PenController.sendRaw(cmd, hexToBytes(params.optString("data")))
                    replyRpc(id, JSONObject().put("ok", ok))
                }
                else -> replyRpcError(id, "unknown method: $method")
            }
        } catch (t: Throwable) {
            replyRpcError(id, t.message ?: t.toString())
        }
    }

    private fun replyRpc(id: String, result: Any) {
        val ws = webSocket ?: return
        try {
            val frame = JSONObject()
                .put("type", "rpc_response")
                .put("id", id)
                .put("ok", true)
                .put("result", result)
            ws.send(frame.toString())
        } catch (_: Exception) {}
    }

    private fun replyRpcError(id: String, error: String) {
        val ws = webSocket ?: return
        try {
            val frame = JSONObject()
                .put("type", "rpc_response")
                .put("id", id)
                .put("ok", false)
                .put("error", error)
            ws.send(frame.toString())
        } catch (_: Exception) {}
    }

    /** Chat pushes are rendered with MessagingStyle + per-room grouping. */
    private fun handleChatPush(json: JSONObject) {
        val roomId = json.optString("roomId").takeIf { it.isNotEmpty() } ?: run {
            // No roomId → fall back to generic behavior
            handleGenericPush(json, "chat")
            return
        }
        val body = json.optString("body")
        if (body.isEmpty()) return
        val senderName = json.optString("senderName").takeIf { it.isNotEmpty() } ?: "Unknown"
        val senderId = json.optString("senderId").takeIf { it.isNotEmpty() } ?: senderName
        val roomName = json.optString("roomName").takeIf { it.isNotEmpty() }
        val isDirect = json.optBoolean("isDirect", true)
        val ts = if (json.has("timestamp")) json.optLong("timestamp", System.currentTimeMillis())
                 else System.currentTimeMillis()
        val senderAvatarMxc = json.optString("senderAvatarMxc").takeIf { it.isNotEmpty() }
        val roomAvatarMxc = json.optString("roomAvatarMxc").takeIf { it.isNotEmpty() }

        // Render as a group only when we have a distinct room name (computed
        // up here because the avatar fallback below depends on it).
        val asGroup = !isDirect && !roomName.isNullOrEmpty() && roomName != senderName
        val senderAvatar = senderAvatarMxc?.let { loadMxcAvatar(it) }
        val roomAvatar = roomAvatarMxc?.let { loadMxcAvatar(it) }
        // For a DM the sender IS the room partner, so the DURABLE room avatar
        // (resolved hub-side from the chat-rooms snapshot) is a reliable
        // fallback when the volatile member cache has no sender avatar — which
        // is exactly the state after a hub restart, when incremental sync
        // carries no member state. Without it, DM notifications render
        // avatar-less (the symptom: plain cards vs Beeper's rich per-sender ones).
        val personBuilder = Person.Builder().setName(senderName).setKey(senderId)
        val effectiveSenderAvatar = senderAvatar ?: (if (!asGroup) roomAvatar else null)
        if (effectiveSenderAvatar != null) personBuilder.setIcon(IconCompat.createWithBitmap(effectiveSenderAvatar))
        val person = personBuilder.build()

        val room = roomStates.getOrPut(roomId) { RoomState() }
        room.roomName = roomName
        room.isDirect = isDirect
        room.history.addLast(ChatMessage(body, ts, person))
        while (room.history.size > ROOM_HISTORY_LIMIT) room.history.removeFirst()

        val now = System.currentTimeMillis()
        val shouldVibrate = now - room.lastVibrateMs >= VIBRATE_DEBOUNCE_MS
        if (shouldVibrate) room.lastVibrateMs = now

        // Self-person for MessagingStyle (left blank — we're "You" implicitly).
        val me = Person.Builder().setName("You").setKey("me").build()
        // DMs + un-named rooms → title=senderName (from Person), body=message
        // Named groups → title=roomName, body="Sender: message" (Beeper-style)
        val style = NotificationCompat.MessagingStyle(me)
            .setConversationTitle(if (asGroup) roomName else null)
            .setGroupConversation(asGroup)
        for (msg in room.history) {
            style.addMessage(NotificationCompat.MessagingStyle.Message(msg.text, msg.ts, msg.sender))
        }

        // Deep-link: go straight to the specific room.
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            action = Intent.ACTION_VIEW
            data = Uri.parse("console://pane/chat?roomId=${Uri.encode(roomId)}")
        }
        val notifId = roomId.hashCode()
        val pi = PendingIntent.getActivity(
            this, notifId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_CHAT)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setStyle(style)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setWhen(ts)
            .setShowWhen(true)
            .setGroup(CHAT_GROUP_KEY)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setOnlyAlertOnce(!shouldVibrate)
            .setSilent(!shouldVibrate)
            .setPriority(
                if (shouldVibrate) NotificationCompat.PRIORITY_HIGH
                else NotificationCompat.PRIORITY_LOW
            )
        // Large icon = the durable room avatar (group logo for named rooms,
        // partner avatar for DMs — both resolved hub-side from the chat-rooms
        // snapshot so they survive a restart), falling back to the sender's.
        val largeIcon = roomAvatar ?: senderAvatar
        if (largeIcon != null) builder.setLargeIcon(largeIcon)

        // ---- Actions: Reply (RemoteInput) + Mark as Read -----------------
        val replyIntent = Intent(this, NotificationActionReceiver::class.java).apply {
            action = NotificationActionReceiver.ACTION_CHAT_REPLY
            putExtra(NotificationActionReceiver.EXTRA_NOTIF_ID, notifId)
            putExtra(NotificationActionReceiver.EXTRA_ROOM_ID, roomId)
        }
        val replyPi = PendingIntent.getBroadcast(
            this, notifId, replyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val remoteInput = RemoteInput.Builder(NotificationActionReceiver.KEY_REPLY_TEXT)
            .setLabel("Reply")
            .build()
        val replyAction = NotificationCompat.Action.Builder(
            R.drawable.ic_launcher_foreground, "Reply", replyPi,
        )
            .addRemoteInput(remoteInput)
            .setAllowGeneratedReplies(true)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build()

        val readIntent = Intent(this, NotificationActionReceiver::class.java).apply {
            action = NotificationActionReceiver.ACTION_CHAT_READ
            putExtra(NotificationActionReceiver.EXTRA_NOTIF_ID, notifId)
            putExtra(NotificationActionReceiver.EXTRA_ROOM_ID, roomId)
        }
        val readPi = PendingIntent.getBroadcast(
            // Offset req code so it doesn't collide with the reply PI.
            this, notifId xor 0x1, readIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val readAction = NotificationCompat.Action.Builder(
            R.drawable.ic_launcher_foreground, "Mark as Read", readPi,
        )
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build()

        // Mute — sets a server-side room push rule (PUT /matrix/rooms/:id/mute).
        val muteIntent = Intent(this, NotificationActionReceiver::class.java).apply {
            action = NotificationActionReceiver.ACTION_CHAT_MUTE
            putExtra(NotificationActionReceiver.EXTRA_NOTIF_ID, notifId)
            putExtra(NotificationActionReceiver.EXTRA_ROOM_ID, roomId)
        }
        val mutePi = PendingIntent.getBroadcast(
            this, notifId xor 0x2, muteIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val muteAction = NotificationCompat.Action.Builder(
            R.drawable.ic_launcher_foreground, "Mute", mutePi,
        )
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MUTE)
            .setShowsUserInterface(false)
            .build()

        builder.addAction(replyAction).addAction(readAction).addAction(muteAction)

        val nm = NotificationManagerCompat.from(this)
        try {
            nm.notify(notifId, builder.build())
            // Summary for the group — required on older Android for bundling UI.
            val summary = NotificationCompat.Builder(this, CHANNEL_CHAT)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("Chat")
                .setGroup(CHAT_GROUP_KEY)
                .setGroupSummary(true)
                .setAutoCancel(true)
                .setSilent(true)
                .build()
            nm.notify(CHAT_SUMMARY_ID, summary)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS not granted; silently skip.
        }
    }

    /** Non-chat (mail, calendar, agent, money, generic) — simple notification. */
    private fun handleGenericPush(json: JSONObject, type: String) {
        val title = json.optString("title").takeIf { it.isNotEmpty() } ?: return
        val body = json.optString("body")
        val pane = json.optString("pane").takeIf { it.isNotEmpty() } ?: when (type) {
            "mail" -> "mail"
            "chat" -> "chat"
            "calendar" -> "calendar"
            "agent" -> "agents"
            "money" -> "money"
            else -> null
        }
        val idStr = json.optString("id").takeIf { it.isNotEmpty() } ?: "$title|$body"
        val notifId = idStr.hashCode()
        val channel = when (type) {
            "mail" -> CHANNEL_MAIL
            "chat" -> CHANNEL_CHAT
            "calendar" -> CHANNEL_CALENDAR
            "agent" -> CHANNEL_AGENT
            "money" -> CHANNEL_MONEY
            else -> CHANNEL_GENERIC
        }

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (pane != null) {
                action = Intent.ACTION_VIEW
                data = Uri.parse("console://pane/$pane")
            }
        }
        val pi = PendingIntent.getActivity(
            this, notifId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val nb = NotificationCompat.Builder(this, channel)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setPriority(
                if (channel == CHANNEL_AGENT || channel == CHANNEL_CHAT || channel == CHANNEL_CALENDAR)
                    NotificationCompat.PRIORITY_HIGH
                else NotificationCompat.PRIORITY_DEFAULT
            )

        val nm = NotificationManagerCompat.from(this)
        try {
            nm.notify(notifId, nb.build())
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS not granted; silently skip.
        }
    }

    // --- Avatar fetching ------------------------------------------------------

    /**
     * Fetch a Matrix avatar via the hub's thumbnail proxy and cache it.
     * Blocks the notification thread briefly (single HTTPS GET). Returns null
     * on any failure — the notification still renders without an avatar.
     */
    private fun loadMxcAvatar(mxc: String): Bitmap? {
        if (!mxc.startsWith("mxc://")) return null
        avatarCache[mxc]?.let { return it }
        val rest = mxc.substring(6)
        val slash = rest.indexOf('/')
        if (slash <= 0) return null
        val server = rest.substring(0, slash)
        val mediaId = rest.substring(slash + 1)
        val url = "$HUB_HTTPS/matrix/media/thumbnail/${Uri.encode(server)}/${Uri.encode(mediaId)}" +
            "?width=$AVATAR_PX&height=$AVATAR_PX&method=crop"
        return try {
            // Auth enforcement gates /hub/* — the thumbnail proxy lives there,
            // so attach the paired bearer (same token PushService uses for the
            // /push WS). Without it the GET 401s and the avatar silently drops.
            val reqB = Request.Builder().url(url)
            HubTokenStore.get()?.let { reqB.header("Authorization", "Bearer $it") }
            val req = reqB.build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val bytes = resp.body?.bytes() ?: return null
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
                val rounded = makeCircular(bitmap)
                avatarCache[mxc] = rounded
                rounded
            }
        } catch (_: Exception) {
            null
        }
    }

    /** Crop to a circle — Android renders MessagingStyle icons in a circle anyway, but
     *  setLargeIcon doesn't, and circle-clipping gives consistent look. */
    private fun makeCircular(src: Bitmap): Bitmap {
        val size = minOf(src.width, src.height)
        val x = (src.width - size) / 2
        val y = (src.height - size) / 2
        val square = if (x == 0 && y == 0 && src.width == src.height) src
                     else Bitmap.createBitmap(src, x, y, size, size)
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val path = Path().apply {
            addCircle(size / 2f, size / 2f, size / 2f, Path.Direction.CW)
        }
        canvas.clipPath(path)
        canvas.drawBitmap(square, 0f, 0f, Paint(Paint.ANTI_ALIAS_FLAG))
        return out
    }
}
