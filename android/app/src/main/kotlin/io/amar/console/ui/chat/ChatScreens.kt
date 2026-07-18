package io.amar.console.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.fromHtml
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import io.amar.console.data.chat.ChatRepository
import io.amar.console.data.chat.MatrixMedia
import io.amar.console.data.db.ChatMessageRow
import io.amar.console.data.db.ChatRoomRow
import io.amar.console.ui.components.Avatar
import io.amar.console.ui.components.Composer
import io.amar.console.ui.components.CountPill
import io.amar.console.ui.components.EmptyState
import io.amar.console.ui.components.PaneTopBar
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

private fun networkEmoji(networkIcon: String?): String? = when (networkIcon) {
    "whatsapp" -> "🟢"
    "signal" -> "🔵"
    "telegram" -> "✈️"
    "linkedin" -> "💼"
    "slack" -> "#"
    "instagram" -> "📷"
    else -> null
}

// ---------------------------------------------------------------------- //
// Room list — inbox-zero: unread rooms, swipe right = read, left = snooze

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatRoomListScreen(repo: ChatRepository, onOpenRoom: (String) -> Unit) {
    val rooms by repo.observeRooms().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    val now = System.currentTimeMillis()
    var searchQuery by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }

    // Search reaches EVERY cached room (read/snoozed/muted included) —
    // the list itself is inbox-zero: pinned section + unread section.
    val searchResults = remember(rooms, searchQuery) {
        if (searchQuery.isBlank()) emptyList()
        else {
            val q = searchQuery.lowercase()
            rooms.filter { it.name.lowercase().contains(q) }
                .sortedByDescending { it.name.lowercase().startsWith(q) }
                .take(30)
        }
    }
    val pinned = remember(rooms) {
        rooms.filter { it.isPinned && !it.isMuted }.sortedBy { it.name.lowercase() }
    }
    val visible = remember(rooms) {
        rooms.filter { r ->
            r.isUnread && !r.isMuted && !r.isLowPriority && !r.isPinned &&
                (r.snoozedUntil == null || r.snoozedUntil < now)
        }
    }

    Column(Modifier.fillMaxSize()) {
        PaneTopBar(
            title = "Chat",
            subtitle = if (visible.isEmpty()) "${rooms.size} rooms cached" else "${visible.size} unread",
            actions = {
                androidx.compose.material3.IconButton(onClick = { searching = !searching; searchQuery = "" }) {
                    Icon(
                        if (searching) Icons.Filled.Close else androidx.compose.material.icons.Icons.Filled.Search,
                        contentDescription = "Search rooms",
                        modifier = Modifier.size(20.dp),
                    )
                }
            },
        )
        if (searching) {
            androidx.compose.material3.OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                placeholder = { Text("Search all rooms") },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                singleLine = true,
            )
            LazyColumn(Modifier.fillMaxSize()) {
                items(searchResults, key = { it.id }) { room ->
                    RoomRow(room, onClick = { searching = false; searchQuery = ""; onOpenRoom(room.id) })
                }
            }
            return
        }
        if (visible.isEmpty() && pinned.isEmpty()) {
            EmptyState(
                Icons.AutoMirrored.Outlined.Chat,
                "Inbox zero",
                "Unread conversations appear here — search reaches everything",
            )
            return
        }
        LazyColumn(Modifier.fillMaxSize()) {
            if (pinned.isNotEmpty()) {
                items(pinned, key = { "pin-" + it.id }) { room ->
                    RoomRow(room, onClick = { onOpenRoom(room.id) })
                }
                item(key = "divider") {
                    androidx.compose.material3.HorizontalDivider(
                        Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                        color = MaterialTheme.colorScheme.outline,
                    )
                }
            }
            items(visible, key = { it.id }) { room ->
                val dismissState = rememberSwipeToDismissBoxState(
                    // Half-the-row drag required — the default ~56dp threshold
                    // made accidental snoozes while scrolling far too easy.
                    positionalThreshold = { totalDistance -> totalDistance * 0.5f },
                    confirmValueChange = { value ->
                        when (value) {
                            SwipeToDismissBoxValue.StartToEnd -> {
                                scope.launch { repo.markRead(room.id) }
                                true
                            }
                            SwipeToDismissBoxValue.EndToStart -> {
                                scope.launch { repo.snooze(room.id, tomorrowMorning()) }
                                true
                            }
                            else -> false
                        }
                    },
                )
                SwipeToDismissBox(
                    state = dismissState,
                    backgroundContent = { SwipeBackground(dismissState.dismissDirection) },
                ) {
                    Box(Modifier.background(MaterialTheme.colorScheme.background)) {
                        RoomRow(room, onClick = { onOpenRoom(room.id) })
                    }
                }
            }
        }
    }
}

