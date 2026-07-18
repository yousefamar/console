package io.amar.console.ui.chat

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
    val visible = remember(rooms) {
        rooms.filter { r ->
            r.isUnread && !r.isMuted && (r.snoozedUntil == null || r.snoozedUntil < now)
        }
    }

    Column(Modifier.fillMaxSize()) {
        PaneTopBar(
            title = "Chat",
            subtitle = if (visible.isEmpty()) "${rooms.size} rooms cached" else "${visible.size} unread",
        )
        if (visible.isEmpty()) {
            EmptyState(
                Icons.AutoMirrored.Outlined.Chat,
                "Inbox zero",
                "Unread conversations appear here",
            )
            return
        }
        LazyColumn(Modifier.fillMaxSize()) {
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

    // Opening a room does NOT mark it read — read is an explicit act
    // (the ✓✓ button, or swipe on the list). Sending a message does mark
    // read (you've obviously seen the conversation).
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
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
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
        val context = androidx.compose.ui.platform.LocalContext.current
        Composer(
            placeholder = "Message",
            draftKey = "chat:$roomId",
            onSend = { text -> scope.launch { repo.sendText(roomId, text); repo.markRead(roomId) } },
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
}

@Composable
private fun MessageBubble(
    msg: ChatMessageRow,
    isMine: Boolean,
    showSender: Boolean,
    onRetry: () -> Unit,
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
                .padding(horizontal = 11.dp, vertical = 6.dp),
        ) {
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
                        .padding(vertical = 2.dp),
                )
            }
            val bodyText = when {
                msg.isDeleted -> msg.body?.takeIf { it.isNotEmpty() } ?: "message deleted"
                msg.msgtype == "m.image" && msg.body == "image" -> null
                msg.msgtype == "m.file" -> "📎 ${msg.body ?: "file"}"
                msg.msgtype == "m.audio" -> "🎙 voice message"
                msg.msgtype == "m.video" -> "🎬 ${msg.body ?: "video"}"
                else -> msg.body?.takeIf { it.isNotEmpty() }
            }
            if (bodyText != null) {
                Text(
                    bodyText,
                    style = MaterialTheme.typography.bodyMedium,
                    textDecoration = if (msg.isDeleted) TextDecoration.LineThrough else null,
                    color = if (msg.isDeleted) MaterialTheme.colorScheme.onSurfaceVariant
                    else MaterialTheme.colorScheme.onSurface,
                )
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
