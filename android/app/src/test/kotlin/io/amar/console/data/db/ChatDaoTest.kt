package io.amar.console.data.db

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ChatDaoTest {

    private lateinit var db: ConsoleDb

    private fun msg(id: String, roomId: String = "!r", ts: Long) = ChatMessageRow(
        id = id, roomId = roomId, timestamp = ts, senderId = "@u:x", senderName = "U",
        body = "m$id", msgtype = "m.text", mediaMxc = null, mediaMime = null,
        encryptedFileJson = null, replyToJson = null,
    )

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(), ConsoleDb::class.java
        ).allowMainThreadQueries().build()
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `upsert is idempotent on event id (bulkPut semantics)`() = runTest {
        db.chatMessages().upsertAll(listOf(msg("e1", ts = 1)))
        db.chatMessages().upsertAll(listOf(msg("e1", ts = 1).copy(body = "edited")))
        val rows = db.chatMessages().recent("!r", 10)
        assertEquals(1, rows.size)
        assertEquals("edited", rows[0].body)
    }

    @Test
    fun `replaceEcho swaps local echo for real event atomically`() = runTest {
        val echo = msg("~123.abc", ts = 5).copy(localEcho = true, txnId = "apk-t1")
        db.chatMessages().upsertAll(listOf(echo))
        db.chatMessages().replaceEcho("~123.abc", msg("\$real", ts = 5))
        assertNull(db.chatMessages().byId("~123.abc"))
        assertEquals("m\$real", db.chatMessages().byId("\$real")?.body)
    }

    @Test
    fun `pruneRoom keeps the newest N`() = runTest {
        db.chatMessages().upsertAll((1..10).map { msg("e$it", ts = it.toLong()) })
        db.chatMessages().pruneRoom("!r", keep = 3)
        val rows = db.chatMessages().recent("!r", 100)
        assertEquals(3, rows.size)
        assertEquals(listOf("e10", "e9", "e8"), rows.map { it.id })
    }

    @Test
    fun `prune does not touch other rooms`() = runTest {
        db.chatMessages().upsertAll((1..5).map { msg("a$it", roomId = "!a", ts = it.toLong()) })
        db.chatMessages().upsertAll((1..5).map { msg("b$it", roomId = "!b", ts = it.toLong()) })
        db.chatMessages().pruneRoom("!a", keep = 2)
        assertEquals(2, db.chatMessages().countForRoom("!a"))
        assertEquals(5, db.chatMessages().countForRoom("!b"))
    }

    @Test
    fun `room upsert and prune by snapshot ids`() = runTest {
        val room = ChatRoomRow(
            id = "!r1", name = "Room", avatarMxc = null, isDirect = false, isUnread = true,
            unreadCount = 2, manualUnread = false, lastMessageBody = "hi", lastMessageSender = "U",
            lastMessageTime = 100, lastReadEventId = null, isMuted = false, isLowPriority = false,
            isEncrypted = true, memberCount = 3, networkIcon = null, snoozedUntil = null,
            prevBatch = null, rawJson = "{}",
        )
        db.chatRooms().upsertAll(listOf(room, room.copy(id = "!r2")))
        db.chatRooms().deleteByIds(listOf("!r2"))
        assertEquals(listOf("!r1"), db.chatRooms().allIds())
    }
}
