package io.amar.console

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Foreground service holding a persistent WebSocket to the hub's `/push`
 * endpoint. When the APK is backgrounded the WebView freezes, so the web
 * app's Notification API and in-app toasts go silent. This service stays
 * alive (required by Android: foreground service + persistent notification)
 * and translates hub pushes into system notifications.
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

        private const val PUSH_URL = "wss://amarhp-lin.rya-yo.ts.net:9877/push"
        private const val RECONNECT_MIN_MS = 2_000L
        private const val RECONNECT_MAX_MS = 60_000L

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
        // Ignore protocol frames; real notifications have title+body.
        val type = json.optString("type")
        if (type == "hello") return

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
        val idStr = json.optString("id").takeIf { it.isNotEmpty() }
            ?: "$title|$body"
        val notifId = idStr.hashCode()

        val channel = when (type) {
            "mail" -> CHANNEL_MAIL
            "chat" -> CHANNEL_CHAT
            "calendar" -> CHANNEL_CALENDAR
            "agent" -> CHANNEL_AGENT
            "money" -> CHANNEL_MONEY
            else -> CHANNEL_GENERIC
        }

        val deepLink = if (pane != null) Uri.parse("console://pane/$pane") else null
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (deepLink != null) {
                action = Intent.ACTION_VIEW
                data = deepLink
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
            // POST_NOTIFICATIONS not granted on Android 13+; silently skip.
        }
    }
}
