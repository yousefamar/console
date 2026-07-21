package io.amar.console.ui.mail

import android.annotation.SuppressLint
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.MarkEmailUnread
import androidx.compose.material.icons.automirrored.filled.Forward
import androidx.compose.material.icons.automirrored.filled.ReplyAll
import androidx.compose.material.icons.filled.Reply
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.db.MailMessageRow
import io.amar.console.data.db.MailThreadRow
import io.amar.console.data.mail.CalendarInvite
import io.amar.console.data.mail.MailRepository
import io.amar.console.ui.components.Avatar
import io.amar.console.ui.components.EmptyState
import io.amar.console.ui.components.PaneTopBar
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

// ---------------------------------------------------------------------- //
// Inbox — swipe right = archive (undoable), swipe left = snooze (picker)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MailInboxScreen(repo: MailRepository, onOpenThread: (String) -> Unit, onGrid: () -> Unit = {}) {
    val threads by repo.observeInbox().collectAsState(initial = emptyList())
    val snoozed by repo.observeSnoozed().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var searching by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }
    var searchResults by remember { mutableStateOf<List<MailThreadRow>>(emptyList()) }
    var showSnoozed by remember { mutableStateOf(false) }
    var composing by remember { mutableStateOf(false) }
    var snoozeTarget by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var labelMap by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    val threadLabels = remember { mutableStateOf<Map<String, List<String>>>(emptyMap()) }

    LaunchedEffect(Unit) { labelMap = repo.labelMap() }
    LaunchedEffect(threads) {
        // Load per-thread user labels for the tag row.
        val map = HashMap<String, List<String>>()
        for (t in threads) repo.threadLabels(t.id).takeIf { it.isNotEmpty() }?.let { map[t.id] = it }
        threadLabels.value = map
    }
    LaunchedEffect(searchQuery) {
        searchResults = if (searchQuery.length >= 2) repo.search(searchQuery) else emptyList()
    }
    // Background-preload inbox attachments so they open instantly + offline
    // (parity with the SPA's preloadAttachments). cacheDir is OS-evictable, so
    // no explicit cap needed; yield between fetches to keep the UI smooth.
    val appCtx = androidx.compose.ui.platform.LocalContext.current.applicationContext
    LaunchedEffect(threads.size) {
        if (threads.isEmpty()) return@LaunchedEffect
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            for ((mid, aid, name) in repo.inboxAttachmentTargets()) {
                io.amar.console.data.mail.AttachmentOpener.cacheOne(appCtx, mid, aid, name)
                kotlinx.coroutines.yield()
            }
        }
    }

    fun scheduleUndo(u: UndoState) {
        // Shared bottom snackbar (UndoHost) — same look/placement as every
        // other tab. Attachment blobs evicted when the undo window expires.
        io.amar.console.ui.shell.UndoController.offer(
            label = if (u.kind == UndoKind.ARCHIVE) "Archived" else "Deleted",
            onExpire = {
                val ids = runCatching { repo.threadAttachments(u.threadId).map { it.second } }.getOrDefault(emptyList())
                if (ids.isNotEmpty()) io.amar.console.data.mail.AttachmentOpener.evict(appCtx, ids)
            },
        ) {
            if (u.kind == UndoKind.ARCHIVE) repo.undoArchive(u.threadId) else repo.undoDelete(u.threadId)
        }
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            PaneTopBar(
                title = "Mail",
                onGrid = onGrid,
                subtitle = if (threads.isEmpty()) null else "${threads.size} in inbox · ${threads.count { it.isUnread }} unread",
                actions = {
                    if (snoozed.isNotEmpty()) {
                        TextButton(onClick = { showSnoozed = !showSnoozed }) {
                            Text(if (showSnoozed) "hide snoozed" else "${snoozed.size} snoozed", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    IconButton(onClick = { searching = !searching; searchQuery = "" }) {
                        Icon(
                            if (searching) Icons.Filled.Close else Icons.Filled.Search,
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
                        ThreadRow(thread, emptyList(), onClick = { searching = false; onOpenThread(thread.id) })
                    }
                }
                return
            }
            if (showSnoozed) {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(snoozed, key = { it.id }) { thread ->
                        Column {
                            ThreadRow(thread, emptyList(), onClick = { onOpenThread(thread.id) })
                            Text(
                                "⏰ wakes " + SimpleDateFormat("EEE d MMM HH:mm", Locale.UK).format(Date(thread.snoozedUntil ?: 0)),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.tertiary,
                                modifier = Modifier.padding(start = 68.dp, bottom = 6.dp),
                            )
                        }
                    }
                }
                return
            }
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    refreshing = true
                    scope.launch { runCatching { repo.reconcile() }; refreshing = false }
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                if (threads.isEmpty()) {
                    EmptyState(Icons.Outlined.Email, "Inbox zero", "Swipe → archive · swipe ← snooze")
                } else {
                    LazyColumn(Modifier.fillMaxSize()) {
                        items(threads, key = { it.id }) { thread ->
                            val dismissState = rememberSwipeToDismissBoxState(
                                positionalThreshold = { total -> total * 0.5f },
                                confirmValueChange = { value ->
                                    when (value) {
                                        SwipeToDismissBoxValue.StartToEnd -> {
                                            scope.launch { repo.archive(thread.id) }
                                            scheduleUndo(UndoState(thread.id, UndoKind.ARCHIVE))
                                            true
                                        }
                                        SwipeToDismissBoxValue.EndToStart -> {
                                            scope.launch { repo.snooze(thread.id, io.amar.console.data.mail.MailFormat.tomorrow()) }
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
                                    ThreadRow(thread, threadLabels.value[thread.id].orEmpty().mapNotNull { labelMap[it] ?: it }, onClick = { onOpenThread(thread.id) })
                                }
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
    }
    if (composing) {
        androidx.compose.material3.ModalBottomSheet(onDismissRequest = { composing = false }) {
            MailComposeSheet(repo, ComposeMode.COMPOSE, threadId = null, replyContext = null, onDismiss = { composing = false })
        }
    }
    snoozeTarget?.let { id ->
        SnoozePickerSheet(
            onSnooze = { ts -> scope.launch { repo.snooze(id, ts) }; snoozeTarget = null },
            onDismiss = { snoozeTarget = null },
        )
    }
}

private enum class UndoKind { ARCHIVE, DELETE }
private data class UndoState(val threadId: String, val kind: UndoKind)

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

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ThreadRow(thread: MailThreadRow, labels: List<String>, onClick: () -> Unit) {
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
            if (labels.isNotEmpty()) {
                FlowRow(Modifier.padding(top = 3.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (name in labels) {
                        Box(
                            Modifier.clip(RoundedCornerShape(3.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant)
                                .padding(horizontal = 4.dp, vertical = 1.dp),
                        ) {
                            Text(name, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = androidx.compose.ui.unit.TextUnit(9f, androidx.compose.ui.unit.TextUnitType.Sp))
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------- //
// Thread view

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MailThreadScreen(
    repo: MailRepository,
    threadId: String,
    onBack: () -> Unit,
    /** Surface a 5s undo at the shell level after a thread-view archive/delete
     *  navigates back. kind = "archive" | "delete". */
    onRemovedWithUndo: (threadId: String, kind: String) -> Unit = { _, _ -> },
) {
    val thread by repo.observeThread(threadId).collectAsState(initial = null)
    val messages by repo.observeMessages(threadId).collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    // Active composer: (mode, context). Null = button bar only.
    var composeState by remember { mutableStateOf<Pair<ComposeMode, ReplyContext?>?>(null) }
    var snoozing by remember { mutableStateOf(false) }
    // Email dark-mode toggle (Dark ⇄ Original), default dark; persisted
    // app-wide so the choice sticks across threads + restarts.
    val darkPrefs = androidx.compose.ui.platform.LocalContext.current
        .getSharedPreferences("mail_view", android.content.Context.MODE_PRIVATE)
    var emailDark by remember { mutableStateOf(darkPrefs.getBoolean("emailDark", true)) }

    LaunchedEffect(threadId, thread?.isUnread) {
        if (thread?.isUnread == true) repo.markRead(threadId)
    }

    fun contextFor(msg: MailMessageRow?) = msg?.let {
        replyContextFromMessage(it.id, it.fromHeader, it.toHeader, it.ccHeader, it.subject, it.date, it.bodyHtml, it.bodyText)
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        PaneTopBar(
            title = thread?.subject ?: "…",
            subtitle = thread?.fromName,
            onBack = onBack,
            actions = {
                TextButton(onClick = { emailDark = !emailDark; darkPrefs.edit().putBoolean("emailDark", emailDark).apply() }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 6.dp)) {
                    Text(if (emailDark) "Dark" else "Original", style = MaterialTheme.typography.labelSmall)
                }
                IconButton(onClick = { scope.launch { repo.markUnread(threadId) }; onBack() }) {
                    Icon(Icons.Filled.MarkEmailUnread, "Mark unread", modifier = Modifier.size(19.dp))
                }
                IconButton(onClick = { snoozing = true }) {
                    Icon(Icons.Filled.Snooze, "Snooze", modifier = Modifier.size(19.dp))
                }
                IconButton(onClick = { scope.launch { repo.archive(threadId) }; onRemovedWithUndo(threadId, "archive"); onBack() }) {
                    Icon(Icons.Filled.Archive, "Archive", modifier = Modifier.size(19.dp))
                }
                IconButton(onClick = { scope.launch { repo.deleteThread(threadId) }; onRemovedWithUndo(threadId, "delete"); onBack() }) {
                    Icon(Icons.Filled.Delete, "Delete", modifier = Modifier.size(19.dp))
                }
                IconButton(onClick = { composeState = ComposeMode.REPLY to contextFor(messages.lastOrNull()) }) {
                    Icon(Icons.Filled.Reply, "Reply", modifier = Modifier.size(19.dp))
                }
                IconButton(onClick = { composeState = ComposeMode.REPLY_ALL to contextFor(messages.lastOrNull()) }) {
                    Icon(Icons.AutoMirrored.Filled.ReplyAll, "Reply all", modifier = Modifier.size(19.dp))
                }
                IconButton(onClick = { composeState = ComposeMode.FORWARD to contextFor(messages.lastOrNull()) }) {
                    Icon(Icons.AutoMirrored.Filled.Forward, "Forward", modifier = Modifier.size(19.dp))
                }
            },
        )
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            for ((i, msg) in messages.withIndex()) {
                MessageCard(
                    repo, msg, expandedInitially = i == messages.lastIndex, emailDark = emailDark,
                    onReply = { composeState = ComposeMode.REPLY to contextFor(msg) },
                    onReplyAll = { composeState = ComposeMode.REPLY_ALL to contextFor(msg) },
                    onForward = { composeState = ComposeMode.FORWARD to contextFor(msg) },
                )
            }
        }
    }
    composeState?.let { (mode, ctx) ->
        androidx.compose.material3.ModalBottomSheet(onDismissRequest = { composeState = null }) {
            MailComposeSheet(
                repo, mode, threadId = threadId, replyContext = ctx,
                onDismiss = {
                    composeState = null
                    // Reply/reply-all auto-archive → leave the thread.
                    if (mode == ComposeMode.REPLY || mode == ComposeMode.REPLY_ALL) onBack()
                },
            )
        }
    }
    if (snoozing) {
        SnoozePickerSheet(
            onSnooze = { ts -> scope.launch { repo.snooze(threadId, ts) }; snoozing = false; onBack() },
            onDismiss = { snoozing = false },
        )
    }
}

@Composable
private fun MessageCard(
    repo: MailRepository,
    msg: MailMessageRow,
    expandedInitially: Boolean,
    emailDark: Boolean,
    onReply: () -> Unit,
    onReplyAll: () -> Unit,
    onForward: () -> Unit,
) {
    var expanded by remember { mutableStateOf(expandedInitially) }
    var menuOpen by remember { mutableStateOf(false) }
    var invite by remember(msg.id) { mutableStateOf<CalendarInvite?>(null) }
    LaunchedEffect(msg.id, expanded) { if (expanded && invite == null) invite = repo.calendarInvite(msg.id) }

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
            if (expanded) {
                Box {
                    IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(28.dp)) {
                        Icon(Icons.Filled.MoreHoriz, "Message actions", modifier = Modifier.size(18.dp))
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("Reply") }, onClick = { menuOpen = false; onReply() }, leadingIcon = { Icon(Icons.Filled.Reply, null, modifier = Modifier.size(16.dp)) })
                        DropdownMenuItem(text = { Text("Reply all") }, onClick = { menuOpen = false; onReplyAll() }, leadingIcon = { Icon(Icons.AutoMirrored.Filled.ReplyAll, null, modifier = Modifier.size(16.dp)) })
                        DropdownMenuItem(text = { Text("Forward") }, onClick = { menuOpen = false; onForward() }, leadingIcon = { Icon(Icons.AutoMirrored.Filled.Forward, null, modifier = Modifier.size(16.dp)) })
                    }
                }
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
            invite?.let { CalendarInviteCard(it) }
            AttachmentChips(msg)
            if (msg.bodyHtml != null) {
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
                MailBodyWebView(resolvedHtml, emailDark)
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

/**
 * Strict per-message HTML render: JS off, sanitized + linearized, links → browser.
 * [dark] toggles the SPA's invert+hue-rotate dark mode (re-inverts media so photos
 * stay natural) over a white base; Original renders the email's own light styling.
 */
@Composable
private fun MailBodyWebView(html: String, dark: Boolean) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val safe = remember(html) { io.amar.console.data.mail.MailFormat.sanitizeHtml(html) }
    val doc = remember(safe, dark) {
        val darkCss = if (dark) io.amar.console.data.mail.MailFormat.darkModeCss() else ""
        """
        <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { background:#fff; color:#111; font-family:sans-serif; font-size:14px; margin:8px; word-break:break-word; }
          ${io.amar.console.data.mail.MailFormat.linearizeCss()}
          $darkCss
        </style></head><body>$safe</body></html>
        """.trimIndent()
    }
    io.amar.console.ui.components.SelfSizingWebView(
        html = doc,
        onOpenUrl = { url ->
            runCatching {
                ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
            }
        },
    )
}

/** Attachment chip row: type icon, filename (truncated), human size, tap to open.
 *  Inline CID attachments (contentId) filtered out — rendered in the body. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AttachmentChips(msg: MailMessageRow) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val atts = remember(msg.attachmentsJson) { parseAttachments(msg.attachmentsJson) }
    if (atts.isEmpty()) return
    FlowRow(
        Modifier.padding(top = 6.dp, start = 42.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (a in atts) {
            androidx.compose.material3.AssistChip(
                onClick = { io.amar.console.data.mail.AttachmentOpener.open(ctx, a.messageId, a.attachmentId, a.filename) },
                label = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(a.filename, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 150.dp))
                        if (a.size > 0) Text("(${io.amar.console.data.mail.MailFormat.formatFileSize(a.size)})", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
                leadingIcon = { Icon(attachmentIcon(a.mimeType), null, modifier = Modifier.size(14.dp)) },
            )
        }
    }
}

private data class Attachment(val messageId: String, val attachmentId: String, val filename: String, val mimeType: String, val size: Long, val contentId: String?)

private fun parseAttachments(aj: String?): List<Attachment> {
    aj ?: return emptyList()
    return runCatching {
        (kotlinx.serialization.json.Json.parseToJsonElement(aj) as? kotlinx.serialization.json.JsonArray)
            ?.mapNotNull { el ->
                val o = el as? kotlinx.serialization.json.JsonObject ?: return@mapNotNull null
                fun str(k: String): String? = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.content
                Attachment(
                    messageId = str("messageId") ?: "",
                    attachmentId = str("attachmentId") ?: "",
                    filename = str("filename") ?: "file",
                    mimeType = str("mimeType") ?: "",
                    size = str("size")?.toLongOrNull() ?: 0L,
                    contentId = str("contentId"),
                )
            }
            // Inline CID images render in the body; keep only real attachments.
            ?.filter { it.contentId == null }
    }.getOrNull() ?: emptyList()
}

private fun attachmentIcon(mime: String) = when {
    mime.startsWith("image/") -> Icons.Outlined.Email.let { Icons.Filled.AttachFile } // placeholder replaced below
    else -> Icons.Filled.AttachFile
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
