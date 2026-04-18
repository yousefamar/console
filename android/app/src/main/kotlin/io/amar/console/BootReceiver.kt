package io.amar.console

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restarts the push WebSocket service after device reboot or app upgrade
 * so notifications keep flowing without the user having to open the app.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                PushService.start(context)
            }
        }
    }
}
