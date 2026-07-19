package io.amar.console.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.material.icons.filled.MarkChatUnread
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material.icons.outlined.PushPin
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
fun ChatRoomListScreen(repo: ChatRepository, onOpenRoom: (String) -> Unit, onGrid: () -> Unit = {}) {
    val rooms by repo.observeRooms().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    val now = System.currentTimeMillis()
    var searchQuery by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var snoozeTarget by remember { mutableStateOf<ChatRoomRow?>(null) }
    var menuTarget by remember { mutableStateOf<ChatRoomRow?>(null) }

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
            onGrid = onGrid,
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
                    RoomRow(
                        room,
                        onClick = { searching = false; searchQuery = ""; onOpenRoom(room.id) },
                        onLongPress = { menuTarget = room },
                    )
                }
            }
            SnoozeAndMenuSheets(
                repo = repo, scope = scope,
                snoozeTarget = snoozeTarget, onSnoozeDismiss = { snoozeTarget = null },
                menuTarget = menuTarget, onMenuDismiss = { menuTarget = null },
                onSnoozeRequest = { snoozeTarget = it },
            )
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
                    RoomRow(room, onClick = { onOpenRoom(room.id) }, onLongPress = { menuTarget = room })
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
                                // Snap back and let the picker decide when.
                                snoozeTarget = room
                                false
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
                        RoomRow(room, onClick = { onOpenRoom(room.id) }, onLongPress = { menuTarget = room })
                    }
                }
            }
        }
    }
    SnoozeAndMenuSheets(
        repo = repo, scope = scope,
        snoozeTarget = snoozeTarget, onSnoozeDismiss = { snoozeTarget = null },
        menuTarget = menuTarget, onMenuDismiss = { menuTarget = null },
        onSnoozeRequest = { snoozeTarget = it },
    )
}

/** Shared modal layer: snooze picker + room long-press context menu. */
@Composable
private fun SnoozeAndMenuSheets(
    repo: ChatRepository,
    scope: kotlinx.coroutines.CoroutineScope,
    snoozeTarget: ChatRoomRow?,
    onSnoozeDismiss: () -> Unit,
    menuTarget: ChatRoomRow?,
    onMenuDismiss: () -> Unit,
    onSnoozeRequest: (ChatRoomRow) -> Unit,
) {
    snoozeTarget?.let { room ->
        SnoozeSheet(
            onDismiss = onSnoozeDismiss,
            onPick = { untilMs ->
                scope.launch { repo.snooze(room.id, untilMs) }
                onSnoozeDismiss()
            },
        )
    }
    menuTarget?.let { room ->
        RoomContextSheet(
            room = room,
            onDismiss = onMenuDismiss,
            onMarkRead = { scope.launch { repo.markRead(room.id) } },
            onMarkUnread = { scope.launch { repo.markUnread(room.id) } },
            onSnooze = { onMenuDismiss(); onSnoozeRequest(room) },
            onTogglePin = { scope.launch { repo.setPinned(room.id, !room.isPinned) } },
            onToggleMute = { scope.launch { repo.setMuted(room.id, !room.isMuted) } },
        )
    }
}

