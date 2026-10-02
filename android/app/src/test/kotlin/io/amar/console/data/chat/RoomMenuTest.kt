package io.amar.console.data.chat

import io.amar.console.data.db.ChatRoomRow
import org.junit.Assert.assertEquals
import org.junit.Test

private fun room(
    isUnread: Boolean = true,
    pinned: Boolean = false,
    muted: Boolean = false,
    lowPriority: Boolean = false,
) = ChatRoomRow(
    id = "!r1", name = "Alice", avatarMxc = null, isDirect = true, isUnread = isUnread,
    unreadCount = if (isUnread) 1 else 0, manualUnread = false,
    lastMessageBody = "hey", lastMessageSender = "Alice", lastMessageTime = 0L,
    lastReadEventId = null, isMuted = muted, isLowPriority = lowPriority, isEncrypted = false,
    memberCount = 2, networkIcon = null, snoozedUntil = null, prevBatch = null,
    isPinned = pinned, rawJson = "{}",
)

/** One menu for every surface (Chat list, Inbox rows, pinned strip) — the
 *  SPA's useRoomMenuItems set plus read/snooze, each toggle labelled by the
 *  room's CURRENT state. */
class RoomMenuTest {
    @Test
    fun `unread unpinned unmuted room offers the forward actions`() {
        assertEquals(
            listOf(
                RoomMenuAction.MARK_READ to "Mark read",
                RoomMenuAction.SNOOZE to "Snooze…",
                RoomMenuAction.PIN to "Pin",
                RoomMenuAction.MUTE to "Mute",
                RoomMenuAction.DEMOTE to "Demote to low priority",
                RoomMenuAction.RELOAD to "Reload room",
            ),
            roomMenuItems(room()).map { it.action to it.label },
        )
    }

    @Test
    fun `every toggle flips to its inverse from the room state`() {
        assertEquals(
            listOf(
                RoomMenuAction.MARK_UNREAD to "Mark unread",
                RoomMenuAction.SNOOZE to "Snooze…",
                RoomMenuAction.UNPIN to "Unpin",
                RoomMenuAction.UNMUTE to "Unmute",
                RoomMenuAction.RESTORE to "Restore to inbox",
                RoomMenuAction.RELOAD to "Reload room",
            ),
            roomMenuItems(room(isUnread = false, pinned = true, muted = true, lowPriority = true))
                .map { it.action to it.label },
        )
    }

    @Test
    fun `toggles are independent of each other`() {
        val items = roomMenuItems(room(pinned = true)).map { it.action }
        assertEquals(RoomMenuAction.UNPIN, items[2])
        assertEquals(RoomMenuAction.MUTE, items[3])
        assertEquals(RoomMenuAction.DEMOTE, items[4])
    }

    @Test
    fun `always six items, each action at most once`() {
        for (unread in listOf(true, false)) for (pinned in listOf(true, false)) for (muted in listOf(true, false)) {
            val items = roomMenuItems(room(isUnread = unread, pinned = pinned, muted = muted))
            assertEquals(6, items.size)
            assertEquals(6, items.map { it.action }.toSet().size)
        }
    }
}
