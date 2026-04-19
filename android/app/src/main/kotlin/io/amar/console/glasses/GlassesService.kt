package io.amar.console.glasses

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.amar.console.MainActivity
import io.amar.console.R

/**
 * Foreground service that owns the BLE link to the user's G1 glasses.
 *
 * Sibling to [io.amar.console.PushService]. Both run in the same process, so
 * they share memory (via [GlassesState] / [GlassesController]) without any
 * IPC. They're kept as separate services because Android 14+ requires a
 * declared `foregroundServiceType` per service, and push is `dataSync` while
 * BLE is `connectedDevice`.
 *
 * The service itself is minimal — it just ensures the process stays alive
 * (via the ongoing notification) and delegates all work to
 * [GlassesController], which holds the [BleManager] singleton.
 */
class GlassesService : Service() {

    companion object {
        const val ONGOING_NOTIFICATION_ID = 2
        const val CHANNEL_ONGOING = "glasses_ongoing"

        fun start(ctx: Context) {
            val i = Intent(ctx, GlassesService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i)
            } else {
                ctx.startService(i)
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, GlassesService::class.java))
        }
    }

    private val stateListener: () -> Unit = { updateOngoing() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        startForegroundCompat()
        GlassesController.init(this)
        // Refresh the ongoing notification text whenever connection state or
        // battery changes. Cheap — NotificationManager.notify() is a one-way IPC.
        GlassesState.addListener(stateListener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        GlassesState.removeListener(stateListener)
        // The BLE link is intentionally NOT torn down here — the process
        // usually keeps running past onDestroy for other reasons (WebView,
        // PushService). If the process actually dies, the OS cleans up
        // GATT sockets for us. If we torn down here, a transient stop
        // would cost us the connection.
        super.onDestroy()
    }

    private fun buildOngoingNotification(): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val text = ongoingText()
        return NotificationCompat.Builder(this, CHANNEL_ONGOING)
            .setContentTitle("Console glasses")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(pi)
            // Group with PushService's ongoing so they collapse to one row.
            .setGroup("console.ongoing")
            .build()
    }

    private fun ongoingText(): String {
        if (!GlassesState.connected) {
            // Partial / no link — useful during reconnect.
            val l = GlassesState.leftStatus.name.lowercase()
            val r = GlassesState.rightStatus.name.lowercase()
            if (l == "disconnected" && r == "disconnected") return "Glasses idle"
            return "Linking… L=$l R=$r"
        }
        val lB = GlassesState.batteryLeft
        val rB = GlassesState.batteryRight
        val battery = when {
            lB != null && rB != null -> " · L ${lB}% / R ${rB}%"
            lB != null -> " · L ${lB}%"
            rB != null -> " · R ${rB}%"
            else -> ""
        }
        val ch = GlassesState.channel?.let { " · ch $it" } ?: ""
        return "Linked to G1$battery$ch"
    }

    private fun startForegroundCompat() {
        val notif = buildOngoingNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                ONGOING_NOTIFICATION_ID, notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(ONGOING_NOTIFICATION_ID, notif)
        }
    }

    private fun updateOngoing() {
        try {
            NotificationManagerCompat.from(this).notify(
                ONGOING_NOTIFICATION_ID, buildOngoingNotification(),
            )
        } catch (_: SecurityException) { /* POST_NOTIFICATIONS not granted */ }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ONGOING, "Glasses link", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Persistent notification while Console is linked to your G1 glasses"
                setShowBadge(false)
            },
        )
    }
}