/** Bottom-sheet snooze picker (SPA SnoozePicker parity): Later today,
 *  Tomorrow 8am, Next week Mon 8am, custom date+time via the platform
 *  DatePickerDialog → TimePickerDialog chain. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SnoozeSheet(onDismiss: () -> Unit, onPick: (Long) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val timeFmt = remember { SimpleDateFormat("HH:mm", Locale.UK) }
    val laterToday = remember { io.amar.console.data.chat.SnoozeTimes.laterToday() }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(
            "Snooze until",
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
        )
        SnoozeOption("Later today", timeFmt.format(Date(laterToday))) { onPick(laterToday) }
        SnoozeOption("Tomorrow", "8:00") { onPick(io.amar.console.data.chat.SnoozeTimes.tomorrowMorning()) }
        SnoozeOption("Next week", "Mon 8:00") { onPick(io.amar.console.data.chat.SnoozeTimes.nextWeekMonday()) }
        androidx.compose.material3.HorizontalDivider(
            Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            color = MaterialTheme.colorScheme.outline,
        )
        SnoozeOption("Pick date & time", "") {
            val cal = Calendar.getInstance()
            android.app.DatePickerDialog(
                context,
                { _, y, m, d ->
                    android.app.TimePickerDialog(
                        context,
                        { _, h, min ->
                            cal.set(y, m, d, h, min, 0)
                            cal.set(Calendar.MILLISECOND, 0)
                            onPick(cal.timeInMillis)
                        },
                        cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE), true,
                    ).show()
                },
                cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH),
            ).show()
        }
        androidx.compose.foundation.layout.Spacer(Modifier.size(24.dp))
    }
}

@Composable
private fun SnoozeOption(label: String, description: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        if (description.isNotEmpty()) {
            Text(
                description,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** Long-press room context menu: read state, snooze, pin, mute. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RoomContextSheet(
    room: ChatRoomRow,
    onDismiss: () -> Unit,
    onMarkRead: () -> Unit,
    onMarkUnread: () -> Unit,
    onSnooze: () -> Unit,
    onTogglePin: () -> Unit,
    onToggleMute: () -> Unit,
) {
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(
            room.name,
            style = MaterialTheme.typography.titleSmall,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
        )
        @Composable
        fun item(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, action: () -> Unit) {
            Row(
                Modifier.fillMaxWidth().clickable { action(); onDismiss() }
                    .padding(horizontal = 20.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(label, style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (room.isUnread) item(Icons.Filled.DoneAll, "Mark read", onMarkRead)
        else item(Icons.Filled.MarkChatUnread, "Mark unread", onMarkUnread)
        item(Icons.Filled.Snooze, "Snooze…", onSnooze)
        item(
            if (room.isPinned) Icons.Filled.PushPin else Icons.Outlined.PushPin,
            if (room.isPinned) "Unpin" else "Pin",
            onTogglePin,
        )
        item(
            if (room.isMuted) Icons.Filled.NotificationsOff else Icons.Outlined.NotificationsOff,
            if (room.isMuted) "Unmute" else "Mute",
            onToggleMute,
        )
        androidx.compose.foundation.layout.Spacer(Modifier.size(24.dp))
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

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun RoomRow(room: ChatRoomRow, onClick: () -> Unit, onLongPress: (() -> Unit)? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongPress)
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
    val context = androidx.compose.ui.platform.LocalContext.current

    // Opening a room does NOT mark it read — read is an explicit act
    // (the ✓✓ button, or swipe on the list). Sending a message does mark
    // read (you've obviously seen the conversation).
    LaunchedEffect(roomId) { repo.ensureMessages(roomId) }

    // Unread divider: freeze lastReadTs at OPEN (markRead/sends would move
    // it) and only when the room opened unread (SPA parity).
    var frozenLastReadTs by remember(roomId) { mutableStateOf<Long?>(null) }
    var myUserId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { myUserId = repo.myUserId() }
    // Meta/network may not have had it at first composition — retry once
    // messages land so own bubbles can't stick to the left.
    LaunchedEffect(messages.isNotEmpty()) {
        if (myUserId == null) myUserId = repo.myUserId()
    }
    LaunchedEffect(room?.id) {
        if (frozenLastReadTs == null && room != null && room!!.isUnread) {
            frozenLastReadTs = room!!.lastReadTs
        }
    }
    val dividerMsgId = remember(messages, frozenLastReadTs, myUserId) {
        io.amar.console.data.chat.ChatEvents.unreadDividerMessageId(messages, frozenLastReadTs, myUserId)
    }

    // Read receipts (rawJson carries the server RoomState) → newest message
    // each OTHER user has read.
    val receiptsByMsg = remember(room?.rawJson, messages) {
        io.amar.console.data.chat.ChatEvents.receiptsByMessage(
            io.amar.console.data.chat.ChatEvents.parseReadReceipts(room?.rawJson),
            messages,
        )
    }

    // Media open/decrypt-in-flight indicator (video/file taps).
    var openingMediaId by remember { mutableStateOf<String?>(null) }
    fun openMedia(msg: ChatMessageRow) {
        if (openingMediaId != null) return
        openingMediaId = msg.id
        scope.launch {
            try {
                val file = repo.mediaFile(context, msg)
                openViaFileProvider(context, file, msg.mediaMime)
            } catch (e: Exception) {
                android.widget.Toast.makeText(context, "Open failed: ${e.message}", android.widget.Toast.LENGTH_SHORT).show()
            } finally {
                openingMediaId = null
            }
        }
    }

    // @-mention autocomplete state: composer text mirror + member cache.
    var composerText by remember(roomId) { mutableStateOf("") }
    var members by remember(roomId) { mutableStateOf<List<ChatRepository.RoomMember>>(emptyList()) }
    val composerHandle = remember(roomId) { io.amar.console.ui.components.ComposerHandle() }
    val mentionQuery = remember(composerText) { io.amar.console.data.chat.Mentions.activeQuery(composerText) }
    LaunchedEffect(mentionQuery != null) {
        if (mentionQuery != null && members.isEmpty()) members = repo.roomMembers(roomId)
    }
    val mentionSuggestions = remember(mentionQuery, members) {
        mentionQuery?.let { io.amar.console.data.chat.Mentions.filterMembers(members, it.query) } ?: emptyList()
    }

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
                val isMine = msg.localEcho || msg.senderId == "me" ||
                    (myUserId != null && msg.senderId == myUserId)
                val groupStart = prev == null || prev.senderId != msg.senderId ||
                    (msg.timestamp - prev.timestamp) > 5 * 60 * 1000
                Column {
                    if (msg.id == dividerMsgId) UnreadDivider()
                    MessageBubble(
                        msg = msg,
                        isMine = isMine,
                        showSender = groupStart && !isMine && room?.isDirect == false,
                        showAvatar = groupStart && !isMine && room?.isDirect == false,
                        avatarGutter = room?.isDirect == false,
                        receipts = receiptsByMsg[msg.id],
                        openingMedia = openingMediaId == msg.id,
                        onRetry = { scope.launch { repo.retryFailed(msg.id) } },
                        onLongPress = { reactTarget = msg },
                        onReply = { replyingTo = msg },
                        onImageTap = { url -> lightboxUrl = url },
                        onMediaOpen = { openMedia(msg) },
                        onReact = { emoji -> scope.launch { repo.sendReaction(roomId, msg.id, emoji) } },
                        resolveMediaFile = { repo.mediaFile(context, msg) },
                    )
                }
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
        // Initial scroll: land on the unread divider when the room opened
        // unread (reverseLayout starts at the bottom, which is right when
        // there's nothing new).
        var didInitialScroll by remember(roomId) { mutableStateOf(false) }
        LaunchedEffect(dividerMsgId, messages.size) {
            if (didInitialScroll || dividerMsgId == null || messages.isEmpty()) return@LaunchedEffect
            val idx = messages.indexOfFirst { it.id == dividerMsgId }
            if (idx >= 0) {
                didInitialScroll = true
                listState.scrollToItem(idx)
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
        Composer(
            placeholder = "Message",
            draftKey = "chat:$roomId",
            onSend = { text ->
                val replyId = replyingTo?.id
                replyingTo = null
                scope.launch { repo.sendText(roomId, text, replyId); repo.markRead(roomId) }
            },
            onTextChange = { composerText = it; onComposerChange(it) },
            onSendWithAttachments = { text, uris ->
                scope.launch {
                    // Caption rides the first attachment (SPA convention).
                    uris.forEachIndexed { i, uri ->
                        repo.sendAttachment(context, roomId, uri, if (i == 0) text.ifBlank { null } else null)
                    }
                    repo.markRead(roomId)
                }
            },
            handle = composerHandle,
            aboveInput = if (mentionSuggestions.isNotEmpty()) {
                {
                    MentionSuggestionRow(mentionSuggestions) { member ->
                        val q = io.amar.console.data.chat.Mentions.activeQuery(composerHandle.text)
                        if (q != null) {
                            composerHandle.setText(
                                io.amar.console.data.chat.Mentions.insert(composerHandle.text, q, member.displayName)
                            )
                        }
                    }
                }
            } else null,
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

/** "— New —" unread divider row (SPA data-unread-divider parity). */
@Composable
private fun UnreadDivider() {
    val red = androidx.compose.ui.graphics.Color(0xFFF87171)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        androidx.compose.material3.HorizontalDivider(Modifier.weight(1f), color = red.copy(alpha = 0.6f))
        Text(
            "NEW",
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Medium,
            color = red,
        )
        androidx.compose.material3.HorizontalDivider(Modifier.weight(1f), color = red.copy(alpha = 0.6f))
    }
}

