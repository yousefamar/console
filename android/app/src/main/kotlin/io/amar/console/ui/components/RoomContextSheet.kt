package io.amar.console.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.MarkChatUnread
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material.icons.filled.SouthEast
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.chat.ChatRepository
import io.amar.console.data.chat.RoomMenuAction
import io.amar.console.data.chat.roomMenuItems
import io.amar.console.data.db.ChatRoomRow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Long-press room context menu: read state, snooze, pin, mute, low-priority, reload. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoomContextSheet(room: ChatRoomRow, onDismiss: () -> Unit, onAction: (RoomMenuAction) -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(
            room.name, style = MaterialTheme.typography.titleSmall,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
        )
        for (item in roomMenuItems(room)) {
            Row(
                Modifier.fillMaxWidth().clickable { onAction(item.action); onDismiss() }
                    .padding(horizontal = 20.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Icon(
                    iconFor(item.action), contentDescription = null, modifier = Modifier.size(20.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(item.label, style = MaterialTheme.typography.bodyMedium)
            }
        }
        Spacer(Modifier.size(24.dp))
    }
}

private fun iconFor(action: RoomMenuAction): ImageVector = when (action) {
    RoomMenuAction.MARK_READ -> Icons.Filled.DoneAll
    RoomMenuAction.MARK_UNREAD -> Icons.Filled.MarkChatUnread
    RoomMenuAction.SNOOZE -> Icons.Filled.Snooze
    RoomMenuAction.PIN -> Icons.Outlined.PushPin
    RoomMenuAction.UNPIN -> Icons.Filled.PushPin
    RoomMenuAction.MUTE -> Icons.Outlined.NotificationsOff
    RoomMenuAction.UNMUTE -> Icons.Filled.NotificationsOff
    RoomMenuAction.DEMOTE, RoomMenuAction.RESTORE -> Icons.Filled.SouthEast
    RoomMenuAction.RELOAD -> Icons.Filled.Refresh
}

/**
 * [RoomContextSheet] wired to the hub through [ChatRepository] — the same
 * composable behind the Chat list and the Inbox (one definition, two surfaces,
 * like the SPA's RoomContextMenu). Snooze is handed back via [onSnooze]: each
 * surface owns its own picker state. [launch] must outlive the sheet (a
 * screen/repository scope) — the sheet dismisses on tap, so a scope of its own
 * would cancel the RPC mid-flight.
 */
@Composable
fun RoomMenuSheet(
    repo: ChatRepository,
    room: ChatRoomRow,
    onDismiss: () -> Unit,
    launch: (suspend () -> Unit) -> Unit,
    onSnooze: () -> Unit,
) {
    val context = LocalContext.current
    RoomContextSheet(room, onDismiss) { action ->
        when (action) {
            RoomMenuAction.MARK_READ -> launch { repo.markRead(room.id) }
            RoomMenuAction.MARK_UNREAD -> launch { repo.markUnread(room.id) }
            RoomMenuAction.SNOOZE -> onSnooze()
            RoomMenuAction.PIN -> launch { repo.setPinned(room.id, true) }
            RoomMenuAction.UNPIN -> launch { repo.setPinned(room.id, false) }
            RoomMenuAction.MUTE -> launch { repo.setMuted(room.id, true) }
            RoomMenuAction.UNMUTE -> launch { repo.setMuted(room.id, false) }
            RoomMenuAction.DEMOTE -> launch { repo.setLowPriority(room.id, true) }
            RoomMenuAction.RESTORE -> launch { repo.setLowPriority(room.id, false) }
            RoomMenuAction.RELOAD -> launch {
                repo.reloadRoom(room.id)
                withContext(Dispatchers.Main) {
                    android.widget.Toast.makeText(context, "Room reloaded", android.widget.Toast.LENGTH_SHORT).show()
                }
            }
        }
    }
}
