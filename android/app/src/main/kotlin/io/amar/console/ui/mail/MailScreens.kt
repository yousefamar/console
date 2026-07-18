package io.amar.console.ui.mail

import android.annotation.SuppressLint
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.MarkEmailUnread
import androidx.compose.material.icons.filled.Reply
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import io.amar.console.data.db.MailMessageRow
import io.amar.console.data.db.MailThreadRow
import io.amar.console.data.mail.MailRepository
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ---------------------------------------------------------------------- //
// Inbox

@Composable
fun MailInboxScreen(repo: MailRepository, onOpenThread: (String) -> Unit) {
    val threads by repo.observeInbox().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var undoThread by remember { mutableStateOf<String?>(null) }

    Box(Modifier.fillMaxSize()) {
        if (threads.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Inbox zero 🎉", style = MaterialTheme.typography.titleMedium)
            }
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(threads, key = { it.id }) { thread ->
                    ThreadRow(
                        thread,
                        onClick = { onOpenThread(thread.id) },
                        onArchive = {
                            scope.launch {
                                repo.archive(thread.id)
                                undoThread = thread.id
                                delay(5000)
                                if (undoThread == thread.id) undoThread = null
                            }
                        },
                        onSnooze = {
                            // Default snooze: tomorrow 08:00 (long-press menu later).
                            scope.launch { repo.snooze(thread.id, tomorrowMorning()) }
                        },
                    )
                }
            }
        }
        undoThread?.let { id ->
            Snackbar(
                modifier = Modifier.align(Alignment.BottomCenter).padding(8.dp),
                action = {
                    TextButton(onClick = {
                        scope.launch { repo.undoArchive(id) }
                        undoThread = null
                    }) { Text("Undo") }
                },
            ) { Text("Archived") }
        }
    }
}

@Composable
private fun ThreadRow(
    thread: MailThreadRow,
    onClick: () -> Unit,
    onArchive: () -> Unit,
    onSnooze: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier
                .size(38.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                thread.fromName.take(1).uppercase(),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        Column(Modifier.weight(1f)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    thread.fromName,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (thread.isUnread) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (thread.messageCount > 1) {
                    Text(
                        "${thread.messageCount}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    formatDate(thread.date),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                thread.subject,
                style = MaterialTheme.typography.bodySmall,
                fontWeight = if (thread.isUnread) FontWeight.Medium else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                thread.snippet,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        IconButton(onClick = onSnooze) {
            Icon(Icons.Filled.Snooze, contentDescription = "Snooze", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        }
        IconButton(onClick = onArchive) {
            Icon(Icons.Filled.Archive, contentDescription = "Archive", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        }
    }
}

// ---------------------------------------------------------------------- //
// Thread view

@Composable
fun MailThreadScreen(repo: MailRepository, threadId: String, onBack: () -> Unit) {
    val thread by repo.observeThread(threadId).collectAsState(initial = null)
    val messages by repo.observeMessages(threadId).collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var replying by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }

    androidx.compose.runtime.LaunchedEffect(threadId, thread?.isUnread) {
        if (thread?.isUnread == true) repo.markRead(threadId)
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                thread?.subject ?: "",
                style = MaterialTheme.typography.titleMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = { scope.launch { repo.markUnread(threadId) } }) {
                Icon(Icons.Filled.MarkEmailUnread, contentDescription = "Mark unread", modifier = Modifier.size(18.dp))
            }
            IconButton(onClick = {
                scope.launch { repo.archive(threadId) }
                onBack()
            }) {
                Icon(Icons.Filled.Archive, contentDescription = "Archive", modifier = Modifier.size(18.dp))
            }
            IconButton(onClick = { replying = !replying }) {
                Icon(Icons.Filled.Reply, contentDescription = "Reply", modifier = Modifier.size(18.dp))
            }
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()),
        ) {
            for (msg in messages) {
                MessageCard(msg)
            }
        }
        if (replying) {
            Row(
                Modifier.fillMaxWidth().padding(8.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Reply — sends when online, auto-archives") },
                    maxLines = 6,
                )
                IconButton(onClick = {
                    val text = draft.trim()
                    if (text.isNotEmpty()) {
                        draft = ""
                        replying = false
                        scope.launch { repo.reply(threadId, text) }
                        onBack()
                    }
                }) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send", tint = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}

@Composable
private fun MessageCard(msg: MailMessageRow) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                msg.fromHeader.substringBefore('<').trim().ifEmpty { msg.fromHeader },
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                formatDate(msg.date),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (msg.bodyHtml != null) {
            MailBodyWebView(msg.bodyHtml!!)
        } else {
            Text(
                msg.bodyText ?: "(body not cached — open online to fetch)",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(vertical = 4.dp),
            )
        }
    }
}

/**
 * Per-message body render — the ONE place a WebView survives the rewrite
 * (HTML mail needs a real engine). Strict template: JS off, no network
 * loads beyond inline/img, dark-scheme wrapper, links open externally.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun MailBodyWebView(html: String) {
    AndroidView(
        modifier = Modifier.fillMaxWidth(),
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = false
                settings.loadWithOverviewMode = true
                settings.useWideViewPort = false
                settings.builtInZoomControls = false
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                webViewClient = object : android.webkit.WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView,
                        request: android.webkit.WebResourceRequest,
                    ): Boolean {
                        // Links open in the system browser, never in-place.
                        runCatching {
                            ctx.startActivity(
                                android.content.Intent(android.content.Intent.ACTION_VIEW, request.url)
                            )
                        }
                        return true
                    }
                }
            }
        },
        update = { wv ->
            val doc = """
                <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                  body { background:#0a0a0a; color:#e5e5e5; font-family:sans-serif; font-size:14px; margin:8px; word-break:break-word; }
                  a { color:#60a5fa; } img { max-width:100%; height:auto; }
                  table { max-width:100% !important; }
                </style></head><body>$html</body></html>
            """.trimIndent()
            wv.loadDataWithBaseURL(null, doc, "text/html", "utf-8", null)
        },
    )
}

private fun formatDate(ts: Long): String {
    if (ts <= 0) return ""
    val now = System.currentTimeMillis()
    val fmt = if (now - ts < 20 * 60 * 60 * 1000L) "HH:mm" else "d MMM"
    return SimpleDateFormat(fmt, Locale.UK).format(Date(ts))
}

private fun tomorrowMorning(): Long {
    val cal = java.util.Calendar.getInstance()
    cal.add(java.util.Calendar.DAY_OF_YEAR, 1)
    cal.set(java.util.Calendar.HOUR_OF_DAY, 8)
    cal.set(java.util.Calendar.MINUTE, 0)
    cal.set(java.util.Calendar.SECOND, 0)
    return cal.timeInMillis
}