/** Horizontal member-suggestion strip above the composer (@-mentions). */
@Composable
private fun MentionSuggestionRow(
    suggestions: List<ChatRepository.RoomMember>,
    onPick: (ChatRepository.RoomMember) -> Unit,
) {
    androidx.compose.foundation.lazy.LazyRow(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items(suggestions, key = { it.userId }) { member ->
            Row(
                Modifier
                    .clip(RoundedCornerShape(14.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .clickable { onPick(member) }
                    .padding(horizontal = 10.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Avatar(name = member.displayName, imageUrl = null, size = 20.dp)
                Text(member.displayName, style = MaterialTheme.typography.labelMedium, maxLines = 1)
            }
        }
    }
}

/** Stacked initials circles under the newest bubble each user has read. */
@Composable
private fun ReadReceiptRow(receipts: List<io.amar.console.data.chat.ChatEvents.ReadReceipt>, isMine: Boolean) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp),
        horizontalArrangement = if (isMine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (r in receipts.take(3)) {
            Box(Modifier.padding(end = 2.dp)) {
                Avatar(
                    name = r.displayName ?: r.userId.removePrefix("@").substringBefore(':'),
                    imageUrl = MatrixMedia.thumbnailUrl(r.avatarMxc, 32, 32),
                    size = 14.dp,
                )
            }
        }
        if (receipts.size > 3) {
            Text(
                "+${receipts.size - 3}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** Download/decrypt then ACTION_VIEW via FileProvider (video/file bubbles). */
private fun openViaFileProvider(context: android.content.Context, file: java.io.File, mime: String?) {
    val uri = androidx.core.content.FileProvider.getUriForFile(
        context, "${context.packageName}.files", file,
    )
    val resolvedMime = mime
        ?: android.webkit.MimeTypeMap.getSingleton()
            .getMimeTypeFromExtension(file.extension.lowercase())
        ?: "application/octet-stream"
    val intent = android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
        setDataAndType(uri, resolvedMime)
        addFlags(
            android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                android.content.Intent.FLAG_ACTIVITY_NEW_TASK
        )
    }
    runCatching { context.startActivity(intent) }
        .onFailure {
            android.widget.Toast.makeText(context, "No app can open this file", android.widget.Toast.LENGTH_SHORT).show()
        }
}

/** m.audio play/pause + progress via MediaPlayer over the local file. */
@Composable
private fun AudioBubble(msg: ChatMessageRow, resolveFile: suspend () -> java.io.File) {
    val scope = rememberCoroutineScope()
    var playing by remember(msg.id) { mutableStateOf(false) }
    var preparing by remember(msg.id) { mutableStateOf(false) }
    var positionMs by remember(msg.id) { mutableIntStateOf(0) }
    var durationMs by remember(msg.id) {
        mutableIntStateOf(msg.mediaDurationMs?.toInt() ?: 0)
    }
    val player = remember(msg.id) { arrayOfNulls<android.media.MediaPlayer>(1) }

    // Release on dispose (leaving the room / bubble scrolled out of window).
    androidx.compose.runtime.DisposableEffect(msg.id) {
        onDispose {
            runCatching { player[0]?.release() }
            player[0] = null
        }
    }
    // Progress ticker while playing.
    LaunchedEffect(playing) {
        while (playing) {
            player[0]?.let { p ->
                runCatching {
                    positionMs = p.currentPosition
                    if (durationMs <= 0 && p.duration > 0) durationMs = p.duration
                }
            }
            kotlinx.coroutines.delay(250)
        }
    }

    fun toggle() {
        val p = player[0]
        when {
            p != null && playing -> {
                runCatching { p.pause() }
                playing = false
            }
            p != null -> {
                runCatching { p.start() }
                playing = true
            }
            !preparing -> {
                preparing = true
                scope.launch {
                    try {
                        val file = resolveFile()
                        val mp = android.media.MediaPlayer()
                        mp.setDataSource(file.absolutePath)
                        mp.setOnCompletionListener {
                            playing = false
                            positionMs = 0
                            runCatching { it.seekTo(0) }
                        }
                        mp.prepare()
                        if (durationMs <= 0) durationMs = mp.duration
                        player[0] = mp
                        mp.start()
                        playing = true
                    } catch (_: Exception) {
                        playing = false
                    } finally {
                        preparing = false
                    }
                }
            }
        }
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(vertical = 4.dp).widthIn(min = 180.dp),
    ) {
        Box(
            Modifier
                .size(34.dp)
                .clip(androidx.compose.foundation.shape.CircleShape)
                .background(MaterialTheme.colorScheme.primary)
                .clickable(enabled = !preparing) { toggle() },
            contentAlignment = Alignment.Center,
        ) {
            if (preparing) {
                CircularProgressIndicator(
                    Modifier.size(16.dp), strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                )
            } else {
                Icon(
                    if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = if (playing) "Pause" else "Play",
                    tint = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
        Column(Modifier.weight(1f)) {
            androidx.compose.material3.LinearProgressIndicator(
                progress = { if (durationMs > 0) positionMs.toFloat() / durationMs else 0f },
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                formatAudioTime(if (playing || positionMs > 0) positionMs else durationMs),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}

private fun formatAudioTime(ms: Int): String {
    if (ms <= 0) return "0:00"
    val totalSec = ms / 1000
    return "%d:%02d".format(totalSec / 60, totalSec % 60)
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(
    msg: ChatMessageRow,
    isMine: Boolean,
    showSender: Boolean,
    showAvatar: Boolean = false,
    avatarGutter: Boolean = false,
    receipts: List<io.amar.console.data.chat.ChatEvents.ReadReceipt>? = null,
    openingMedia: Boolean = false,
    onRetry: () -> Unit,
    onLongPress: () -> Unit = {},
    onReply: () -> Unit = {},
    onImageTap: (String) -> Unit = {},
    onMediaOpen: () -> Unit = {},
    onReact: (String) -> Unit = {},
    resolveMediaFile: (suspend () -> java.io.File)? = null,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 1.dp),
        horizontalArrangement = if (isMine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        // Avatar gutter in group rooms: initials circle at group starts,
        // matching spacer on follow-up bubbles so text stays aligned.
        if (!isMine && showAvatar) {
            Box(Modifier.padding(end = 6.dp)) {
                Avatar(name = msg.senderName ?: msg.senderId, imageUrl = null, size = 28.dp)
            }
        } else if (!isMine && avatarGutter) {
            androidx.compose.foundation.layout.Spacer(Modifier.size(34.dp))
        }
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
            } else if (msg.msgtype == "m.video" && (msg.mediaMxc != null || msg.encryptedFileJson != null) && !msg.isDeleted) {
                // Thumbnail placeholder + ▶ overlay; tap downloads/decrypts
                // then opens externally (ACTION_VIEW via FileProvider).
                Box(
                    Modifier
                        .fillMaxWidth()
                        .aspectRatio(16f / 9f)
                        .clip(RoundedCornerShape(9.dp))
                        .background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.55f))
                        .clickable(enabled = !openingMedia) { onMediaOpen() }
                        .padding(vertical = 2.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    if (openingMedia) {
                        CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
                    } else {
                        Icon(
                            Icons.Filled.PlayArrow, contentDescription = "Play video",
                            tint = androidx.compose.ui.graphics.Color.White,
                            modifier = Modifier
                                .size(52.dp)
                                .clip(androidx.compose.foundation.shape.CircleShape)
                                .background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.5f))
                                .padding(8.dp),
                        )
                    }
                }
            } else if (msg.msgtype == "m.audio" && (msg.mediaMxc != null || msg.encryptedFileJson != null) &&
                !msg.isDeleted && resolveMediaFile != null
            ) {
                AudioBubble(msg, resolveMediaFile)
            }
            val bodyText = when {
                msg.isDeleted -> msg.body?.takeIf { it.isNotEmpty() } ?: "message deleted"
                msg.msgtype == "m.image" && msg.body == "image" -> null
                msg.msgtype == "m.file" -> "📎 ${msg.body ?: "file"}"
                msg.msgtype == "m.audio" -> null // AudioBubble carries the UI
                msg.msgtype == "m.video" -> msg.body?.takeIf { it.isNotEmpty() && it != "video" }
                msg.msgtype == "m.emote" -> "* ${msg.senderName ?: ""} ${msg.body ?: ""}"
                else -> msg.body?.takeIf { it.isNotEmpty() }
            }
            if (bodyText != null) {
                if (msg.msgtype == "m.file" && !msg.isDeleted &&
                    (msg.mediaMxc != null || msg.encryptedFileJson != null)
                ) {
                    // Tappable file row → download/decrypt → ACTION_VIEW.
                    Row(
                        Modifier.clickable(enabled = !openingMedia) { onMediaOpen() },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (openingMedia) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                        Text(
                            bodyText,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                } else if (msg.formattedBody != null && !msg.isDeleted) {
                    // HTML body (bold/italic/links/lists) via the platform
                    // Html parser — links are tappable, opens the browser.
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
    // Read receipts: stacked avatars under the newest bubble each OTHER
    // user has read.
    if (!receipts.isNullOrEmpty()) {
        ReadReceiptRow(receipts, isMine)
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
