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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ---------------------------------------------------------------------- //
// Room list

@Composable
fun ChatRoomListScreen(repo: ChatRepository, onOpenRoom: (String) -> Unit) {
    val rooms by repo.observeRooms().collectAsState(initial = emptyList())
    val now = System.currentTimeMillis()
    // Inbox-zero model (mirrors ChatRoomList.tsx): unread + not-snoozed rooms.
    val visible = remember(rooms) {
        rooms.filter { r ->
            r.isUnread && !r.isMuted && (r.snoozedUntil == null || r.snoozedUntil < now)
        }
    }

    if (visible.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Inbox zero 🎉", style = MaterialTheme.typography.titleMedium)
                Text(
                    "${rooms.size} rooms cached",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        return
    }

    LazyColumn(Modifier.fillMaxSize()) {
        items(visible, key = { it.id }) { room ->
            RoomRow(room, onClick = { onOpenRoom(room.id) })
        }
    }
}

@Composable
private fun RoomRow(room: ChatRoomRow, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AsyncImage(
            model = MatrixMedia.thumbnailUrl(room.avatarMxc),
            contentDescription = null,
            modifier = Modifier
                .size(44.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.surfaceVariant),
        )
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    room.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = if (room.isUnread) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                room.networkIcon?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    formatTime(room.lastMessageTime),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                listOfNotNull(room.lastMessageSender, room.lastMessageBody).joinToString(": "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (room.unreadCount > 0) {
            Box(
                Modifier
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary)
                    .padding(horizontal = 7.dp, vertical = 2.dp),
            ) {
                Text(
                    room.unreadCount.toString(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onPrimary,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------- //
// Room view

@Composable
fun ChatRoomScreen(repo: ChatRepository, roomId: String, onComposerChange: (String) -> Unit = {}) {
    val room by repo.observeRoom(roomId).collectAsState(initial = null)
    var windowSize by remember { mutableIntStateOf(30) }
    val messages by repo.observeMessages(roomId, windowSize).collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var draft by remember { mutableStateOf("") }
    var loadingOlder by remember { mutableStateOf(false) }

    // Opening the room marks it read (SPA behaviour), queued offline.
    LaunchedEffect(roomId, room?.isUnread) {
        if (room?.isUnread == true) repo.markRead(roomId)
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        Text(
            room?.name ?: roomId,
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            reverseLayout = true, // newest at the bottom, like every chat app
            contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 4.dp),
        ) {
            items(messages, key = { it.id }) { msg ->
                MessageBubble(msg, onRetry = { scope.launch { repo.retryFailed(msg.id) } })
            }
            item {
                if (loadingOlder) {
                    Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                }
            }
        }
        // Load older when scrolled to the top of the (reversed) list.
        LaunchedEffect(listState) {
            androidx.compose.runtime.snapshotFlow {
                listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index
            }.collect { lastVisible ->
                if (lastVisible != null && lastVisible >= messages.size - 1 && messages.size >= windowSize && !loadingOlder) {
                    loadingOlder = true
                    val fetched = repo.loadOlder(roomId)
                    windowSize += maxOf(fetched, 30)
                    loadingOlder = false
                }
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it; onComposerChange(it) },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Message") },
                maxLines = 5,
            )
            IconButton(
                onClick = {
                    val text = draft.trim()
                    if (text.isNotEmpty()) {
                        draft = ""
                        scope.launch { repo.sendText(roomId, text) }
                    }
                },
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send", tint = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

@Composable
private fun MessageBubble(msg: ChatMessageRow, onRetry: () -> Unit) {
    val mine = msg.localEcho || msg.senderId == "me"
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 2.dp),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            Modifier
                .widthIn(max = 300.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(
                    if (mine) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
                    else MaterialTheme.colorScheme.surfaceVariant
                )
                .padding(horizontal = 10.dp, vertical = 6.dp),
        ) {
            if (!mine && msg.senderName != null) {
                Text(
                    msg.senderName,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            if (msg.msgtype == "m.image" && msg.mediaMxc != null) {
                AsyncImage(
                    model = MatrixMedia.thumbnailUrl(msg.mediaMxc, 512, 512),
                    contentDescription = msg.body,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp)),
                )
            }
            if (!msg.body.isNullOrEmpty() && !(msg.msgtype == "m.image" && msg.body == "image")) {
                Text(
                    msg.body!!,
                    style = MaterialTheme.typography.bodyMedium,
                    textDecoration = if (msg.isDeleted) TextDecoration.LineThrough else null,
                    color = if (msg.isDeleted) MaterialTheme.colorScheme.onSurfaceVariant
                    else MaterialTheme.colorScheme.onSurface,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    formatTime(msg.timestamp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (msg.localEcho && !msg.sendFailed) {
                    Text("🕓", style = MaterialTheme.typography.labelSmall)
                }
                if (msg.sendFailed) {
                    Icon(
                        Icons.Filled.ErrorOutline,
                        contentDescription = "Send failed",
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(14.dp),
                    )
                    Icon(
                        Icons.Filled.Refresh,
                        contentDescription = "Retry",
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(16.dp).clickable(onClick = onRetry),
                    )
                }
            }
        }
    }
}

private fun formatTime(ts: Long): String {
    if (ts <= 0) return ""
    val now = System.currentTimeMillis()
    val fmt = if (now - ts < 20 * 60 * 60 * 1000L) "HH:mm" else "d MMM"
    return SimpleDateFormat(fmt, Locale.UK).format(Date(ts))
}
