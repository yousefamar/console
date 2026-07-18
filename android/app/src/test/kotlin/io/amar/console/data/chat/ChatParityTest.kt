package io.amar.console.data.chat

import io.amar.console.data.db.ChatMessageRow
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

/** Pure-logic tests for the chat parity batch: read-receipt grouping,
 *  unread-divider position, mention autocomplete, snooze targets. */
class ChatParityTest {

    private fun msg(
        id: String,
        ts: Long,
        sender: String = "@a:x",
        echo: Boolean = false,
    ) = ChatMessageRow(
        id = id, roomId = "!r", timestamp = ts, senderId = sender, senderName = null,
        body = "m", msgtype = "m.text", mediaMxc = null, mediaMime = null,
        encryptedFileJson = null, replyToJson = null, localEcho = echo,
    )

    // ------------------------------------------------------------------ //
    // Read receipts

    @Test
    fun `receipts parse from rawJson RoomState`() {
        val raw = """{"name":"R","readReceipts":{
            "@bob:x":{"eventId":"e2","ts":200,"displayName":"Bob"},
            "@carol:x":{"eventId":"e1","ts":100,"avatar":"mxc://x/av"}}}"""
        val receipts = ChatEvents.parseReadReceipts(raw)
        assertEquals(2, receipts.size)
        val bob = receipts.first { it.userId == "@bob:x" }
        assertEquals("e2", bob.eventId)
        assertEquals("Bob", bob.displayName)
        assertEquals("mxc://x/av", receipts.first { it.userId == "@carol:x" }.avatarMxc)
    }

    @Test
    fun `receipts group on the exact cached event`() {
        val messages = listOf(msg("e1", 100), msg("e2", 200), msg("e3", 300))
        val receipts = listOf(
            ChatEvents.ReadReceipt("@bob:x", "e2", 250, "Bob", null),
            ChatEvents.ReadReceipt("@carol:x", "e2", 260, "Carol", null),
        )
        val grouped = ChatEvents.receiptsByMessage(receipts, messages)
        assertEquals(setOf("e2"), grouped.keys)
        assertEquals(2, grouped["e2"]!!.size)
        // Sorted newest-first.
        assertEquals("@carol:x", grouped["e2"]!![0].userId)
    }

    @Test
    fun `receipt for uncached event falls back to newest message at-or-before ts`() {
        val messages = listOf(msg("e1", 100), msg("e2", 200))
        val receipts = listOf(ChatEvents.ReadReceipt("@bob:x", "e-unknown", 150, null, null))
        val grouped = ChatEvents.receiptsByMessage(receipts, messages)
        assertEquals(setOf("e1"), grouped.keys)
    }

    @Test
    fun `receipt older than every cached message is dropped`() {
        val messages = listOf(msg("e1", 100))
        val receipts = listOf(ChatEvents.ReadReceipt("@bob:x", "e-old", 50, null, null))
        assertTrue(ChatEvents.receiptsByMessage(receipts, messages).isEmpty())
    }

    @Test
    fun `no receipts field parses to empty`() {
        assertTrue(ChatEvents.parseReadReceipts("""{"name":"R"}""").isEmpty())
        assertTrue(ChatEvents.parseReadReceipts(null).isEmpty())
        assertTrue(ChatEvents.parseReadReceipts("not json").isEmpty())
    }

    // ------------------------------------------------------------------ //
    // Unread divider

    @Test
    fun `divider lands on first message after lastReadTs`() {
        val messages = listOf(msg("e1", 100), msg("e2", 200), msg("e3", 300))
        assertEquals("e2", ChatEvents.unreadDividerMessageId(messages, 150))
    }

    @Test
    fun `divider skips my own messages`() {
        val messages = listOf(
            msg("e1", 100),
            msg("mine", 200, sender = "@me:x"),
            msg("e3", 300),
        )
        assertEquals("e3", ChatEvents.unreadDividerMessageId(messages, 150, myUserId = "@me:x"))
    }

    @Test
    fun `divider skips local echoes`() {
        val messages = listOf(msg("e1", 100), msg("~echo", 200, sender = "me", echo = true))
        assertNull(ChatEvents.unreadDividerMessageId(messages, 150))
    }

