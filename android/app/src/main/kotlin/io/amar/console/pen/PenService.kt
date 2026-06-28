package io.amar.console.pen

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
 * Foreground service owning the BLE link to the Neo smartpen. Sibling to
 * PushService + GlassesService; same process, shares memory via PenState /
 * PenController. Service type connectedDevice (Android 14+ requires a declared
 * type per service). Minimal — keeps the process alive and delegates to
 * PenController which holds the PenBleManager singleton.
 */
class PenService : Service() {

    companion object {
        const val ONGOING_NOTIFICATION_ID = 3
        const val CHANNEL_ONGOING = "pen_ongoing"

        fun start(ctx: Context) {
            val i = Intent(ctx, PenService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, PenService::class.java)) }
    }

    private val stateListener: () -> Unit = { updateOngoing() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        startForegroundCompat()
        PenController.init(this)
        PenState.addListener(stateListener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        PenState.removeListener(stateListener)
        super.onDestroy()
    }

    private fun buildOngoingNotification(): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ONGOING)
            .setContentTitle("Console pen")
            .setContentText(ongoingText())
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(pi)
            .setGroup("console.ongoing")
            .build()
    }

    private fun ongoingText(): String {
        if (PenState.status != PenState.Status.CONNECTED) return "Pen ${PenState.status.name.lowercase()}"
        val battery = PenState.battery?.let { " · $it%" } ?: ""
        val lock = if (PenState.locked && !PenState.authorized) " · locked" else ""
        return "Pen linked$battery$lock"
    }

    private fun startForegroundCompat() {
        val notif = buildOngoingNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(ONGOING_NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(ONGOING_NOTIFICATION_ID, notif)
        }
    }

    private fun updateOngoing() {
        try {
            NotificationManagerCompat.from(this).notify(ONGOING_NOTIFICATION_ID, buildOngoingNotification())
        } catch (_: SecurityException) { /* POST_NOTIFICATIONS not granted */ }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ONGOING, "Pen link", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Persistent notification while Console is linked to your smartpen"
                setShowBadge(false)
            },
        )
    }
}
