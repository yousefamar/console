package io.amar.console.data.chat

import io.amar.console.data.db.ChatRoomRow

/**
 * The room long-press menu as DATA — one definition for every surface that
 * shows it (Chat list, Inbox chat rows, Inbox pinned strip), the SPA's
 * `useRoomMenuItems` (RoomContextMenu.tsx) plus the phone's read/snooze
 * items. Rendering maps an action to an icon; wiring maps it to a
 * ChatRepository call.
 */
enum class RoomMenuAction {
    MARK_READ, MARK_UNREAD, SNOOZE, PIN, UNPIN, MUTE, UNMUTE, DEMOTE, RESTORE, RELOAD,
}

data class RoomMenuItem(val action: RoomMenuAction, val label: String)

fun roomMenuItems(room: ChatRoomRow): List<RoomMenuItem> = listOf(
    if (room.isUnread) RoomMenuItem(RoomMenuAction.MARK_READ, "Mark read")
    else RoomMenuItem(RoomMenuAction.MARK_UNREAD, "Mark unread"),
    RoomMenuItem(RoomMenuAction.SNOOZE, "Snooze…"),
    if (room.isPinned) RoomMenuItem(RoomMenuAction.UNPIN, "Unpin")
    else RoomMenuItem(RoomMenuAction.PIN, "Pin"),
    if (room.isMuted) RoomMenuItem(RoomMenuAction.UNMUTE, "Unmute")
    else RoomMenuItem(RoomMenuAction.MUTE, "Mute"),
    if (room.isLowPriority) RoomMenuItem(RoomMenuAction.RESTORE, "Restore to inbox")
    else RoomMenuItem(RoomMenuAction.DEMOTE, "Demote to low priority"),
    RoomMenuItem(RoomMenuAction.RELOAD, "Reload room"),
)
