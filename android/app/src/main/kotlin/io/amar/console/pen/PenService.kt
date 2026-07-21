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
import io.amar.console.core.OngoingNotif
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

        fun start(ctx: Context, force: Boolean = false) {
            // Never paired a pen → don't run (and don't hold a notification).
            // `force` = settings first-time pairing (Scan needs BLE up).
            if (!force && PairStore(ctx).load() == null) return
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
        // Detach from the SHARED notification instead of removing it — the
        // other foreground services still own the row.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_DETACH)
        OngoingNotif.line("pen", null)
        OngoingNotif.update(this)
        PenState.removeListener(stateListener)
        super.onDestroy()
    }


    /** Line for the SHARED Console notification; null while disconnected. */
    private fun ongoingText(): String? {
        if (PenState.status != PenState.Status.CONNECTED) return null
        val battery = PenState.battery?.let { " $it%" } ?: ""
        val lock = if (PenState.locked && !PenState.authorized) " (locked)" else ""
        return "pen$battery$lock"
    }

    private fun startForegroundCompat() {
        OngoingNotif.line("pen", ongoingText())
        val notif = OngoingNotif.build(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(OngoingNotif.ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(OngoingNotif.ID, notif)
        }
    }

    private fun updateOngoing() {
        OngoingNotif.line("pen", ongoingText())
        OngoingNotif.update(this)
    }

    private fun ensureChannel() = OngoingNotif.ensureChannel(this)
}
