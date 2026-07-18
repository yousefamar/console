package io.amar.console.core

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import io.amar.console.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * In-app update channel — ported from the WebView MainActivity. Polls
 * `<publicOrigin>/public/apk/latest.json`, exposes the available update as a
 * StateFlow for the Compose shell banner, downloads via DownloadManager and
 * fires the package-installer intent.
 */
object Updater {
    data class Available(val versionCode: Int, val versionName: String, val url: String)

    private val _available = MutableStateFlow<Available?>(null)
    val available: StateFlow<Available?> = _available

    suspend fun check() = withContext(Dispatchers.IO) {
        try {
            val url = URL("${HubConfig.publicOrigin}/public/apk/latest.json")
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 5_000
            conn.readTimeout = 5_000
            if (conn.responseCode != 200) return@withContext
            val body = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
            val json = JSONObject(body)
            val remoteCode = json.optInt("versionCode", -1)
            val remoteUrl = json.optString("url", "")
            if (remoteCode > BuildConfig.VERSION_CODE && remoteUrl.isNotEmpty()) {
                _available.value = Available(remoteCode, json.optString("versionName", ""), remoteUrl)
            }
        } catch (_: Exception) { /* offline / no release */ }
    }

    fun dismiss() {
        _available.value = null
    }

    fun downloadAndInstall(context: Context, apkUrl: String) {
        // latest.json carries `url: /apk/console-N.apk` (the hub-side format
        // dating back to the pre-public era). Rewrite to /public/apk so the
        // download works once the hub binds 127.0.0.1 and only Caddy's
        // /public/* route reaches the apk handler.
        val publicPath = apkUrl.replace(Regex("^/apk/"), "/public/apk/")
        val fullUrl = if (publicPath.startsWith("http")) publicPath else "${HubConfig.publicOrigin}$publicPath"
        try {
            val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val req = DownloadManager.Request(Uri.parse(fullUrl))
                .setTitle("Console update")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, "console-update.apk")
            val id = dm.enqueue(req)
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context, intent: Intent) {
                    val finishedId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                    if (finishedId == id) {
                        ctx.unregisterReceiver(this)
                        val uri = dm.getUriForDownloadedFile(id) ?: return
                        val install = Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(uri, "application/vnd.android.package-archive")
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
                        }
                        try { ctx.startActivity(install) } catch (_: Exception) { /* no installer */ }
                    }
                }
            }
            val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                context.registerReceiver(receiver, filter)
            }
        } catch (_: Exception) { /* silent */ }
    }
}
