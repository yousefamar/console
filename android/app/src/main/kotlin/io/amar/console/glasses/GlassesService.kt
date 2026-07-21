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
import io.amar.console.core.OngoingNotif
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

        fun start(ctx: Context, force: Boolean = false) {
            // No pair on record → nothing to link; don't burn a permanent
            // notification slot on an idle service. `force` is the settings
            // screen's first-time pairing path (Scan needs the BLE manager).
            if (!force && PairStore(ctx).load() == null) return
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
        // Detach from the SHARED notification instead of removing it — the
        // other foreground services still own the row.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_DETACH)
        OngoingNotif.line("glasses", null)
        OngoingNotif.update(this)
        GlassesState.removeListener(stateListener)
        // The BLE link is intentionally NOT torn down here — the process
        // usually keeps running past onDestroy for other reasons (WebView,
        // PushService). If the process actually dies, the OS cleans up
        // GATT sockets for us. If we torn down here, a transient stop
        // would cost us the connection.
        super.onDestroy()
    }

    /** Status line contributed to the SHARED Console notification — null
     *  (no line) while idle so the row stays quiet. */
    private fun ongoingText(): String? {
        if (!GlassesState.connected) {
            val l = GlassesState.leftStatus.name.lowercase()
            val r = GlassesState.rightStatus.name.lowercase()
            if (l == "disconnected" && r == "disconnected") return null
            return "glasses linking…"
        }
        val lB = GlassesState.batteryLeft
        val rB = GlassesState.batteryRight
        val battery = when {
            lB != null && rB != null -> " ${minOf(lB, rB)}%"
            else -> ""
        }
        return "G1$battery"
    }

    private fun startForegroundCompat() {
        OngoingNotif.line("glasses", ongoingText())
        val notif = OngoingNotif.build(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                OngoingNotif.ID, notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(OngoingNotif.ID, notif)
        }
    }

    private fun updateOngoing() {
        OngoingNotif.line("glasses", ongoingText())
        OngoingNotif.update(this)
    }

    private fun ensureChannel() = OngoingNotif.ensureChannel(this)
}