@Composable
private fun SwipeBackground(direction: SwipeToDismissBoxValue) {
    val (color, icon, align) = when (direction) {
        SwipeToDismissBoxValue.StartToEnd ->
            Triple(MaterialTheme.colorScheme.primary, Icons.Filled.DoneAll, Alignment.CenterStart)
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
private fun RoomRow(room: ChatRoomRow, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(
            name = room.name,
            imageUrl = MatrixMedia.thumbnailUrl(room.avatarMxc),
            size = 48.dp,
            emoji = networkEmoji(room.networkIcon),
        )
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    room.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    formatListTime(room.lastMessageTime),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (room.unreadCount > 0) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    buildString {
                        if (!room.isDirect && !room.lastMessageSender.isNullOrEmpty()) {
                            append(room.lastMessageSender); append(": ")
                        }
                        append(room.lastMessageBody ?: "")
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (room.unreadCount > 0) CountPill(room.unreadCount)
            }
        }
    }
}

// ---------------------------------------------------------------------- //
// Room timeline

@Composable
fun ChatRoomScreen(
    repo: ChatRepository,
    roomId: String,
    onBack: () -> Unit = {},
    onComposerChange: (String) -> Unit = {},
) {
    val room by repo.observeRoom(roomId).collectAsState(initial = null)
    var windowSize by remember { mutableIntStateOf(30) }
    val messages by repo.observeMessages(roomId, windowSize).collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var loadingOlder by remember { mutableStateOf(false) }
    var replyingTo by remember { mutableStateOf<ChatMessageRow?>(null) }
    var reactTarget by remember { mutableStateOf<ChatMessageRow?>(null) }
    var lightboxUrl by remember { mutableStateOf<String?>(null) }

    // Opening a room does NOT mark it read — read is an explicit act
    // (the ✓✓ button, or swipe on the list). Sending a message does mark
    // read (you've obviously seen the conversation).
    LaunchedEffect(roomId) { repo.ensureMessages(roomId) }

    Column(Modifier.fillMaxSize().imePadding()) {
        PaneTopBar(
            title = room?.name ?: "…",
            subtitle = listOfNotNull(
                room?.networkIcon,
                room?.memberCount?.takeIf { it > 2 && room?.isDirect == false }?.let { "$it members" },
            ).joinToString(" · ").ifEmpty { null },
            onBack = onBack,
            actions = {
                if (room?.isUnread == true) {
                    androidx.compose.material3.IconButton(onClick = { scope.launch { repo.markRead(roomId) } }) {
                        Icon(
                            Icons.Filled.DoneAll, contentDescription = "Mark read",
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            },
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            reverseLayout = true,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 6.dp),
        ) {
            items(messages, key = { it.id }) { msg ->
                val idx = messages.indexOfFirst { it.id == msg.id }
                // reverseLayout: idx+1 is the CHRONOLOGICALLY PREVIOUS message.
                val prev = messages.getOrNull(idx + 1)
                val isMine = msg.localEcho || msg.senderId == "me"
                val groupStart = prev == null || prev.senderId != msg.senderId ||
                    (msg.timestamp - prev.timestamp) > 5 * 60 * 1000
                MessageBubble(
                    msg = msg,
                    isMine = isMine,
                    showSender = groupStart && !isMine && room?.isDirect == false,
                    onRetry = { scope.launch { repo.retryFailed(msg.id) } },
                    onLongPress = { reactTarget = msg },
                    onReply = { replyingTo = msg },
                    onImageTap = { url -> lightboxUrl = url },
                    onReact = { emoji -> scope.launch { repo.sendReaction(roomId, msg.id, emoji) } },
                )
            }
            item {
                if (loadingOlder) {
                    Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    }
                }
            }
        }
        val showJump by remember {
            androidx.compose.runtime.derivedStateOf { listState.firstVisibleItemIndex > 3 }
        }
        if (showJump) {
            androidx.compose.material3.SmallFloatingActionButton(
                onClick = { scope.launch { listState.animateScrollToItem(0) } },
                modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
            ) {
                Icon(
                    androidx.compose.material.icons.Icons.Filled.KeyboardArrowDown,
                    contentDescription = "Jump to bottom",
                )
            }
        }
        }
        LaunchedEffect(listState, messages.size) {
            androidx.compose.runtime.snapshotFlow {
                listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index
            }.collect { lastVisible ->
                if (lastVisible != null && lastVisible >= messages.size - 1 &&
                    messages.size >= windowSize && !loadingOlder
                ) {
                    loadingOlder = true
                    val fetched = repo.loadOlder(roomId)
                    windowSize += maxOf(fetched, 30)
                    loadingOlder = false
                }
            }
        }
        replyingTo?.let { target ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f))
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "Replying to ${target.senderName ?: target.senderId}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Text(
                        target.body ?: "", style = MaterialTheme.typography.bodySmall,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Icon(
                    Icons.Filled.Close, contentDescription = "Cancel reply",
                    modifier = Modifier.size(16.dp).clickable { replyingTo = null },
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        val context = androidx.compose.ui.platform.LocalContext.current
        Composer(
            placeholder = "Message",
            draftKey = "chat:$roomId",
            onSend = { text ->
                val replyId = replyingTo?.id
                replyingTo = null
                scope.launch { repo.sendText(roomId, text, replyId); repo.markRead(roomId) }
            },
            onTextChange = onComposerChange,
            onSendWithAttachments = { text, uris ->
                scope.launch {
                    // Caption rides the first attachment (SPA convention).
                    uris.forEachIndexed { i, uri ->
                        repo.sendAttachment(context, roomId, uri, if (i == 0) text.ifBlank { null } else null)
                    }
                    repo.markRead(roomId)
                }
            },
        )
    }

    reactTarget?.let { target ->
        val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
        QuickReactSheet(
            target = target,
            onDismiss = { reactTarget = null },
            onReact = { emoji -> scope.launch { repo.sendReaction(roomId, target.id, emoji) } },
            onReply = { replyingTo = target },
            onCopy = { clipboard.setText(androidx.compose.ui.text.AnnotatedString(target.body ?: "")) },
        )
    }
    lightboxUrl?.let { url ->
        androidx.compose.ui.window.Dialog(
            onDismissRequest = { lightboxUrl = null },
            properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Box(
                Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black)
                    .clickable { lightboxUrl = null },
                contentAlignment = Alignment.Center,
            ) {
                AsyncImage(model = url, contentDescription = null, modifier = Modifier.fillMaxWidth())
            }
        }
    }
}


