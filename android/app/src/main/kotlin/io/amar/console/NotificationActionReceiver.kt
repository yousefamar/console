package io.amar.console

import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Handles tap-through actions on push notifications: Mark as Read, Reply
 * (with RemoteInput), Archive. Posts to the hub over HTTPS and cancels the
 * original notification on success.
 *
 * BroadcastReceivers are short-lived (~10s ceiling), so we call `goAsync()`
 * and do the HTTP on a worker thread. The OkHttp client here is ad-hoc —
 * PushService's client lives in a different process-less lifecycle so we
 * build a fresh one each time. Actions fire rarely, overhead is negligible.
 */
class NotificationActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_CHAT_READ = "io.amar.console.action.CHAT_READ"
        const val ACTION_CHAT_REPLY = "io.amar.console.action.CHAT_REPLY"
        const val ACTION_CHAT_MUTE = "io.amar.console.action.CHAT_MUTE"
        const val ACTION_MAIL_ARCHIVE = "io.amar.console.action.MAIL_ARCHIVE"
        const val ACTION_MAIL_READ = "io.amar.console.action.MAIL_READ"

        const val EXTRA_NOTIF_ID = "notifId"
        const val EXTRA_ROOM_ID = "roomId"
        const val EXTRA_ACCOUNT = "account"
        const val EXTRA_THREAD_IDS = "threadIds"
        const val KEY_REPLY_TEXT = "replyText"

        private val HUB_HTTPS: String get() = io.amar.console.core.HubConfig.hubBase
        private const val TAG = "NotifAction"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val notifId = intent.getIntExtra(EXTRA_NOTIF_ID, -1)
        val pending = goAsync()
        val appCtx = context.applicationContext
        // The receiver can run in a fresh process where the token store was
        // never initialised; init is idempotent + cheap.
        HubTokenStore.init(appCtx)
        io.amar.console.core.HubConfig.init(appCtx)

        Thread {
            try {
                val ok = when (action) {
                    ACTION_CHAT_READ -> {
                        val roomId = intent.getStringExtra(EXTRA_ROOM_ID) ?: return@Thread
                        post("/matrix/rooms/${enc(roomId)}/read", "{}")
                    }
                    ACTION_CHAT_MUTE -> {
                        val roomId = intent.getStringExtra(EXTRA_ROOM_ID) ?: return@Thread
                        req("PUT", "/matrix/rooms/${enc(roomId)}/mute", "{}")
                    }
                    ACTION_CHAT_REPLY -> {
                        val roomId = intent.getStringExtra(EXTRA_ROOM_ID) ?: return@Thread
                        val replyText = RemoteInput.getResultsFromIntent(intent)
                            ?.getCharSequence(KEY_REPLY_TEXT)
                            ?.toString()
                            ?.trim()
                            .orEmpty()
                        if (replyText.isEmpty()) return@Thread
                        val body = JSONObject().put("body", replyText).toString()
                        // Plain send — for encrypted rooms the bridge/hub-crypto
                        // path should be used instead, but for v1 this is the
                        // simplest wiring. Users with mostly-encrypted rooms
                        // should fall back to opening the app.
                        post("/matrix/rooms/${enc(roomId)}/send", body)
                    }
                    ACTION_MAIL_ARCHIVE, ACTION_MAIL_READ -> {
                        val account = intent.getStringExtra(EXTRA_ACCOUNT) ?: return@Thread
                        val threadIds = intent.getStringArrayExtra(EXTRA_THREAD_IDS) ?: return@Thread
                        val op = if (action == ACTION_MAIL_ARCHIVE) "archive" else "read"
                        var allOk = true
                        for (tid in threadIds) {
                            val ok = post(
                                "/mail/threads/${enc(tid)}/$op?account=${enc(account)}",
                                "{}",
                            )
                            if (!ok) allOk = false
                        }
                        allOk
                    }
                    else -> false
                }
                if (ok && notifId >= 0) {
                    NotificationManagerCompat.from(appCtx).cancel(notifId)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "action $action failed: ${t.message}")
            } finally {
                pending.finish()
            }
        }.start()
    }

    private fun post(path: String, jsonBody: String): Boolean = req("POST", path, jsonBody)

    /** Hub HTTP call with the paired bearer. The hub prefix is auth-gated, so
     *  without the Authorization header every action 401s and silently no-ops. */
    private fun req(method: String, path: String, jsonBody: String): Boolean {
        val client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
        val body = jsonBody.toRequestBody("application/json".toMediaType())
        val rb = Request.Builder().url("$HUB_HTTPS$path").method(method, body)
        HubTokenStore.get()?.let { rb.header("Authorization", "Bearer $it") }
        return try {
            client.newCall(rb.build()).execute().use { resp -> resp.isSuccessful }
        } catch (t: Throwable) {
            Log.w(TAG, "$method $path failed: ${t.message}")
            false
        }
    }

    private fun enc(s: String): String = android.net.Uri.encode(s)
}
