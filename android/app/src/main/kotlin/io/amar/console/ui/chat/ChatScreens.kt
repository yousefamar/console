package io.amar.console.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.OpenInNew
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
import androidx.compose.material.icons.filled.SouthEast
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
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
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

private fun networkEmoji(networkIcon: String?): String? =
    io.amar.console.data.chat.ChatFormat.networkGlyph(networkIcon)

// ---------------------------------------------------------------------- //
// Room list — inbox-zero: unread rooms, swipe right = read, left = snooze

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatRoomListScreen(repo: ChatRepository, onOpenRoom: (String) -> Unit, onGrid: () -> Unit = {}) {
    val rooms by repo.observeRooms().collectAsState(initial = emptyList())
    val initialSyncing by repo.initialSyncing.collectAsState()
    val scope = rememberCoroutineScope()
    val now = System.currentTimeMillis()
    var searchQuery by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var snoozeTarget by remember { mutableStateOf<ChatRoomRow?>(null) }
    var menuTarget by remember { mutableStateOf<ChatRoomRow?>(null) }
    // Prior-state snapshot for the 5s mark-read undo bar (SPA undo toast).
    var undoRoom by remember { mutableStateOf<ChatRoomRow?>(null) }

    fun markReadWithUndo(room: ChatRoomRow) {
        undoRoom = room
        scope.launch { repo.markRead(room.id) }
    }
    LaunchedEffect(undoRoom?.id) {
        if (undoRoom != null) { kotlinx.coroutines.delay(5000); undoRoom = null }
    }

    // Search reaches EVERY cached room (read/snoozed/muted included) — the
    // list itself is inbox-zero. Blank query shows the 20 most-recent rooms
    // (SPA SearchOverlay), so opening search immediately shows something.
    val searchResults = remember(rooms, searchQuery) {
        if (searchQuery.isBlank()) rooms.sortedByDescending { it.lastMessageTime }.take(20)
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
        if (initialSyncing) {
            Row(
                Modifier.fillMaxWidth()
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f))
                    .padding(horizontal = 14.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                Text(
                    "Hub initial sync — loading your chats…",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
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
            // Pull-to-refresh still available over the empty state.
            PullToRefreshList(repo, scope) {
                item {
                    Box(Modifier.fillParentMaxSize(), contentAlignment = Alignment.Center) {
                        EmptyState(
                            Icons.AutoMirrored.Outlined.Chat,
                            "Inbox zero",
                            "Unread conversations appear here — search reaches everything",
                        )
                    }
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
        PullToRefreshList(repo, scope) {
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
                    positionalThreshold = { totalDistance -> totalDistance * 0.5f },
                    confirmValueChange = { value ->
                        when (value) {
                            SwipeToDismissBoxValue.StartToEnd -> { markReadWithUndo(room); true }
                            SwipeToDismissBoxValue.EndToStart -> { snoozeTarget = room; false }
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
    // 5s mark-read undo bar (SPA "Marked read" toast).
    undoRoom?.let { room ->
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
            Row(
                Modifier
                    .padding(16.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.inverseSurface)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text("Marked read", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.inverseOnSurface)
                Text(
                    "UNDO", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.inversePrimary,
                    modifier = Modifier.clickable {
                        scope.launch { repo.undoMarkRead(room) }; undoRoom = null
                    },
                )
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

/** Room list wrapped in a pull-to-refresh box → repo.syncNow() (SPA mobile
 *  hubBus.rpc('matrix','syncNow')). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PullToRefreshList(
    repo: ChatRepository,
    scope: kotlinx.coroutines.CoroutineScope,
    content: LazyListScope.() -> Unit,
) {
    var refreshing by remember { mutableStateOf(false) }
    androidx.compose.material3.pulltorefresh.PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            scope.launch { try { repo.syncNow() } finally { refreshing = false } }
        },
        modifier = Modifier.fillMaxSize(),
    ) {
        LazyColumn(Modifier.fillMaxSize(), content = content)
    }
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
            onPick = { untilMs -> scope.launch { repo.snooze(room.id, untilMs) }; onSnoozeDismiss() },
        )
    }
    menuTarget?.let { room ->
        val context = androidx.compose.ui.platform.LocalContext.current
        RoomContextSheet(
            room = room,
            onDismiss = onMenuDismiss,
            onMarkRead = { scope.launch { repo.markRead(room.id) } },
            onMarkUnread = { scope.launch { repo.markUnread(room.id) } },
            onSnooze = { onMenuDismiss(); onSnoozeRequest(room) },
            onTogglePin = { scope.launch { repo.setPinned(room.id, !room.isPinned) } },
            onToggleMute = { scope.launch { repo.setMuted(room.id, !room.isMuted) } },
            onToggleLowPriority = { scope.launch { repo.setLowPriority(room.id, !room.isLowPriority) } },
            onReload = {
                scope.launch {
                    repo.reloadRoom(room.id)
                    android.widget.Toast.makeText(context, "Room reloaded", android.widget.Toast.LENGTH_SHORT).show()
                }
            },
        )
    }
}

/** Bottom-sheet snooze picker (SPA SnoozePicker parity). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SnoozeSheet(onDismiss: () -> Unit, onPick: (Long) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val timeFmt = remember { SimpleDateFormat("HH:mm", Locale.UK) }
    val laterToday = remember { io.amar.console.data.chat.SnoozeTimes.laterToday() }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Text("Snooze until", style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
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
            Text(description, style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Long-press room context menu: read state, snooze, pin, mute, low-priority, reload. */
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
    onToggleLowPriority: () -> Unit = {},
    onReload: () -> Unit = {},
) {
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(room.name, style = MaterialTheme.typography.titleSmall,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
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
            if (room.isPinned) "Unpin" else "Pin", onTogglePin,
        )
        item(
            if (room.isMuted) Icons.Filled.NotificationsOff else Icons.Outlined.NotificationsOff,
            if (room.isMuted) "Unmute" else "Mute", onToggleMute,
        )
        item(
            Icons.Filled.SouthEast,
            if (room.isLowPriority) "Restore to inbox" else "Demote to low priority",
            onToggleLowPriority,
        )
        item(Icons.Filled.Refresh, "Reload room", onReload)
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
    ) { Icon(icon, contentDescription = null, tint = color) }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun RoomRow(room: ChatRoomRow, onClick: () -> Unit, onLongPress: (() -> Unit)? = null) {
    val now = System.currentTimeMillis()
    val isSnoozed = room.snoozedUntil != null && room.snoozedUntil > now
    val rowAlpha = if (isSnoozed) 0.5f else 1f
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongPress)
            .padding(horizontal = 14.dp, vertical = 9.dp)
            .alpha(rowAlpha),
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
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (room.isPinned) {
                    Icon(Icons.Filled.PushPin, contentDescription = "Pinned",
                        modifier = Modifier.size(12.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f))
                }
                Text(
                    room.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (isSnoozed) {
                    Icon(Icons.Filled.Schedule, contentDescription = "Snoozed",
                        modifier = Modifier.size(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    if (isSnoozed) formatListTime(room.snoozedUntil!!) else formatListTime(room.lastMessageTime),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (room.unreadCount > 0 && !isSnoozed) MaterialTheme.colorScheme.primary
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
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
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
    var editingMsg by remember { mutableStateOf<ChatMessageRow?>(null) }
    var editNonce by remember { mutableIntStateOf(0) }
    var lightboxIndex by remember { mutableStateOf<Int?>(null) }
    val context = androidx.compose.ui.platform.LocalContext.current

    LaunchedEffect(roomId) { repo.ensureMessages(roomId) }

    var frozenLastReadTs by remember(roomId) { mutableStateOf<Long?>(null) }
    var myUserId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { myUserId = repo.myUserId() }
    LaunchedEffect(messages.isNotEmpty()) { if (myUserId == null) myUserId = repo.myUserId() }
    LaunchedEffect(room?.id) {
        if (frozenLastReadTs == null && room != null && room!!.isUnread) frozenLastReadTs = room!!.lastReadTs
    }
    val dividerMsgId = remember(messages, frozenLastReadTs, myUserId) {
        io.amar.console.data.chat.ChatEvents.unreadDividerMessageId(messages, frozenLastReadTs, myUserId)
    }
    val receiptsByMsg = remember(room?.rawJson, messages) {
        io.amar.console.data.chat.ChatEvents.receiptsByMessage(
            io.amar.console.data.chat.ChatEvents.parseReadReceipts(room?.rawJson), messages,
        )
    }

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
            } finally { openingMediaId = null }
        }
    }

    // Composer text mirror + @-mention + emoji autocomplete state.
    var composerText by remember(roomId) { mutableStateOf("") }
    var members by remember(roomId) { mutableStateOf<List<ChatRepository.RoomMember>>(emptyList()) }
    val pickedMentions = remember(roomId) { mutableStateListOf<io.amar.console.data.chat.Mentions.Mention>() }
    val composerHandle = remember(roomId) { io.amar.console.ui.components.ComposerHandle() }
    val mentionQuery = remember(composerText) { io.amar.console.data.chat.Mentions.activeQuery(composerText) }
    val emojiQuery = remember(composerText) { activeEmojiQuery(composerText) }
    val emojiSuggestions = remember(emojiQuery) {
        emojiQuery?.let { io.amar.console.data.chat.EmojiShortcodes.search(it.second, 8) } ?: emptyList()
    }
    // Prime members on room open so the first '@' isn't blank (SPA primeRoomMembers).
    LaunchedEffect(roomId) { members = repo.roomMembers(roomId) }
    LaunchedEffect(mentionQuery != null) {
        if (mentionQuery != null && members.isEmpty()) members = repo.roomMembers(roomId)
    }
    val mentionSuggestions = remember(mentionQuery, members) {
        mentionQuery?.let { io.amar.console.data.chat.Mentions.filterMembers(members, it.query) } ?: emptyList()
    }
    fun mentionsFor(body: String): io.amar.console.data.chat.Mentions.Formatted? {
        val candidates = pickedMentions + members.map {
            io.amar.console.data.chat.Mentions.Mention(it.displayName, it.userId)
        }
        return io.amar.console.data.chat.Mentions.buildMentionsFormatted(body, candidates)
    }

    // Image gallery for the lightbox: every image message in the window.
    val galleryImages = remember(messages) {
        messages.filter { it.msgtype == "m.image" && !it.isDeleted }
            .sortedBy { it.timestamp }
            .mapNotNull { it.localMediaPath ?: MatrixMedia.downloadUrl(it.mediaMxc) }
    }
    // External profile link (rooms/:id/info externalProfile), fetched once.
    var externalProfile by remember(roomId) { mutableStateOf<Pair<String, String>?>(null) }
    LaunchedEffect(roomId) { externalProfile = repo.externalProfile(roomId) }

    Column(Modifier.fillMaxSize().imePadding()) {
        PaneTopBar(
            title = room?.name ?: "…",
            subtitle = listOfNotNull(
                room?.networkIcon,
                room?.memberCount?.takeIf { it > 2 && room?.isDirect == false }?.let { "$it members" },
            ).joinToString(" · ").ifEmpty { null },
            onBack = onBack,
            actions = {
                externalProfile?.let { (network, url) ->
                    val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
                    androidx.compose.material3.IconButton(onClick = { runCatching { uriHandler.openUri(url) } }) {
                        Icon(Icons.Filled.OpenInNew, contentDescription = "Open $network profile",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                    }
                }
                if (room?.isUnread == true) {
                    androidx.compose.material3.IconButton(onClick = { scope.launch { repo.markRead(roomId) } }) {
                        Icon(Icons.Filled.DoneAll, contentDescription = "Mark read",
                            tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                    }
                }
            },
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
        if (messages.isEmpty() && !loadingOlder) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No messages yet", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            reverseLayout = true,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 6.dp),
        ) {
            items(messages, key = { it.id }) { msg ->
                val idx = messages.indexOfFirst { it.id == msg.id }
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
                        myUserId = myUserId,
                        showSender = groupStart && !isMine && room?.isDirect == false,
                        showAvatar = groupStart && !isMine && room?.isDirect == false,
                        avatarGutter = room?.isDirect == false,
                        receipts = receiptsByMsg[msg.id],
                        openingMedia = openingMediaId == msg.id,
                        onRetry = { scope.launch { repo.retryFailed(msg.id) } },
                        onLongPress = { reactTarget = msg },
                        onReply = { replyingTo = msg },
                        onImageTap = { url ->
                            val i = galleryImages.indexOf(url)
                            lightboxIndex = if (i >= 0) i else 0
                        },
                        onMediaOpen = { openMedia(msg) },
                        onReact = { emoji -> scope.launch { repo.sendReaction(roomId, msg.id, emoji) } },
                        resolveArchived = { repo.archivedEvent(roomId, msg.id) },
                        resolveMediaFile = { repo.mediaFile(context, msg) },
                        resolvePreview = { repo.urlPreview(it) },
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
                Icon(androidx.compose.material.icons.Icons.Filled.KeyboardArrowDown, contentDescription = "Jump to bottom")
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
        var didInitialScroll by remember(roomId) { mutableStateOf(false) }
        LaunchedEffect(dividerMsgId, messages.size) {
            if (didInitialScroll || dividerMsgId == null || messages.isEmpty()) return@LaunchedEffect
            val idx = messages.indexOfFirst { it.id == dividerMsgId }
            if (idx >= 0) { didInitialScroll = true; listState.scrollToItem(idx) }
        }
        // Auto-scroll to the newest message when it's MINE (SPA: always scroll
        // to own sends). reverseLayout → index 0 is the bottom.
        val newestId = messages.firstOrNull()?.id
        var lastOwnScrolled by remember(roomId) { mutableStateOf<String?>(null) }
        LaunchedEffect(newestId) {
            val newest = messages.firstOrNull() ?: return@LaunchedEffect
            val mine = newest.localEcho || newest.senderId == "me" ||
                (myUserId != null && newest.senderId == myUserId)
            if (mine && newest.id != lastOwnScrolled) {
                lastOwnScrolled = newest.id
                if (didInitialScroll) listState.animateScrollToItem(0)
            }
        }
        // Edit-mode bar (blue): pre-fills the composer with the target body,
        // keyed on editNonce so re-editing the same message re-arms (SPA).
        LaunchedEffect(editNonce) {
            editingMsg?.let { composerHandle.setText(it.body ?: "") }
        }
        editingMsg?.let { target ->
            Row(
                Modifier.fillMaxWidth()
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.14f))
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Editing message", style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
                Icon(Icons.Filled.Close, contentDescription = "Cancel edit",
                    modifier = Modifier.size(16.dp).clickable { editingMsg = null; composerHandle.setText("") },
                    tint = MaterialTheme.colorScheme.primary)
            }
        }
        // Reply preview pill (hidden while editing).
        if (editingMsg == null) replyingTo?.let { target ->
            Row(
                Modifier.fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f))
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Replying to ${target.senderName ?: target.senderId}",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    Text(target.body ?: "", style = MaterialTheme.typography.bodySmall,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Icon(Icons.Filled.Close, contentDescription = "Cancel reply",
                    modifier = Modifier.size(16.dp).clickable { replyingTo = null },
                    tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Composer(
            placeholder = "Message",
            draftKey = "chat:$roomId",
            onSend = { text ->
                val editing = editingMsg
                if (editing != null) {
                    editingMsg = null
                    val fmt = mentionsFor(text)
                    scope.launch { repo.editMessage(roomId, editing.id, text, fmt?.formattedBody, fmt?.userIds ?: emptyList()) }
                } else {
                    val replyId = replyingTo?.id
                    replyingTo = null
                    val fmt = mentionsFor(text)
                    pickedMentions.clear()
                    scope.launch {
                        repo.sendText(roomId, text, replyId, fmt?.formattedBody, fmt?.userIds ?: emptyList())
                        repo.markRead(roomId)
                    }
                }
            },
            onTextChange = { composerText = it; onComposerChange(it) },
            onSendWithAttachments = { text, uris ->
                scope.launch {
                    uris.forEachIndexed { i, uri ->
                        repo.sendAttachment(context, roomId, uri, if (i == 0) text.ifBlank { null } else null)
                    }
                    repo.markRead(roomId)
                }
            },
            handle = composerHandle,
            aboveInput = when {
                emojiSuggestions.isNotEmpty() -> {
                    {
                        EmojiSuggestionRow(emojiSuggestions) { match ->
                            val q = activeEmojiQuery(composerHandle.text)
                            if (q != null) composerHandle.setText(insertEmoji(composerHandle.text, q, match.emoji))
                        }
                    }
                }
                mentionSuggestions.isNotEmpty() -> {
                    {
                        MentionSuggestionRow(mentionSuggestions) { member ->
                            val q = io.amar.console.data.chat.Mentions.activeQuery(composerHandle.text)
                            if (q != null) {
                                composerHandle.setText(
                                    io.amar.console.data.chat.Mentions.insert(composerHandle.text, q, member.displayName)
                                )
                                pickedMentions.add(io.amar.console.data.chat.Mentions.Mention(member.displayName, member.userId))
                            }
                        }
                    }
                }
                else -> null
            },
        )
    }

    reactTarget?.let { target ->
        val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
        val canEdit = !target.isDeleted && !target.localEcho &&
            (target.senderId == "me" || (myUserId != null && target.senderId == myUserId)) &&
            (target.msgtype == "m.text" || target.msgtype == "m.notice")
        QuickReactSheet(
            target = target,
            canEdit = canEdit,
            onDismiss = { reactTarget = null },
            onReact = { emoji -> scope.launch { repo.sendReaction(roomId, target.id, emoji) } },
            onReply = { replyingTo = target },
            onEdit = { editingMsg = target; editNonce++ },
            onCopy = { clipboard.setText(androidx.compose.ui.text.AnnotatedString(target.body ?: "")) },
        )
    }
    lightboxIndex?.let { start ->
        LightboxGallery(images = galleryImages, startIndex = start, onClose = { lightboxIndex = null })
    }
}

/** Full-screen image lightbox with ←/→ paging + "i / total" counter. */
@Composable
private fun LightboxGallery(images: List<String>, startIndex: Int, onClose: () -> Unit) {
    if (images.isEmpty()) { onClose(); return }
    var index by remember { mutableIntStateOf(startIndex.coerceIn(0, images.size - 1)) }
    androidx.compose.ui.window.Dialog(
        onDismissRequest = onClose,
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black).clickable { onClose() },
            contentAlignment = Alignment.Center,
        ) {
            val model: Any = images[index].let {
                if (it.startsWith("/") || it.startsWith("file:")) java.io.File(it.removePrefix("file://")) else it
            }
            AsyncImage(model = model, contentDescription = null, modifier = Modifier.fillMaxWidth())
            if (images.size > 1) {
                if (index > 0) {
                    androidx.compose.material3.IconButton(onClick = { index-- },
                        modifier = Modifier.align(Alignment.CenterStart).padding(8.dp)) {
                        Icon(Icons.Filled.ChevronLeft, contentDescription = "Previous",
                            tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(36.dp))
                    }
                }
                if (index < images.size - 1) {
                    androidx.compose.material3.IconButton(onClick = { index++ },
                        modifier = Modifier.align(Alignment.CenterEnd).padding(8.dp)) {
                        Icon(Icons.Filled.ChevronRight, contentDescription = "Next",
                            tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(36.dp))
                    }
                }
                Text(
                    "${index + 1} / ${images.size}",
                    style = MaterialTheme.typography.labelMedium,
                    color = androidx.compose.ui.graphics.Color.White,
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 24.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.5f))
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
        }
    }
}

// Quick-react sheet (long-press a bubble) + reply/edit/copy actions.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun QuickReactSheet(
    target: ChatMessageRow,
    canEdit: Boolean,
    onDismiss: () -> Unit,
    onReact: (String) -> Unit,
    onReply: () -> Unit,
    onEdit: () -> Unit,
    onCopy: () -> Unit,
) {
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            for (emoji in listOf("👍", "❤️", "😂", "😮", "😢", "🙏")) {
                Text(emoji, style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.clickable { onReact(emoji); onDismiss() }.padding(6.dp))
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            androidx.compose.material3.TextButton(onClick = { onReply(); onDismiss() }) { Text("↩ Reply") }
            if (canEdit) androidx.compose.material3.TextButton(onClick = { onEdit(); onDismiss() }) { Text("✎ Edit") }
            androidx.compose.material3.TextButton(onClick = { onCopy(); onDismiss() }) { Text("⧉ Copy text") }
        }
        androidx.compose.foundation.layout.Spacer(Modifier.size(24.dp))
    }
}

/** "— New —" unread divider row. */
@Composable
private fun UnreadDivider() {
    val red = androidx.compose.ui.graphics.Color(0xFFF87171)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        androidx.compose.material3.HorizontalDivider(Modifier.weight(1f), color = red.copy(alpha = 0.6f))
        Text("NEW", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium, color = red)
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
        Modifier.fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items(suggestions, key = { it.userId }) { member ->
            Row(
                Modifier.clip(RoundedCornerShape(14.dp))
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

/** Emoji shortcode ':query' → strip of matches above the composer. */
@Composable
private fun EmojiSuggestionRow(
    suggestions: List<io.amar.console.data.chat.EmojiShortcodes.Match>,
    onPick: (io.amar.console.data.chat.EmojiShortcodes.Match) -> Unit,
) {
    androidx.compose.foundation.lazy.LazyRow(
        Modifier.fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items(suggestions, key = { it.shortcode }) { match ->
            Row(
                Modifier.clip(RoundedCornerShape(14.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .clickable { onPick(match) }
                    .padding(horizontal = 10.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(match.emoji, style = MaterialTheme.typography.bodyLarge)
                Text(":${match.shortcode}:", style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
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
            Text("+${receipts.size - 3}", style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Download/decrypt then ACTION_VIEW via FileProvider (video/file bubbles). */
private fun openViaFileProvider(context: android.content.Context, file: java.io.File, mime: String?) {
    val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    val resolvedMime = mime
        ?: android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase())
        ?: "application/octet-stream"
    val intent = android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
        setDataAndType(uri, resolvedMime)
        addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    runCatching { context.startActivity(intent) }
        .onFailure {
            android.widget.Toast.makeText(context, "No app can open this file", android.widget.Toast.LENGTH_SHORT).show()
        }
}

/** Voice-note / audio player: play/pause, waveform (or bar), click-to-seek,
 *  speed cycle (1×→1.5×→2×), download (SPA AudioBubble). */
@Composable
private fun AudioBubble(msg: ChatMessageRow, resolveFile: suspend () -> java.io.File) {
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    var playing by remember(msg.id) { mutableStateOf(false) }
    var preparing by remember(msg.id) { mutableStateOf(false) }
    var positionMs by remember(msg.id) { mutableIntStateOf(0) }
    var durationMs by remember(msg.id) { mutableIntStateOf(msg.mediaDurationMs?.toInt() ?: 0) }
    val prefs = remember { context.getSharedPreferences("console:chat", android.content.Context.MODE_PRIVATE) }
    var speed by remember(msg.id) { mutableStateOf(prefs.getFloat("audioRate", 1f)) }
    val player = remember(msg.id) { arrayOfNulls<android.media.MediaPlayer>(1) }
    val waveform = remember(msg.waveformJson) {
        runCatching {
            (Json.parseToJsonElement(msg.waveformJson ?: "[]") as? JsonArray)
                ?.mapNotNull { it.jsonPrimitive.content.toFloatOrNull() } ?: emptyList()
        }.getOrElse { emptyList() }
    }

    androidx.compose.runtime.DisposableEffect(msg.id) {
        onDispose { runCatching { player[0]?.release() }; player[0] = null }
    }
    LaunchedEffect(playing) {
        while (playing) {
            player[0]?.let { p ->
                runCatching {
                    positionMs = p.currentPosition
                    if (durationMs <= 0 && p.duration > 0) durationMs = p.duration
                }
            }
            kotlinx.coroutines.delay(120)
        }
    }
    fun applySpeed(mp: android.media.MediaPlayer) {
        runCatching { mp.playbackParams = mp.playbackParams.setSpeed(speed).setPitch(1f) }
    }
    fun toggle() {
        val p = player[0]
        when {
            p != null && playing -> { runCatching { p.pause() }; playing = false }
            p != null -> { runCatching { applySpeed(p); p.start() }; playing = true }
            !preparing -> {
                preparing = true
                scope.launch {
                    try {
                        val file = resolveFile()
                        val mp = android.media.MediaPlayer()
                        mp.setDataSource(file.absolutePath)
                        mp.setOnCompletionListener { playing = false; positionMs = 0; runCatching { it.seekTo(0) } }
                        mp.prepare()
                        if (durationMs <= 0) durationMs = mp.duration
                        player[0] = mp
                        applySpeed(mp)
                        mp.start()
                        playing = true
                    } catch (_: Exception) { playing = false } finally { preparing = false }
                }
            }
        }
    }
    fun seekFraction(frac: Float) {
        val d = durationMs
        if (d <= 0) return
        val target = (frac.coerceIn(0f, 1f) * d).toInt()
        positionMs = target
        runCatching { player[0]?.seekTo(target) }
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(vertical = 4.dp).widthIn(min = 200.dp),
    ) {
        Box(
            Modifier.size(34.dp).clip(androidx.compose.foundation.shape.CircleShape)
                .background(MaterialTheme.colorScheme.primary)
                .clickable(enabled = !preparing) { toggle() },
            contentAlignment = Alignment.Center,
        ) {
            if (preparing) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
            } else {
                Icon(if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = if (playing) "Pause" else "Play",
                    tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(20.dp))
            }
        }
        Column(Modifier.weight(1f)) {
            val progress = if (durationMs > 0) positionMs.toFloat() / durationMs else 0f
            if (waveform.isNotEmpty()) {
                WaveformBar(waveform, progress) { seekFraction(it) }
            } else {
                Box(
                    Modifier.fillMaxWidth().height(20.dp).pointerInput(durationMs) {
                        detectTapGestures { off -> seekFraction(off.x / size.width) }
                    },
                    contentAlignment = Alignment.CenterStart,
                ) {
                    androidx.compose.material3.LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                }
            }
            Text(
                formatAudioTime(if (playing || positionMs > 0) positionMs else durationMs),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        Text(
            "${if (speed % 1f == 0f) speed.toInt().toString() else speed.toString()}×",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable {
                speed = when (speed) { 1f -> 1.5f; 1.5f -> 2f; else -> 1f }
                prefs.edit().putFloat("audioRate", speed).apply()
                player[0]?.let { if (playing) applySpeed(it) }
            }.padding(horizontal = 4.dp, vertical = 2.dp),
        )
        Icon(
            Icons.Filled.Download, contentDescription = "Download",
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp).clickable {
                scope.launch {
                    runCatching {
                        val src = resolveFile()
                        val name = msg.body?.takeIf { it.contains('.') }
                            ?: if (msg.mediaMime == "audio/ogg") "voice.ogg" else "audio.mp3"
                        val dl = android.os.Environment.getExternalStoragePublicDirectory(
                            android.os.Environment.DIRECTORY_DOWNLOADS)
                        src.copyTo(java.io.File(dl, name), overwrite = true)
                        android.widget.Toast.makeText(context, "Saved to Downloads", android.widget.Toast.LENGTH_SHORT).show()
                    }.onFailure {
                        android.widget.Toast.makeText(context, "Download failed", android.widget.Toast.LENGTH_SHORT).show()
                    }
                }
            },
        )
    }
}

/** Canvas waveform (≤48 bars), progress-coloured, click-to-seek. */
@Composable
private fun WaveformBar(waveform: List<Float>, progress: Float, onSeek: (Float) -> Unit) {
    val played = MaterialTheme.colorScheme.primary
    val unplayed = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
    val bars = remember(waveform) {
        if (waveform.size <= 48) waveform
        else (0 until 48).map { i -> waveform[(i * waveform.size / 48).coerceIn(0, waveform.size - 1)] }
    }
    val maxAmp = remember(bars) { (bars.maxOrNull() ?: 1f).coerceAtLeast(1f) }
    androidx.compose.foundation.Canvas(
        Modifier.fillMaxWidth().height(24.dp).pointerInput(bars) {
            detectTapGestures { off -> onSeek(off.x / size.width) }
        },
    ) {
        val n = bars.size
        if (n == 0) return@Canvas
        val gap = size.width / n
        val barW = gap * 0.6f
        for (i in 0 until n) {
            val h = (bars[i] / maxAmp) * size.height
            val x = i * gap + (gap - barW) / 2
            val played01 = (i + 0.5f) / n <= progress
            drawRect(
                color = if (played01) played else unplayed,
                topLeft = androidx.compose.ui.geometry.Offset(x, (size.height - h) / 2),
                size = androidx.compose.ui.geometry.Size(barW, h.coerceAtLeast(2f)),
            )
        }
    }
}

private fun formatAudioTime(ms: Int): String {
    if (ms <= 0) return "0:00"
    val totalSec = ms / 1000
    return "%d:%02d".format(totalSec / 60, totalSec % 60)
}

@OptIn(
    androidx.compose.foundation.ExperimentalFoundationApi::class,
    ExperimentalMaterial3Api::class,
    androidx.compose.foundation.layout.ExperimentalLayoutApi::class,
)
@Composable
private fun MessageBubble(
    msg: ChatMessageRow,
    isMine: Boolean,
    myUserId: String? = null,
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
    resolveArchived: (suspend () -> ChatRepository.ArchivedEvent?)? = null,
    resolveMediaFile: (suspend () -> java.io.File)? = null,
    resolvePreview: (suspend (String) -> ChatRepository.UrlPreview?)? = null,
) {
    // Swipe-right-to-reply: drag up to 80px, fire past 50px.
    val density = androidx.compose.ui.platform.LocalDensity.current
    val maxDragPx = with(density) { 80.dp.toPx() }
    val triggerPx = with(density) { 50.dp.toPx() }
    val offsetX = remember(msg.id) { androidx.compose.animation.core.Animatable(0f) }
    val swipeScope = rememberCoroutineScope()
    val swipeMod = if (msg.isDeleted) Modifier else Modifier.pointerInput(msg.id) {
        detectHorizontalDragGestures(
            onDragEnd = {
                if (offsetX.value >= triggerPx) onReply()
                swipeScope.launch { offsetX.animateTo(0f, androidx.compose.animation.core.tween(200)) }
            },
        ) { _, dragAmount ->
            val next = (offsetX.value + dragAmount).coerceIn(0f, maxDragPx)
            swipeScope.launch { offsetX.snapTo(next) }
        }
    }
    Box {
        if (offsetX.value > 4f) {
            Icon(
                Icons.AutoMirrored.Filled.Reply, contentDescription = null,
                tint = MaterialTheme.colorScheme.primary.copy(alpha = (offsetX.value / triggerPx).coerceIn(0f, 1f)),
                modifier = Modifier.align(Alignment.CenterStart).padding(start = 16.dp).size(20.dp),
            )
        }
    Row(
        Modifier.fillMaxWidth().then(swipeMod)
            .offset { androidx.compose.ui.unit.IntOffset(offsetX.value.toInt(), 0) }
            .padding(horizontal = 12.dp, vertical = 1.dp),
        horizontalArrangement = if (isMine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        if (!isMine && showAvatar) {
            Box(Modifier.padding(end = 6.dp)) {
                Avatar(name = msg.senderName ?: msg.senderId, imageUrl = null, size = 28.dp)
            }
        } else if (!isMine && avatarGutter) {
            androidx.compose.foundation.layout.Spacer(Modifier.size(34.dp))
        }
        Column(
            Modifier.widthIn(max = 300.dp)
                .clip(RoundedCornerShape(
                    topStart = 14.dp, topEnd = 14.dp,
                    bottomStart = if (isMine) 14.dp else 4.dp,
                    bottomEnd = if (isMine) 4.dp else 14.dp,
                ))
                .background(
                    if (isMine) MaterialTheme.colorScheme.primary.copy(alpha = 0.22f)
                    else MaterialTheme.colorScheme.surfaceVariant
                )
                .combinedClickable(onClick = {}, onLongClick = onLongPress)
                .padding(horizontal = 11.dp, vertical = 6.dp),
        ) {
            // Reply quote (m.in_reply_to context)
            msg.replyToJson?.let { rj ->
                val reply = remember(rj) { runCatching { Json.parseToJsonElement(rj).jsonObject }.getOrNull() }
                val rSender = reply?.get("sender")?.jsonPrimitive?.content
                val rBody = reply?.get("body")?.jsonPrimitive?.content
                if (rBody != null || rSender != null) {
                    Column(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.background.copy(alpha = 0.5f))
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    ) {
                        rSender?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary) }
                        rBody?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            if (showSender && msg.senderName != null) {
                val hue = ((msg.senderId.hashCode() % 360) + 360) % 360
                Text(msg.senderName!!, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
                    color = androidx.compose.ui.graphics.Color.hsv(hue.toFloat(), 0.5f, 0.9f))
            }
            if (msg.msgtype == "m.image" && msg.localMediaPath != null && !msg.isDeleted) {
                AsyncImage(
                    model = java.io.File(msg.localMediaPath!!), contentDescription = msg.body,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(9.dp))
                        .clickable { onImageTap(msg.localMediaPath!!) }.padding(vertical = 2.dp),
                )
            } else if (msg.msgtype == "m.image" && msg.encryptedFileJson != null && !msg.isDeleted && resolveMediaFile != null) {
                // E2EE image: decrypt to a cached file, render the plaintext.
                var localFile by remember(msg.id) { mutableStateOf<java.io.File?>(null) }
                LaunchedEffect(msg.id) { localFile = runCatching { resolveMediaFile() }.getOrNull() }
                if (localFile != null) {
                    AsyncImage(
                        model = localFile, contentDescription = msg.body,
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(9.dp))
                            .clickable { onImageTap(localFile!!.absolutePath) }.padding(vertical = 2.dp),
                    )
                } else {
                    Box(
                        Modifier.fillMaxWidth().aspectRatio(4f / 3f).clip(RoundedCornerShape(9.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant),
                        contentAlignment = Alignment.Center,
                    ) { CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp) }
                }
            } else if (msg.msgtype == "m.image" && msg.mediaMxc != null && !msg.isDeleted) {
                AsyncImage(
                    model = MatrixMedia.thumbnailUrl(msg.mediaMxc, 512, 512), contentDescription = msg.body,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(9.dp))
                        .clickable { MatrixMedia.downloadUrl(msg.mediaMxc)?.let(onImageTap) }.padding(vertical = 2.dp),
                )
            } else if (msg.msgtype == "m.video" && (msg.mediaMxc != null || msg.encryptedFileJson != null) && !msg.isDeleted) {
                Box(
                    Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(9.dp))
                        .background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.55f))
                        .clickable(enabled = !openingMedia) { onMediaOpen() }.padding(vertical = 2.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    if (openingMedia) CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
                    else Icon(
                        Icons.Filled.PlayArrow, contentDescription = "Play video",
                        tint = androidx.compose.ui.graphics.Color.White,
                        modifier = Modifier.size(52.dp).clip(androidx.compose.foundation.shape.CircleShape)
                            .background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.5f)).padding(8.dp),
                    )
                }
            } else if (msg.msgtype == "m.audio" && (msg.mediaMxc != null || msg.encryptedFileJson != null) &&
                !msg.isDeleted && resolveMediaFile != null
            ) {
                AudioBubble(msg, resolveMediaFile)
            }
            if (msg.isDeleted) {
                DeletedMessageBody(msg, resolveArchived, onImageTap)
            } else {
                val displayBody = io.amar.console.data.chat.ChatEvents.displayBody(msg.body ?: "", msg.senderName)
                val bodyText = when {
                    msg.msgtype == "m.image" -> if (io.amar.console.data.chat.ChatFormat.isImageFilenameCaption(msg.body)) null else displayBody.ifEmpty { null }
                    msg.msgtype == "m.file" -> "📎 ${msg.body ?: "file"}"
                    msg.msgtype == "m.audio" -> null
                    msg.msgtype == "m.video" -> if (io.amar.console.data.chat.ChatFormat.isVideoFilenameCaption(msg.body)) null else displayBody.ifEmpty { null }
                    msg.msgtype == "m.emote" -> "* ${msg.senderName ?: ""} $displayBody"
                    else -> displayBody.ifEmpty { null }
                }
                if (bodyText != null) {
                    val isNotice = msg.msgtype == "m.notice"
                    val noticeStyle = if (isNotice) androidx.compose.ui.text.font.FontStyle.Italic else null
                    val noticeColor = if (isNotice) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface
                    if (msg.msgtype == "m.file" && (msg.mediaMxc != null || msg.encryptedFileJson != null)) {
                        Row(
                            Modifier.clickable(enabled = !openingMedia) { onMediaOpen() },
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            if (openingMedia) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                            Text(bodyText, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                        }
                    } else if (msg.isEdited && msg.originalBody != null) {
                        EditDiffText(msg.originalBody!!, bodyText)
                    } else if (msg.formattedBody != null) {
                        val html = remember(msg.formattedBody) {
                            androidx.compose.ui.text.AnnotatedString.Companion.fromHtml(
                                msg.formattedBody!!,
                                linkStyles = androidx.compose.ui.text.TextLinkStyles(
                                    style = androidx.compose.ui.text.SpanStyle(color = androidx.compose.ui.graphics.Color(0xFF60A5FA)),
                                ),
                            )
                        }
                        Text(html, style = MaterialTheme.typography.bodyMedium, fontStyle = noticeStyle, color = noticeColor)
                    } else {
                        val md = remember(bodyText) { io.amar.console.data.chat.MessageFormat.markdownToHtml(bodyText) }
                        if (md != null) {
                            val html = remember(md) {
                                androidx.compose.ui.text.AnnotatedString.Companion.fromHtml(
                                    md,
                                    linkStyles = androidx.compose.ui.text.TextLinkStyles(
                                        style = androidx.compose.ui.text.SpanStyle(color = androidx.compose.ui.graphics.Color(0xFF60A5FA)),
                                    ),
                                )
                            }
                            Text(html, style = MaterialTheme.typography.bodyMedium, fontStyle = noticeStyle, color = noticeColor)
                        } else {
                            LinkifiedText(bodyText, strikethrough = false, dim = isNotice, italic = isNotice)
                        }
                        if (resolvePreview != null && msg.msgtype == "m.text") {
                            val url = remember(bodyText) { firstUrlIn(bodyText) }
                            if (url != null) UrlPreviewCard(url, resolvePreview)
                        }
                    }
                }
            }
            msg.reactionsJson?.let { rj ->
                val reactions = remember(rj) {
                    runCatching {
                        Json.parseToJsonElement(rj).jsonObject.entries.map { (k, v) ->
                            k to ((v as? JsonArray)?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList())
                        }.filter { it.second.isNotEmpty() }
                    }.getOrElse { emptyList() }
                }
                var namesFor by remember(msg.id) { mutableStateOf<String?>(null) }
                if (reactions.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 2.dp)) {
                        for ((emoji, senders) in reactions.take(12)) {
                            val mine = senders.any { it == "me" || (myUserId != null && it == myUserId) }
                            Text(
                                if (senders.size > 1) "$emoji ${senders.size}" else emoji,
                                style = MaterialTheme.typography.labelSmall,
                                color = if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.clip(RoundedCornerShape(10.dp))
                                    .background(
                                        if (mine) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
                                        else MaterialTheme.colorScheme.background.copy(alpha = 0.5f)
                                    )
                                    .combinedClickable(
                                        onClick = { onReact(emoji) },
                                        onLongClick = {
                                            namesFor = "$emoji  " + senders.joinToString(", ") {
                                                if (it == "me") "You" else it.removePrefix("@").substringBefore(':')
                                            }
                                        },
                                    )
                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                    namesFor?.let { names ->
                        Text(names, style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 1.dp).clickable { namesFor = null })
                    }
                }
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.align(Alignment.End),
            ) {
                if (msg.isEdited && (msg.originalBody == null || msg.isDeleted)) {
                    Text("edited", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(formatBubbleTime(msg.timestamp), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                when {
                    msg.sendFailed -> {
                        Icon(Icons.Filled.ErrorOutline, msg.sendFailedReason ?: "Send failed",
                            tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(13.dp))
                        Icon(Icons.Filled.Refresh, "Retry", tint = MaterialTheme.colorScheme.error,
                            modifier = Modifier.size(15.dp).clickable(onClick = onRetry))
                    }
                    msg.localEcho -> Icon(Icons.Filled.Schedule, "Queued",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(12.dp))
                }
            }
        }
    }
    }
    if (!receipts.isNullOrEmpty()) ReadReceiptRow(receipts, isMine)
}

// ---------------------------------------------------------------------- //

/** Plain text with tappable URLs (linkification parity). */
@Composable
private fun LinkifiedText(text: String, strikethrough: Boolean, dim: Boolean, italic: Boolean = false) {
    val urlRegex = remember { Regex("https?://[^\\s]+") }
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
        fontStyle = if (italic) androidx.compose.ui.text.font.FontStyle.Italic else null,
        color = if (dim) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
    )
}

/** First bare http(s) URL in a text body (link-preview source). */
private fun firstUrlIn(body: String): String? =
    Regex("https?://[^\\s]+").find(body)?.value?.trimEnd('.', ',', ')', ']', '!', '?')

// ---- Emoji shortcode autocomplete (':query') — pure helpers ----

/** In-flight `:query` at the end of [text] (startIdx to query), or null. */
fun activeEmojiQuery(text: String): Pair<Int, String>? {
    val m = Regex(""":([a-z0-9_+-]+)$""").find(text) ?: return null
    return m.range.first to m.groupValues[1]
}

/** Replace the in-flight `:query` with the emoji + trailing space. */
fun insertEmoji(text: String, active: Pair<Int, String>, emoji: String): String {
    val before = text.substring(0, active.first)
    val after = text.substring(active.first + 1 + active.second.length)
    return "$before$emoji $after"
}

/** Inline word-diff for edited messages (SPA EditDiff). */
@Composable
private fun EditDiffText(original: String, edited: String) {
    val parts = remember(original, edited) { io.amar.console.data.chat.ChatFormat.wordDiff(original, edited) }
    val annotated = remember(parts) {
        androidx.compose.ui.text.buildAnnotatedString {
            for (p in parts) {
                when (p.kind) {
                    io.amar.console.data.chat.ChatFormat.DiffKind.REMOVED -> withStyle(
                        androidx.compose.ui.text.SpanStyle(
                            color = androidx.compose.ui.graphics.Color(0xFFF87171),
                            textDecoration = TextDecoration.LineThrough,
                        )
                    ) { append(p.text) }
                    io.amar.console.data.chat.ChatFormat.DiffKind.ADDED -> withStyle(
                        androidx.compose.ui.text.SpanStyle(color = androidx.compose.ui.graphics.Color(0xFF4ADE80))
                    ) { append(p.text) }
                    else -> append(p.text)
                }
            }
        }
    }
    Row(verticalAlignment = Alignment.Bottom) {
        Text(annotated, style = MaterialTheme.typography.bodyMedium)
        Text(" (edited)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Deleted message: recover original from the hub archive before falling
 *  back to "Message deleted" (SPA DeletedMessageBody). */
@Composable
private fun DeletedMessageBody(
    msg: ChatMessageRow,
    resolveArchived: (suspend () -> ChatRepository.ArchivedEvent?)?,
    onImageTap: (String) -> Unit,
) {
    var archived by remember(msg.id) { mutableStateOf<ChatRepository.ArchivedEvent?>(null) }
    var checked by remember(msg.id) { mutableStateOf(false) }
    LaunchedEffect(msg.id) {
        if (resolveArchived != null && !msg.id.startsWith("~")) archived = runCatching { resolveArchived() }.getOrNull()
        checked = true
    }
    val text = msg.body?.takeIf { it.isNotEmpty() } ?: archived?.body
    Column {
        val mediaUrl = archived?.mediaUrl
        if (mediaUrl != null && archived?.mimeType?.startsWith("image/") == true) {
            AsyncImage(
                model = mediaUrl, contentDescription = "Deleted attachment (recovered)",
                modifier = Modifier.widthIn(max = 240.dp).clip(RoundedCornerShape(6.dp))
                    .clickable { onImageTap(mediaUrl) }.padding(bottom = 2.dp),
            )
        } else if (mediaUrl != null) {
            Text("📎 recovered attachment", style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.clickable { onImageTap(mediaUrl) })
        }
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                text ?: (if (checked) "Message deleted" else "…"),
                style = MaterialTheme.typography.bodyMedium.copy(textDecoration = TextDecoration.LineThrough),
                color = androidx.compose.ui.graphics.Color(0xFFF87171).copy(alpha = 0.7f),
            )
            msg.deletedBy?.let {
                Text(" (deleted by ${it.removePrefix("@").substringBefore(':')})",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** Link preview card for the first URL in a text message (SPA getUrlPreview). */
@Composable
private fun UrlPreviewCard(url: String, resolve: suspend (String) -> ChatRepository.UrlPreview?) {
    var preview by remember(url) { mutableStateOf<ChatRepository.UrlPreview?>(null) }
    LaunchedEffect(url) { preview = runCatching { resolve(url) }.getOrNull() }
    val p = preview ?: return
    if (p.title == null && p.description == null && p.imageUrl == null) return
    val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
    Column(
        Modifier.padding(top = 4.dp).clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.background.copy(alpha = 0.4f))
            .clickable { runCatching { uriHandler.openUri(url) } }.widthIn(max = 260.dp),
    ) {
        p.imageUrl?.let {
            AsyncImage(model = it, contentDescription = null,
                modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f)
                    .clip(RoundedCornerShape(topStart = 8.dp, topEnd = 8.dp)))
        }
        Column(Modifier.padding(8.dp)) {
            p.title?.let {
                Text(it, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                    maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            p.description?.let {
                Text(it, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            (p.siteName ?: runCatching { java.net.URI(url).host }.getOrNull())?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, maxLines = 1)
            }
        }
    }
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