    @Test
    fun `no divider when everything read or no lastReadTs`() {
        val messages = listOf(msg("e1", 100))
        assertNull(ChatEvents.unreadDividerMessageId(messages, 100))
        assertNull(ChatEvents.unreadDividerMessageId(messages, null))
    }

    // ------------------------------------------------------------------ //
    // Mentions

    @Test
    fun `at start of input arms the picker`() {
        val q = Mentions.activeQuery("@al")
        assertEquals("al", q!!.query)
        assertEquals(0, q.startIdx)
    }

    @Test
    fun `at after whitespace arms the picker`() {
        val q = Mentions.activeQuery("hey @bo")
        assertEquals("bo", q!!.query)
        assertEquals(4, q.startIdx)
    }

    @Test
    fun `email address does not arm the picker`() {
        assertNull(Mentions.activeQuery("mail alice@example.com"))
    }

    @Test
    fun `insert replaces query with display name and trailing space`() {
        val text = "hey @bo"
        val q = Mentions.activeQuery(text)!!
        assertEquals("hey @Bob Smith ", Mentions.insert(text, q, "Bob Smith"))
    }

    @Test
    fun `filter prefers prefix matches and caps results`() {
        val members = listOf(
            ChatRepository.RoomMember("@1:x", "Alice"),
            ChatRepository.RoomMember("@2:x", "Malice"),
            ChatRepository.RoomMember("@3:x", "Bob"),
        )
        val hits = Mentions.filterMembers(members, "al")
        assertEquals(listOf("Alice", "Malice"), hits.map { it.displayName })
    }

    // ------------------------------------------------------------------ //
    // Snooze times

    private fun at(hour: Int, dayOfWeek: Int? = null): Long =
        Calendar.getInstance().apply {
            if (dayOfWeek != null) set(Calendar.DAY_OF_WEEK, dayOfWeek)
            set(Calendar.HOUR_OF_DAY, hour); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis

    @Test
    fun `later today is 6pm when morning, now+3h when evening`() {
        val morning = at(9)
        assertEquals(at(18), SnoozeTimes.laterToday(morning))
        val evening = at(20)
        assertEquals(evening + 3 * 3600_000L, SnoozeTimes.laterToday(evening))
    }

    @Test
    fun `tomorrow morning is 8am next day`() {
        val now = at(14)
        val t = Calendar.getInstance().apply { timeInMillis = SnoozeTimes.tomorrowMorning(now) }
        assertEquals(8, t.get(Calendar.HOUR_OF_DAY))
        assertTrue(SnoozeTimes.tomorrowMorning(now) > now)
    }

    @Test
    fun `next week is a future Monday 8am`() {
        val now = at(10, Calendar.WEDNESDAY)
        val t = Calendar.getInstance().apply { timeInMillis = SnoozeTimes.nextWeekMonday(now) }
        assertEquals(Calendar.MONDAY, t.get(Calendar.DAY_OF_WEEK))
        assertEquals(8, t.get(Calendar.HOUR_OF_DAY))
        assertTrue(t.timeInMillis > now)
        // On a Monday it jumps a full week, never "today".
        val monday = at(10, Calendar.MONDAY)
        assertTrue(SnoozeTimes.nextWeekMonday(monday) - monday > 6 * 24 * 3600_000L)
    }

    // ------------------------------------------------------------------ //
    // Event parsing additions

    @Test
    fun `audio duration parses from info`() {
        val event = kotlinx.serialization.json.Json.parseToJsonElement(
            """{"event_id":"e","sender":"@a:x","type":"m.room.message","origin_server_ts":1,
                "content":{"msgtype":"m.audio","body":"voice.ogg","url":"mxc://x/a",
                           "info":{"mimetype":"audio/ogg","duration":4200}}}"""
        ).jsonObject
        val msg = ChatEvents.eventToMessage(event, "!r")!!
        assertEquals(4200L, msg.mediaDurationMs)
        assertEquals("m.audio", msg.msgtype)
    }

    @Test
    fun `room state parses lastReadTs`() {
        val state = kotlinx.serialization.json.Json.parseToJsonElement(
            """{"name":"R","lastMessageTime":5,"lastReadTs":42}"""
        ).jsonObject
        assertEquals(42L, ChatEvents.roomFromState("!r", state).lastReadTs)
    }
}
