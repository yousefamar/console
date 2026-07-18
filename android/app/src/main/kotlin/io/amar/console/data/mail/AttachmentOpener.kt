package io.amar.console.data.mail

import android.content.Context
import android.content.Intent
import android.util.Base64
import android.widget.Toast
import androidx.core.content.FileProvider
import io.amar.console.core.HubClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

/**
 * Downloads a Gmail attachment via the hub (base64 body from
 * GET /mail/messages/:mid/attachments/:aid) into cacheDir and fires ACTION_VIEW
 * through FileProvider. Cached files are reused (offline re-open works).
 */
object AttachmentOpener {
    private val json = Json { ignoreUnknownKeys = true }
    private val scope = CoroutineScope(Dispatchers.IO)

    fun open(context: Context, messageId: String, attachmentId: String, filename: String) {
        val appCtx = context.applicationContext
        scope.launch {
            try {
                val dir = File(appCtx.cacheDir, "mail-attachments").apply { mkdirs() }
                val safe = filename.replace(Regex("[^A-Za-z0-9._-]"), "_")
                val file = File(dir, "${attachmentId.take(16).replace('/', '_')}-$safe")
                if (!file.exists()) {
                    val hub = HubClient()
                    val resp = hub.get(
                        "/mail/messages/${java.net.URLEncoder.encode(messageId, "UTF-8")}/attachments/${java.net.URLEncoder.encode(attachmentId, "UTF-8")}"
                    )
                    val data = json.parseToJsonElement(resp).jsonObject["data"]?.jsonPrimitive?.content
                        ?: throw IllegalStateException("no data")
                    // Gmail uses URL-safe base64.
                    file.writeBytes(Base64.decode(data, Base64.URL_SAFE))
                }
                val uri = FileProvider.getUriForFile(appCtx, "${appCtx.packageName}.files", file)
                val mime = appCtx.contentResolver.getType(uri)
                    ?: android.webkit.MimeTypeMap.getSingleton()
                        .getMimeTypeFromExtension(file.extension.lowercase())
                    ?: "application/octet-stream"
                withContext(Dispatchers.Main) {
                    val intent = Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, mime)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    runCatching { appCtx.startActivity(intent) }
                        .onFailure {
                            Toast.makeText(appCtx, "No app can open $filename", Toast.LENGTH_SHORT).show()
                        }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(appCtx, "Download failed: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }
}
