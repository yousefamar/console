package io.amar.console.ui.longtail

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import io.amar.console.core.HubClient
import io.amar.console.core.HubConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

private val json = Json { ignoreUnknownKeys = true }

private data class ShareRow(
    val kind: String, // tab | island
    val slug: String,
    val title: String,
    val agent: String?,
    val publishUrl: String?,
)

/**
 * Lists every canvas tab + island; each row toggles a public share URL via
 * /dashboard/canvas/{tabs,islands}/<slug>/publish. Mirrors the SPA
 * CanvasShareMenu. Online-only (needs the hub).
 */
@Composable
fun CanvasShareMenu(onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val hub = remember { HubClient() }
    var rows by remember { mutableStateOf<List<ShareRow>?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf<String?>(null) }

    suspend fun reload() {
        error = null
        runCatching {
            val tabsRaw = hub.get("/dashboard/canvas/tabs")
            val islandsRaw = hub.get("/dashboard/canvas/islands")
            val out = mutableListOf<ShareRow>()
            for (t in parseSlugs(tabsRaw, "tabs")) out.add(fetchRow(hub, "tab", t))
            for (i in parseSlugs(islandsRaw, "islands")) out.add(fetchRow(hub, "island", i))
            rows = out
        }.onFailure { error = it.message }
    }

    LaunchedEffect(Unit) { reload() }

    Dialog(onDismissRequest = onClose) {
        Surface(shape = RoundedCornerShape(10.dp), tonalElevation = 4.dp) {
            Column(Modifier.fillMaxWidth().heightIn(max = 520.dp).padding(12.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(Icons.Filled.Share, null, modifier = Modifier.size(15.dp))
                        Text("Canvas share", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
                    }
                    TextButton(onClick = onClose) { Text("Close") }
                }
                Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                    when {
                        rows == null -> Text("Loading…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp))
                        rows!!.isEmpty() -> Text("No tabs or islands yet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp))
                        else -> for (row in rows!!) {
                            val key = "${row.kind}:${row.slug}"
                            Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(1f)) {
                                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                            Text(row.kind.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                            Text(row.title, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        }
                                        row.agent?.let { Text("by $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                    }
                                    TextButton(
                                        enabled = busy != key,
                                        onClick = {
                                            busy = key
                                            scope.launch {
                                                error = null
                                                val base = if (row.kind == "tab") "/dashboard/canvas/tabs" else "/dashboard/canvas/islands"
                                                val url = "$base/${enc(row.slug)}/publish"
                                                runCatching {
                                                    if (row.publishUrl != null) hub.delete(url) else hub.post(url)
                                                }.onFailure { error = it.message }
                                                reload()
                                                busy = null
                                            }
                                        },
                                    ) {
                                        Text(
                                            if (busy == key) "…" else if (row.publishUrl != null) "Unpublish" else "Publish",
                                            color = if (row.publishUrl != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                                        )
                                    }
                                }
                                row.publishUrl?.let { pub ->
                                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                        OutlinedTextField(
                                            value = pub, onValueChange = {}, readOnly = true, singleLine = true,
                                            textStyle = MaterialTheme.typography.labelSmall,
                                            modifier = Modifier.weight(1f),
                                        )
                                        IconButton(onClick = { copyToClipboard(ctx, pub); copied = key }, modifier = Modifier.size(28.dp)) {
                                            Icon(if (copied == key) Icons.Filled.Check else Icons.Filled.ContentCopy, "Copy URL", modifier = Modifier.size(15.dp), tint = if (copied == key) Color(0xFF4ADE80) else MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                error?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 4.dp)) }
                Text(
                    "Published URLs need no login — anyone with the link can view that single tab/island.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}

private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

/** Parse {tabs:[{slug,meta}]} / {islands:[...]} → list of (slug,title,agent). */
private fun parseSlugs(raw: String, key: String): List<Triple<String, String, String?>> {
    val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return emptyList()
    val arr = obj[key] as? JsonArray ?: return emptyList()
    return arr.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        val slug = o["slug"]?.jsonPrimitive?.content ?: return@mapNotNull null
        val meta = o["meta"] as? JsonObject
        Triple(slug, meta?.get("title")?.jsonPrimitive?.content ?: slug, meta?.get("agent")?.jsonPrimitive?.content)
    }
}

/** GET the current publish URL for one slug (404 → not published). */
private suspend fun fetchRow(hub: HubClient, kind: String, t: Triple<String, String, String?>): ShareRow {
    val base = if (kind == "tab") "/dashboard/canvas/tabs" else "/dashboard/canvas/islands"
    val url = withContext(Dispatchers.IO) {
        runCatching {
            val resp = hub.get("$base/${enc(t.first)}/publish")
            (json.parseToJsonElement(resp) as? JsonObject)?.get("url")?.jsonPrimitive?.content
        }.getOrNull()
    }
    return ShareRow(kind, t.first, t.second, t.third, url)
}

private fun copyToClipboard(ctx: Context, text: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    cm.setPrimaryClip(ClipData.newPlainText("canvas URL", text))
}
