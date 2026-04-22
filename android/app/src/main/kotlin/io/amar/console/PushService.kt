package io.amar.console

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
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
import io.amar.console.glasses.GlassesState
import okhttp3.OkHttpClient
import okhttp3.Request
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

        private const val PUSH_URL = "wss://amarhp-lin.rya-yo.ts.net:9877/push"
        private const val HUB_HTTPS = "https://amarhp-lin.rya-yo.ts.net:9877"
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

    /** Listener that streams GlassesState snapshots to the hub on every change. */
    private val glassesListener: () -> Unit = {
        val ws = webSocket
        if (ws != null) {
            try {
                val frame = JSONObject()
                    .put("type", "glasses_state")
                    .put("state", GlassesState.toJson())
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
        ensureChannels()
        startForegroundCompat()
        connect()
        // Keep the hub's cached state in sync with BLE reality.
        GlassesState.addListener(glassesListener)
        // Forward BLE audio + touch to the hub. BleManager may not be ready
        // yet (GlassesService starts async); poll until it is.
        attachBleListener()
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

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        GlassesState.removeListener(glassesListener)
        if (GlassesController.isReady()) {
            try { GlassesController.requireBle().removeListener(bleListener) } catch (_: Throwable) {}
        }
        reconnectHandler.removeCallbacksAndMessages(null)
        try { webSocket?.close(1000, "shutdown") } catch (_: Exception) {}
        webSocket = null
        super.onDestroy()
    }

    // --- Foreground + channels -----------------------------------------------

    private fun startForegroundCompat() {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notif = NotificationCompat.Builder(this, CHANNEL_ONGOING)
            .setContentTitle("Console")
            .setContentText("Connected")
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(pi)
            // Group with GlassesService's ongoing notification so the
            // status shade shows them collapsed as one row.
            .setGroup("console.ongoing")
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                ONGOING_NOTIFICATION_ID, notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
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
        val req = Request.Builder().url(PUSH_URL).build()
        webSocket = client.newWebSocket(req, listener)
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
                    .put("state", GlassesState.toJson())
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
            scheduleReconnect()
        }
        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
            webSocket = null
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
        try {
            if (!GlassesController.isReady()) {
                replyRpcError(id, "glasses controller not initialized")
                return
            }
            when (method) {
                "status" -> replyRpc(id, GlassesState.toJson())
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
                    val payload = JSONObject()
                        .put("app_identifier", params.optString("appIdentifier", "com.console"))
                        .put("title", params.optString("title"))
                        .put("subtitle", params.optString("subtitle"))
                        .put("message", params.optString("message"))
                        .put("time_s", (params.optLong("timestamp", System.currentTimeMillis()) / 1000))
                        .put("display_name", params.optString("appIdentifier", "Console"))
                    val msgId = (System.currentTimeMillis() and 0xFF).toInt()
                    GlassesController.sendNotification(msgId, payload.toString())
                    replyRpc(id, JSONObject().put("ok", true))
                }
                "setMic" -> {
                    GlassesController.setMic(params.optBoolean("active", false))
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

        val personBuilder = Person.Builder().setName(senderName).setKey(senderId)
        val avatar = senderAvatarMxc?.let { loadMxcAvatar(it) }
        if (avatar != null) personBuilder.setIcon(IconCompat.createWithBitmap(avatar))
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
        // Render as a group only when we actually have a distinct room name.
        // DMs + un-named rooms → title=senderName (from Person), body=message
        // Named groups → title=roomName, body="Sender: message" (Beeper-style)
        val asGroup = !isDirect && !roomName.isNullOrEmpty() && roomName != senderName
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
        if (avatar != null) builder.setLargeIcon(avatar)

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

        builder.addAction(replyAction).addAction(readAction)

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
            val req = Request.Builder().url(url).build()
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