// Quick-react sheet (long-press a bubble) + reply action.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun QuickReactSheet(
    target: ChatMessageRow,
    onDismiss: () -> Unit,
    onReact: (String) -> Unit,
    onReply: () -> Unit,
    onCopy: () -> Unit,
) {
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            for (emoji in listOf("👍", "❤️", "😂", "😮", "😢", "🙏")) {
                Text(
                    emoji,
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.clickable { onReact(emoji); onDismiss() }.padding(6.dp),
                )
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            androidx.compose.material3.TextButton(onClick = { onReply(); onDismiss() }) { Text("↩ Reply") }
            androidx.compose.material3.TextButton(onClick = { onCopy(); onDismiss() }) { Text("⧉ Copy text") }
        }
        androidx.compose.foundation.layout.Spacer(Modifier.size(24.dp))
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(
    msg: ChatMessageRow,
    isMine: Boolean,
    showSender: Boolean,
    onRetry: () -> Unit,
    onLongPress: () -> Unit = {},
    onReply: () -> Unit = {},
    onImageTap: (String) -> Unit = {},
    onReact: (String) -> Unit = {},
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 1.dp),
        horizontalArrangement = if (isMine) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            Modifier
                .widthIn(max = 300.dp)
                .clip(
                    RoundedCornerShape(
                        topStart = 14.dp, topEnd = 14.dp,
                        bottomStart = if (isMine) 14.dp else 4.dp,
                        bottomEnd = if (isMine) 4.dp else 14.dp,
                    )
                )
                .background(
                    if (isMine) MaterialTheme.colorScheme.primary.copy(alpha = 0.22f)
                    else MaterialTheme.colorScheme.surfaceVariant
                )
                .combinedClickable(
                    onClick = {},
                    onLongClick = onLongPress,
                )
                .padding(horizontal = 11.dp, vertical = 6.dp),
        ) {
            // Reply quote (m.in_reply_to context)
            msg.replyToJson?.let { rj ->
                val reply = remember(rj) {
                    runCatching { Json.parseToJsonElement(rj).jsonObject }.getOrNull()
                }
                val rSender = reply?.get("sender")?.jsonPrimitive?.content
                val rBody = reply?.get("body")?.jsonPrimitive?.content
                if (rBody != null || rSender != null) {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.background.copy(alpha = 0.5f))
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    ) {
                        rSender?.let {
                            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        }
                        rBody?.let {
                            Text(
                                it, style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
            if (showSender && msg.senderName != null) {
                val hue = ((msg.senderId.hashCode() % 360) + 360) % 360
                Text(
                    msg.senderName!!,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = androidx.compose.ui.graphics.Color.hsv(hue.toFloat(), 0.5f, 0.9f),
                )
            }
            if (msg.msgtype == "m.image" && msg.localMediaPath != null && !msg.isDeleted) {
                AsyncImage(
                    model = java.io.File(msg.localMediaPath!!),
                    contentDescription = msg.body,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(9.dp))
                        .padding(vertical = 2.dp),
                )
            } else if (msg.msgtype == "m.image" && msg.mediaMxc != null && !msg.isDeleted) {
                AsyncImage(
                    model = MatrixMedia.thumbnailUrl(msg.mediaMxc, 512, 512),
                    contentDescription = msg.body,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(9.dp))
                        .clickable { MatrixMedia.downloadUrl(msg.mediaMxc)?.let(onImageTap) }
                        .padding(vertical = 2.dp),
                )
            }
            val bodyText = when {
                msg.isDeleted -> msg.body?.takeIf { it.isNotEmpty() } ?: "message deleted"
                msg.msgtype == "m.image" && msg.body == "image" -> null
                msg.msgtype == "m.file" -> "📎 ${msg.body ?: "file"}"
                msg.msgtype == "m.audio" -> "🎙 voice message"
                msg.msgtype == "m.video" -> "🎬 ${msg.body ?: "video"}"
                msg.msgtype == "m.emote" -> "* ${msg.senderName ?: ""} ${msg.body ?: ""}"
                else -> msg.body?.takeIf { it.isNotEmpty() }
            }
            if (bodyText != null) {
                if (msg.formattedBody != null && !msg.isDeleted) {
                    // HTML body (bold/italic/links/lists) via the platform
                    // Html parser — links are tappable, opens the browser.
                    val ctx = androidx.compose.ui.platform.LocalContext.current
                    val html = remember(msg.formattedBody) {
                        androidx.compose.ui.text.AnnotatedString.Companion.fromHtml(
                            msg.formattedBody!!,
                            linkStyles = androidx.compose.ui.text.TextLinkStyles(
                                style = androidx.compose.ui.text.SpanStyle(color = androidx.compose.ui.graphics.Color(0xFF60A5FA)),
                            ),
                        )
                    }
                    Text(html, style = MaterialTheme.typography.bodyMedium)
                } else {
                    LinkifiedText(
                        bodyText,
                        strikethrough = msg.isDeleted,
                        dim = msg.isDeleted,
                    )
                }
            }
            msg.reactionsJson?.let { rj ->
                val reactions = remember(rj) {
                    runCatching {
                        Json.parseToJsonElement(rj).jsonObject.entries.map { (k, v) ->
                            k to ((v as? JsonArray)?.size ?: 0)
                        }
                    }.getOrElse { emptyList() }
                }
                if (reactions.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 2.dp)) {
                        for ((emoji, count) in reactions.take(6)) {
                            Text(
                                if (count > 1) "$emoji $count" else emoji,
                                style = MaterialTheme.typography.labelSmall,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(MaterialTheme.colorScheme.background.copy(alpha = 0.5f))
                                    .clickable { onReact(emoji) }
                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                }
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.align(Alignment.End),
            ) {
                if (msg.isEdited) {
                    Text("edited", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    formatBubbleTime(msg.timestamp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                when {
                    msg.sendFailed -> {
                        Icon(Icons.Filled.ErrorOutline, "Send failed", tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(13.dp))
                        Icon(
                            Icons.Filled.Refresh, "Retry",
                            tint = MaterialTheme.colorScheme.error,
                            modifier = Modifier.size(15.dp).clickable(onClick = onRetry),
                        )
                    }
                    msg.localEcho -> Icon(
                        Icons.Filled.Schedule, "Queued",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(12.dp),
                    )
                }
            }
        }
    }
}

// ---------------------------------------------------------------------- //

/** Plain text with tappable URLs (linkification parity). */
@Composable
private fun LinkifiedText(text: String, strikethrough: Boolean, dim: Boolean) {
    val urlRegex = remember { Regex("https?://[^\\s]+") }
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val annotated = remember(text) {
        androidx.compose.ui.text.buildAnnotatedString {
            var last = 0
            for (m in urlRegex.findAll(text)) {
                append(text.substring(last, m.range.first))
                withLink(
                    androidx.compose.ui.text.LinkAnnotation.Url(
                        m.value,
                        androidx.compose.ui.text.TextLinkStyles(
                            style = androidx.compose.ui.text.SpanStyle(color = androidx.compose.ui.graphics.Color(0xFF60A5FA)),
                        ),
                    )
                ) { append(m.value) }
                last = m.range.last + 1
            }
            append(text.substring(last))
        }
    }
    Text(
        annotated,
        style = MaterialTheme.typography.bodyMedium.let {
            if (strikethrough) it.copy(textDecoration = TextDecoration.LineThrough) else it
        },
        color = if (dim) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
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

private fun formatBubbleTime(ts: Long): String =
    if (ts <= 0) "" else SimpleDateFormat("HH:mm", Locale.UK).format(Date(ts))

private fun tomorrowMorning(): Long {
    val cal = Calendar.getInstance()
    cal.add(Calendar.DAY_OF_YEAR, 1)
    cal.set(Calendar.HOUR_OF_DAY, 8); cal.set(Calendar.MINUTE, 0); cal.set(Calendar.SECOND, 0)
    return cal.timeInMillis
}
