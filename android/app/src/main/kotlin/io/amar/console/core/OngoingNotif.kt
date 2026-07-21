package io.amar.console.core

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.amar.console.MainActivity
import io.amar.console.R
import java.util.concurrent.ConcurrentHashMap

/**
 * ONE persistent notification for all three foreground services (Push,
 * Glasses, Pen). Android lets multiple FGS share a notification id — each
 * service calls startForeground(ID, build(ctx), itsType) and contributes a
 * status line here; the row reads "Console · <lines>". A service stopping
 * uses STOP_FOREGROUND_DETACH + [update] so survivors keep the row alive.
 * Idle/uninteresting states contribute NO line (null) to keep the text quiet.
 */
object OngoingNotif {
    const val ID = 1
    const val CHANNEL = "ongoing"

    private val lines = ConcurrentHashMap<String, String>()

    /** Set (or clear with null) the status line for [key] ∈ push|glasses|pen. */
    fun line(key: String, text: String?) {
        if (text.isNullOrBlank()) lines.remove(key) else lines[key] = text
    }

    fun build(ctx: Context): Notification {
        val pi = PendingIntent.getActivity(
            ctx, 0, Intent(ctx, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val text = listOfNotNull(lines["push"], lines["glasses"], lines["pen"])
            .joinToString(" · ").ifEmpty { "Connected" }
        return NotificationCompat.Builder(ctx, CHANNEL)
            .setContentTitle("Console")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(pi)
            .build()
    }

    /** Refresh the shared row in place (listener callbacks, service stop). */
    fun update(ctx: Context) {
        try {
            NotificationManagerCompat.from(ctx).notify(ID, build(ctx))
        } catch (_: SecurityException) { /* POST_NOTIFICATIONS not granted */ }
    }

    fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Console connection", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Persistent notification keeping Console's connections alive"
                setShowBadge(false)
            },
        )
    }
}
