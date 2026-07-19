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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.MarkEmailUnread
import androidx.compose.material.icons.automirrored.filled.Forward
import androidx.compose.material.icons.automirrored.filled.ReplyAll
import androidx.compose.material.icons.filled.Reply
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.db.MailMessageRow
import io.amar.console.data.db.MailThreadRow
import io.amar.console.data.mail.MailRepository
import io.amar.console.ui.components.Avatar
import io.amar.console.ui.components.Composer
import io.amar.console.ui.components.EmptyState
import io.amar.console.ui.components.PaneTopBar
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

// ---------------------------------------------------------------------- //
// Inbox — swipe right = archive (undoable), swipe left = snooze

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MailInboxScreen(repo: MailRepository, onOpenThread: (String) -> Unit, onGrid: () -> Unit = {}) {
    val threads by repo.observeInbox().collectAsState(initial = emptyList())
    val snoozed by repo.observeSnoozed().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var undoThread by remember { mutableStateOf<String?>(null) }
    var searching by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }
    var searchResults by remember { mutableStateOf<List<MailThreadRow>>(emptyList()) }
    var showSnoozed by remember { mutableStateOf(false) }
    var composing by remember { mutableStateOf(false) }

    LaunchedEffect(searchQuery) {
        searchResults = if (searchQuery.length >= 2) repo.search(searchQuery) else emptyList()
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            PaneTopBar(
                title = "Mail",
                onGrid = onGrid,
                subtitle = if (threads.isEmpty()) null else "${threads.size} in inbox · ${threads.count { it.isUnread }} unread",
                actions = {
                    if (snoozed.isNotEmpty()) {
                        androidx.compose.material3.TextButton(onClick = { showSnoozed = !showSnoozed }) {
                            Text("${snoozed.size} snoozed", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    IconButton(onClick = { searching = !searching; searchQuery = "" }) {
                        Icon(
                            if (searching) Icons.Filled.Close
                            else Icons.Filled.Search,
                            contentDescription = "Search mail",
                            modifier = Modifier.size(20.dp),
                        )
                    }
                },
            )
            if (searching) {
                androidx.compose.material3.OutlinedTextField(
                    value = searchQuery,
                    onValueChange = { searchQuery = it },
                    placeholder = { Text("Search all cached mail") },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                    singleLine = true,
                )
                LazyColumn(Modifier.fillMaxSize()) {
                    items(searchResults, key = { it.id }) { thread ->
                        ThreadRow(thread, onClick = { searching = false; onOpenThread(thread.id) })
                    }
                }
                return
            }
            if (showSnoozed) {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(snoozed, key = { it.id }) { thread ->
                        Column {
                            ThreadRow(thread, onClick = { onOpenThread(thread.id) })
                            Text(
                                "⏰ wakes " + java.text.SimpleDateFormat("EEE d MMM HH:mm", java.util.Locale.UK)
                                    .format(java.util.Date(thread.snoozedUntil ?: 0)),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.tertiary,
                                modifier = Modifier.padding(start = 68.dp, bottom = 6.dp),
                            )
                        }
                    }
                }
                return
            }
            if (threads.isEmpty()) {
                EmptyState(Icons.Outlined.Email, "Inbox zero", "Swipe → archive · swipe ← snooze")
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(threads, key = { it.id }) { thread ->
                        val dismissState = rememberSwipeToDismissBoxState(
                            // Half-the-row drag required — the default ~56dp threshold
                            // made accidental snoozes while scrolling far too easy.
                            positionalThreshold = { totalDistance -> totalDistance * 0.5f },
                            confirmValueChange = { value ->
                                when (value) {
                                    SwipeToDismissBoxValue.StartToEnd -> {
                                        scope.launch {
                                            repo.archive(thread.id)
                                            undoThread = thread.id
                                            delay(5000)
                                            if (undoThread == thread.id) undoThread = null
                                        }
                                        true
                                    }
                                    SwipeToDismissBoxValue.EndToStart -> {
                                        scope.launch { repo.snooze(thread.id, tomorrowMorning()) }
                                        true
                                    }
                                    else -> false
                                }
                            },
                        )
                        SwipeToDismissBox(
                            state = dismissState,
                            backgroundContent = { MailSwipeBackground(dismissState.dismissDirection) },
                        ) {
                            Box(Modifier.background(MaterialTheme.colorScheme.background)) {
                                ThreadRow(thread, onClick = { onOpenThread(thread.id) })
                            }
                        }
                    }
                }
            }
        }
        androidx.compose.material3.FloatingActionButton(
            onClick = { composing = true },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        ) {
            Icon(Icons.Filled.Edit, contentDescription = "Compose")
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
    if (composing) {
        ComposeMailDialog(
            title = "New mail",
            showTo = true, showSubject = true,
            onDismiss = { composing = false },
            onSend = { to, subject, body ->
                composing = false
                scope.launch { repo.send(to, subject, body) }
            },
        )
    }
}

/** Compose/forward dialog — plain text; sends queue offline like all else. */
@Composable
private fun ComposeMailDialog(
    title: String,
    showTo: Boolean,
    showSubject: Boolean,
    onDismiss: () -> Unit,
    onSend: (to: String, subject: String, body: String) -> Unit,
) {
    var to by remember { mutableStateOf("") }
    var subject by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (showTo) {
                    androidx.compose.material3.OutlinedTextField(
                        value = to, onValueChange = { to = it },
                        label = { Text("To") }, singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (showSubject) {
                    androidx.compose.material3.OutlinedTextField(
                        value = subject, onValueChange = { subject = it },
                        label = { Text("Subject") }, singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                androidx.compose.material3.OutlinedTextField(
                    value = body, onValueChange = { body = it },
                    label = { Text("Message") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 4, maxLines = 10,
                )
                Text(
                    "Queues offline — sends when connected.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            androidx.compose.material3.Button(
                enabled = (!showTo || to.isNotBlank()) && body.isNotBlank(),
                onClick = { onSend(to.trim(), subject.trim(), body) },
            ) { Text("Send") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun MailSwipeBackground(direction: SwipeToDismissBoxValue) {
    val (color, icon, align) = when (direction) {
        SwipeToDismissBoxValue.StartToEnd ->
            Triple(MaterialTheme.colorScheme.primary, Icons.Filled.Archive, Alignment.CenterStart)
        SwipeToDismissBoxValue.EndToStart ->
            Triple(MaterialTheme.colorScheme.tertiary, Icons.Filled.Snooze, Alignment.CenterEnd)
        else -> return
    }
    Box(
        Modifier.fillMaxSize().background(color.copy(alpha = 0.25f)).padding(horizontal = 24.dp),
        contentAlignment = align,
    ) {
        Icon(icon, contentDescription = null, tint = color)
    }
}

@Composable
private fun ThreadRow(thread: MailThreadRow, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(name = thread.fromName, imageUrl = null, size = 42.dp)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    thread.fromName,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (thread.isUnread) FontWeight.Bold else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (thread.hasAttachments) {
                    Icon(
                        Icons.Filled.AttachFile, contentDescription = "Has attachments",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(13.dp),
                    )
                }
                Text(
                    formatListTime(thread.date),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (thread.isUnread) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 6.dp),
                )
            }
            Text(
                buildString {
                    append(thread.subject)
                    if (thread.messageCount > 1) append("  ·  ${thread.messageCount}")
                },
                style = MaterialTheme.typography.bodySmall,
                fontWeight = if (thread.isUnread) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                thread.snippet,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
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
    var replyAll by remember { mutableStateOf(false) }
    var forwarding by remember { mutableStateOf(false) }

    LaunchedEffect(threadId, thread?.isUnread) {
        if (thread?.isUnread == true) repo.markRead(threadId)
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        PaneTopBar(
            title = thread?.subject ?: "…",
            subtitle = thread?.fromName,
            onBack = onBack,
            actions = {
                IconButton(onClick = { scope.launch { repo.markUnread(threadId) }; onBack() }) {
                    Icon(Icons.Filled.MarkEmailUnread, "Mark unread", modifier = Modifier.size(19.dp))
                }
                IconButton(onClick = { scope.launch { repo.archive(threadId) }; onBack() }) {
                    Icon(Icons.Filled.Archive, "Archive", modifier = Modifier.size(19.dp))
                }
                IconButton(onClick = { replying = !replying; replyAll = false }) {
                    Icon(
                        Icons.Filled.Reply, "Reply",
                        tint = if (replying && !replyAll) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.size(19.dp),
                    )
                }
                IconButton(onClick = { replying = true; replyAll = true }) {
                    Icon(
                        Icons.AutoMirrored.Filled.ReplyAll, "Reply all",
                        tint = if (replying && replyAll) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.size(19.dp),
                    )
                }
                IconButton(onClick = { forwarding = true }) {
                    Icon(
                        Icons.AutoMirrored.Filled.Forward, "Forward",
                        modifier = Modifier.size(19.dp),
                    )
                }
            },
        )
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            for ((i, msg) in messages.withIndex()) {
                MessageCard(msg, expandedInitially = i == messages.lastIndex)
            }
        }
        if (replying) {
            Composer(
                placeholder = if (replyAll) "Reply all — sends when online, auto-archives" else "Reply — sends when online, auto-archives",
                draftKey = "mail:$threadId",
                onSend = { text ->
                    replying = false
                    scope.launch { repo.reply(threadId, text, replyAll) }
                    onBack()
                },
            )
        }
    }
    if (forwarding) {
        ComposeMailDialog(
            title = "Forward",
            showTo = true, showSubject = false,
            onDismiss = { forwarding = false },
            onSend = { to, _, body ->
                forwarding = false
                scope.launch { repo.forward(threadId, to, body.ifBlank { null }) }
                onBack()
            },
        )
    }
}

@Composable
private fun MessageCard(msg: MailMessageRow, expandedInitially: Boolean) {
    var expanded by remember { mutableStateOf(expandedInitially) }
    Column(
        Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded }
            .padding(horizontal = 14.dp, vertical = 7.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(name = msg.fromHeader.substringBefore('<').trim().ifEmpty { msg.fromHeader }, imageUrl = null, size = 32.dp)
            Column(Modifier.weight(1f)) {
                Text(
                    msg.fromHeader.substringBefore('<').trim().ifEmpty { msg.fromHeader },
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    formatListTime(msg.date),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (expanded) {
            Column(Modifier.padding(start = 42.dp)) {
                Text(
                    "to ${msg.toHeader}" + (msg.ccHeader?.let { " · cc $it" } ?: ""),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
            }
            msg.attachmentsJson?.let { aj ->
                val atts = remember(aj) {
                    runCatching {
                        (kotlinx.serialization.json.Json.parseToJsonElement(aj) as? kotlinx.serialization.json.JsonArray)
                            ?.mapNotNull { el ->
                                val o = el as? kotlinx.serialization.json.JsonObject ?: return@mapNotNull null
                                fun str(k: String): String? = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.content
                                Triple(str("filename") ?: "file", str("messageId") ?: "", str("attachmentId") ?: "")
                            }
                    }.getOrNull() ?: emptyList()
                }
                if (atts.isNotEmpty()) {
                    val ctx = androidx.compose.ui.platform.LocalContext.current
                    Row(
                        Modifier.padding(top = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        for ((name, mid, aid) in atts.take(4)) {
                            androidx.compose.material3.AssistChip(
                                onClick = {
                                    // Open via the system browser → hub attachment URL
                                    // (bearer won't ride a browser; use the app downloader).
                                    io.amar.console.data.mail.AttachmentOpener.open(ctx, mid, aid, name)
                                },
                                label = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                leadingIcon = { Icon(Icons.Filled.AttachFile, null, modifier = Modifier.size(14.dp)) },
                            )
                        }
                    }
                }
            }
            if (msg.bodyHtml != null) {
                // Resolve cid: inline images to data URIs before render.
                var resolvedHtml by remember(msg.id) { mutableStateOf(msg.bodyHtml!!) }
                LaunchedEffect(msg.id) {
                    val cids = io.amar.console.data.mail.CidResolver.parseCidAttachments(msg.attachmentsJson)
                    if (cids.isNotEmpty() && io.amar.console.data.mail.CidResolver.findCidRefs(msg.bodyHtml!!).isNotEmpty()) {
                        resolvedHtml = io.amar.console.data.mail.CidResolver.inline(
                            msg.bodyHtml!!, cids,
                            io.amar.console.data.mail.CidResolver.hubFetcher(io.amar.console.core.HubClient()),
                        )
                    }
                }
                MailBodyWebView(resolvedHtml)
            } else {
                Text(
                    msg.bodyText ?: "(body not cached — open online to fetch)",
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        } else {
            Text(
                msg.bodyText?.take(120) ?: "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 42.dp),
            )
        }
    }
}

/** Strict per-message HTML render: JS off, dark template, links → browser. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun MailBodyWebView(html: String) {
    androidx.compose.ui.viewinterop.AndroidView(
        modifier = Modifier.fillMaxWidth(),
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = false
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                webViewClient = object : android.webkit.WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView,
                        request: android.webkit.WebResourceRequest,
                    ): Boolean {
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

private fun formatListTime(ts: Long): String {
    if (ts <= 0) return ""
    val cal = Calendar.getInstance()
    val msgCal = Calendar.getInstance().apply { timeInMillis = ts }
    return when {
        cal.get(Calendar.DAY_OF_YEAR) == msgCal.get(Calendar.DAY_OF_YEAR) &&
            cal.get(Calendar.YEAR) == msgCal.get(Calendar.YEAR) ->
            SimpleDateFormat("HH:mm", Locale.UK).format(Date(ts))
        cal.timeInMillis - ts < 6 * 24 * 3600_000L ->
            SimpleDateFormat("EEE", Locale.UK).format(Date(ts))
        else -> SimpleDateFormat("d MMM", Locale.UK).format(Date(ts))
    }
}

private fun tomorrowMorning(): Long {
    val cal = Calendar.getInstance()
    cal.add(Calendar.DAY_OF_YEAR, 1)
    cal.set(Calendar.HOUR_OF_DAY, 8); cal.set(Calendar.MINUTE, 0); cal.set(Calendar.SECOND, 0)
    return cal.timeInMillis
}
