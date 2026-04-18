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
import androidx.core.graphics.drawable.IconCompat
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

        private const val PUSH_URL = "wss://amarhp-lin.rya-yo.ts.net:9877/push"
        private const val HUB_HTTPS = "https://amarhp-lin.rya-yo.ts.net:9877"
        private const val RECONNECT_MIN_MS = 2_000L
        private const val RECONNECT_MAX_MS = 60_000L
        private const val VIBRATE_DEBOUNCE_MS = 60_000L
        private const val AVATAR_PX = 128
        /** Keep the last N messages rendered in a per-room MessagingStyle stack. */
        private const val ROOM_HISTORY_LIMIT = 8

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

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannels()
        startForegroundCompat()
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
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
        if (type == "chat") {
            handleChatPush(json)
            return
        }
        handleGenericPush(json, type)
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
        val style = NotificationCompat.MessagingStyle(me)
            .setConversationTitle(if (!isDirect) (roomName ?: senderName) else null)
            .setGroupConversation(!isDirect)
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

        val notif: Notification = NotificationCompat.Builder(this, channel)
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
            .build()

        val nm = NotificationManagerCompat.from(this)
        try {
            nm.notify(notifId, notif)
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
