package io.amar.console.data.chat

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ChatRepositoryTest {

    private lateinit var db: ConsoleDb
    private lateinit var repo: ChatRepository
    private lateinit var outbox: Outbox

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(), ConsoleDb::class.java
        ).allowMainThreadQueries().build()
        val scope = TestScope()
        val syncBus = SyncBusClient(scope)
        outbox = Outbox(
            ApplicationProvider.getApplicationContext(), scope, db,
            HubClient(), syncBus, durableScheduler = {},
        )
        repo = ChatRepository(db, HubClient(), syncBus, outbox)
    }

    @After
    fun tearDown() = db.close()

    private fun env(json: String) = Json.parseToJsonElement(json).jsonObject

    // ------------------------------------------------------------------ //
    // Rooms delta application

    @Test
    fun `full snapshot upserts and prunes stale rooms`() = runTest {
        // Seed a room the hub no longer has.
        repo.applyRoomsDelta(env("""{"seq":1,"data":{"!old:x":{"name":"Old","lastMessageTime":1}}}"""), isSnapshot = true)
        // Fresh snapshot without it.
        repo.applyRoomsDelta(env("""{"seq":5,"data":{"!new:x":{"name":"New","lastMessageTime":2}}}"""), isSnapshot = true)
        assertEquals(listOf("!new:x"), db.chatRooms().allIds())
    }

    @Test
    fun `patch applies changed and removed keys`() = runTest {
        repo.applyRoomsDelta(env("""{"seq":1,"data":{"!a:x":{"name":"A","lastMessageTime":1},"!b:x":{"name":"B","lastMessageTime":1}}}"""), isSnapshot = true)
        repo.applyRoomsDelta(env("""{"seq":2,"partial":true,"changed":{"!a:x":{"name":"A2","lastMessageTime":9}},"removed":["!b:x"]}"""))
        assertEquals(listOf("!a:x"), db.chatRooms().allIds())
        assertEquals("A2", db.chatRooms().byId("!a:x")?.name)
    }

    @Test
    fun `stale seq is ignored`() = runTest {
        repo.applyRoomsDelta(env("""{"seq":5,"data":{"!a:x":{"name":"v5","lastMessageTime":1}}}"""), isSnapshot = true)
        repo.applyRoomsDelta(env("""{"seq":3,"partial":true,"changed":{"!a:x":{"name":"v3","lastMessageTime":1}},"removed":[]}"""))
        assertEquals("v5", db.chatRooms().byId("!a:x")?.name)
    }

    @Test
    fun `live patch with a seq gap is not applied (missed broadcast)`() = runTest {
        repo.applyRoomsDelta(env("""{"seq":1,"data":{"!a:x":{"name":"v1","lastMessageTime":1}}}"""), isSnapshot = true)
        // seq jumps 1 → 4: a live delta gap means missed broadcasts.
        repo.applyRoomsDelta(env("""{"seq":4,"partial":true,"changed":{"!a:x":{"name":"v4","lastMessageTime":1}},"removed":[]}"""))
        assertEquals("v1", db.chatRooms().byId("!a:x")?.name)
    }

    @Test
    fun `snapshot patch with a gap IS applied (server coalesced it)`() = runTest {
        repo.applyRoomsDelta(env("""{"seq":1,"data":{"!a:x":{"name":"v1","lastMessageTime":1}}}"""), isSnapshot = true)
        // snapshotSince returns one coalesced patch covering seq 2..4.
        repo.applyRoomsDelta(env("""{"seq":4,"partial":true,"changed":{"!a:x":{"name":"v4","lastMessageTime":1}},"removed":[]}"""), isSnapshot = true)
        assertEquals("v4", db.chatRooms().byId("!a:x")?.name)
    }

    // ------------------------------------------------------------------ //
    // Matrix delta ingestion

    @Test
    fun `timeline events land in the message table and cursor advances`() = runTest {
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s2","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}e1","sender":"@a:x","type":"m.room.message",
                  "origin_server_ts":1000,"content":{"msgtype":"m.text","body":"hi"}}
               ]}}}}"""
        ))
        assertEquals(1, db.chatMessages().countForRoom("!r:x"))
        assertEquals("s2", db.meta().get(ChatRepository.CURSOR_KEY))
    }

    @Test
    fun `re-ingesting the same delta is idempotent`() = runTest {
        val delta = env(
            """{"nextBatch":"s2","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}e1","sender":"@a:x","type":"m.room.message",
                  "origin_server_ts":1000,"content":{"msgtype":"m.text","body":"hi"}}
               ]}}}}"""
        )
        repo.ingestMatrixDelta(delta)
        repo.ingestMatrixDelta(delta)
        assertEquals(1, db.chatMessages().countForRoom("!r:x"))
    }

    @Test
    fun `redaction flips isDeleted on the original`() = runTest {
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s1","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}e1","sender":"@a:x","type":"m.room.message",
                  "origin_server_ts":1,"content":{"msgtype":"m.text","body":"oops"}}]}}}}"""
        ))
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s2","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}e2","sender":"@a:x","type":"m.room.redaction",
                  "origin_server_ts":2,"content":{},"redacts":"${'$'}e1"}]}}}}"""
        ))
        val row = db.chatMessages().byId("\$e1")
        assertTrue(row!!.isDeleted)
        assertEquals("oops", row.body) // soft delete: original text preserved
    }

    @Test
    fun `own echo is swapped when the real event arrives with our txnId`() = runTest {
        repo.sendText("!r:x", "hello world")
        val echo = db.chatMessages().recent("!r:x", 10).first()
        assertTrue(echo.localEcho)
        val txn = echo.txnId!!

        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s2","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}real","sender":"@me:x","type":"m.room.message",
                  "origin_server_ts":5,"content":{"msgtype":"m.text","body":"hello world"},
                  "unsigned":{"transaction_id":"$txn"}}]}}}}"""
        ))
        assertNull(db.chatMessages().byId(echo.id))
        assertNotNull(db.chatMessages().byId("\$real"))
        assertEquals(1, db.chatMessages().countForRoom("!r:x"))
    }

    // ------------------------------------------------------------------ //
    // Optimistic mutations + outbox rows

    @Test
    fun `sendText writes local echo and queues with matching txnId`() = runTest {
        repo.sendText("!r:x", "queued offline")
        val echo = db.chatMessages().recent("!r:x", 10).first()
        assertTrue(echo.localEcho)
        val queued = db.outbox().pending()
        assertEquals(1, queued.size)
        assertEquals(ChatRepository.TYPE_SEND, queued[0].type)
        assertEquals(echo.txnId, queued[0].dedupeToken)
    }

    @Test
    fun `markRead flips the room optimistically and queues the receipt`() = runTest {
        repo.applyRoomsDelta(env("""{"seq":1,"data":{"!r:x":{"name":"R","isUnread":true,"unreadCount":2,"lastMessageTime":1,"lastReadEventId":"${'$'}prev"}}}"""), isSnapshot = true)
        repo.markRead("!r:x")
        val room = db.chatRooms().byId("!r:x")!!
        assertEquals(false, room.isUnread)
        assertEquals(0, room.unreadCount)
        assertEquals(1, db.outbox().pending().size)
    }

    @Test
    fun `send failure badge is retryable with the same token`() = runTest {
        repo.sendText("!r:x", "will fail")
        val echo = db.chatMessages().recent("!r:x", 10).first()
        db.chatMessages().setSendFailed(echo.id, true)
        db.outbox().delete(db.outbox().pending().first().id) // simulate terminal fail cleanup

        repo.retryFailed(echo.id)
        val again = db.outbox().pending()
        assertEquals(1, again.size)
        assertEquals(echo.txnId, again[0].dedupeToken) // SAME token → idempotent
        assertEquals(false, db.chatMessages().byId(echo.id)!!.sendFailed)
    }

    // ------------------------------------------------------------------ //
    // Batch 2: reactions, edit-in-place, reply enrichment

    @Test
    fun `edit updates the original row in place — no duplicate`() = runTest {
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s1","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}orig","sender":"@a:x","type":"m.room.message",
                  "origin_server_ts":1,"content":{"msgtype":"m.text","body":"typo"}}]}}}}"""
        ))
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s2","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}edit","sender":"@a:x","type":"m.room.message","origin_server_ts":2,
                  "content":{"msgtype":"m.text","body":"* fixed",
                             "m.new_content":{"msgtype":"m.text","body":"fixed"},
                             "m.relates_to":{"rel_type":"m.replace","event_id":"${'$'}orig"}}}]}}}}"""
        ))
        assertEquals(1, db.chatMessages().countForRoom("!r:x"))
        val row = db.chatMessages().byId("\$orig")!!
        assertEquals("fixed", row.body)
        assertTrue(row.isEdited)
        assertNull(db.chatMessages().byId("\$edit"))
    }

    @Test
    fun `reactions aggregate emoji to senders on the target row`() = runTest {
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s1","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}m1","sender":"@a:x","type":"m.room.message",
                  "origin_server_ts":1,"content":{"msgtype":"m.text","body":"hi"}}]}}}}"""
        ))
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s2","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}r1","sender":"@b:x","type":"m.reaction","origin_server_ts":2,
                  "content":{"m.relates_to":{"rel_type":"m.annotation","event_id":"${'$'}m1","key":"👍"}}},
                 {"event_id":"${'$'}r2","sender":"@c:x","type":"m.reaction","origin_server_ts":3,
                  "content":{"m.relates_to":{"rel_type":"m.annotation","event_id":"${'$'}m1","key":"👍"}}}]}}}}"""
        ))
        val reactions = repo.parseReactions(db.chatMessages().byId("\$m1")!!.reactionsJson)
        assertEquals(listOf("@b:x", "@c:x"), reactions["👍"])
        assertEquals(1, db.chatMessages().countForRoom("!r:x")) // reactions aren't rows
    }

    @Test
    fun `reply gets enriched with quoted sender and body from cache`() = runTest {
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s1","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}q","sender":"@a:x","type":"m.room.message",
                  "origin_server_ts":1,"content":{"msgtype":"m.text","body":"original question"}}]}}}}"""
        ))
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s2","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}a","sender":"@b:x","type":"m.room.message","origin_server_ts":2,
                  "content":{"msgtype":"m.text","body":"the answer",
                             "m.relates_to":{"m.in_reply_to":{"event_id":"${'$'}q"}}}}]}}}}"""
        ))
        val reply = db.chatMessages().byId("\$a")!!
        assertTrue(reply.replyToJson!!.contains("original question"))
        assertTrue(reply.replyToJson!!.contains("@a:x") || reply.replyToJson!!.contains("\"a\""))
    }

    @Test
    fun `sendText with replyTo carries the relation into the queue payload`() = runTest {
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s1","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}t","sender":"@a:x","type":"m.room.message",
                  "origin_server_ts":1,"content":{"msgtype":"m.text","body":"target"}}]}}}}"""
        ))
        repo.sendText("!r:x", "my reply", replyToEventId = "\$t")
        val q = db.outbox().pending().first { it.type == ChatRepository.TYPE_SEND }
        assertTrue(q.payloadJson.contains("\"replyTo\":\"\$t\""))
        val echo = db.chatMessages().recent("!r:x", 5).first { it.localEcho }
        assertTrue(echo.replyToJson!!.contains("target"))
    }

    // ------------------------------------------------------------------ //
    // Batch 3: soft-delete attribution, edit diff, decryption-regression,
    // send-status, low-priority, edit send.

    @Test
    fun `redaction records deletedBy and preserves body`() = runTest {
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s1","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}m","sender":"@a:x","type":"m.room.message",
                  "origin_server_ts":1,"content":{"msgtype":"m.text","body":"secret"}}]}}}}"""
        ))
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s2","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}red","sender":"@mod:x","type":"m.room.redaction",
                  "origin_server_ts":2,"content":{},"redacts":"${'$'}m"}]}}}}"""
        ))
        val row = db.chatMessages().byId("\$m")!!
        assertTrue(row.isDeleted)
        assertEquals("@mod:x", row.deletedBy)
        assertEquals("secret", row.body)
    }

    @Test
    fun `edit preserves originalBody for the diff view`() = runTest {
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s1","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}o","sender":"@a:x","type":"m.room.message",
                  "origin_server_ts":1,"content":{"msgtype":"m.text","body":"teh cat"}}]}}}}"""
        ))
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s2","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}e","sender":"@a:x","type":"m.room.message","origin_server_ts":2,
                  "content":{"msgtype":"m.text","body":"* the cat",
                             "m.new_content":{"msgtype":"m.text","body":"the cat"},
                             "m.relates_to":{"rel_type":"m.replace","event_id":"${'$'}o"}}}]}}}}"""
        ))
        val row = db.chatMessages().byId("\$o")!!
        assertEquals("the cat", row.body)
        assertEquals("teh cat", row.originalBody)
        assertTrue(row.isEdited)
    }

    @Test
    fun `re-delivered encrypted placeholder does not overwrite a decrypted row`() = runTest {
        // Decrypted message lands first.
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s1","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}m","sender":"@a:x","type":"m.room.message",
                  "origin_server_ts":1,"content":{"msgtype":"m.text","body":"decrypted body"}}]}}}}"""
        ))
        // Cold resume replays the SAME event as an undecryptable placeholder.
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s2","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}m","sender":"@a:x","type":"m.room.encrypted","origin_server_ts":1,
                  "content":{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"opaque"}}]}}}}"""
        ))
        assertEquals("decrypted body", db.chatMessages().byId("\$m")!!.body)
    }

    @Test
    fun `bridge send-status flips and clears sendFailed on the echo`() = runTest {
        // Seed a delivered message row (stand-in for the acked echo).
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s1","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}sent","sender":"@me:x","type":"m.room.message",
                  "origin_server_ts":1,"content":{"msgtype":"m.text","body":"hi"}}]}}}}"""
        ))
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s2","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}st","sender":"@bot:x","type":"com.beeper.message_send_status",
                  "origin_server_ts":2,"content":{"status":"FAIL_PERMANENT","reason":"nope",
                     "m.relates_to":{"event_id":"${'$'}sent"}}}]}}}}"""
        ))
        assertTrue(db.chatMessages().byId("\$sent")!!.sendFailed)
        assertTrue(db.chatMessages().byId("\$sent")!!.sendFailedReason!!.contains("FAIL_PERMANENT"))
        // SUCCESS clears the marker.
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s3","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}st2","sender":"@bot:x","type":"com.beeper.message_send_status",
                  "origin_server_ts":3,"content":{"status":"SUCCESS",
                     "m.relates_to":{"event_id":"${'$'}sent"}}}]}}}}"""
        ))
        assertEquals(false, db.chatMessages().byId("\$sent")!!.sendFailed)
    }

    @Test
    fun `setLowPriority flips optimistically and queues`() = runTest {
        repo.applyRoomsDelta(env("""{"seq":1,"data":{"!r:x":{"name":"R","lastMessageTime":1}}}"""), isSnapshot = true)
        repo.setLowPriority("!r:x", true)
        assertTrue(db.chatRooms().byId("!r:x")!!.isLowPriority)
        assertEquals(ChatRepository.TYPE_LOWPRIO, db.outbox().pending().first().type)
    }

    @Test
    fun `editMessage is a no-op on unchanged text`() = runTest {
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s1","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}o","sender":"@me:x","type":"m.room.message",
                  "origin_server_ts":1,"content":{"msgtype":"m.text","body":"same"}}]}}}}"""
        ))
        repo.editMessage("!r:x", "\$o", "same")
        assertTrue(db.outbox().pending().none { it.type == ChatRepository.TYPE_EDIT })
        assertEquals(false, db.chatMessages().byId("\$o")!!.isEdited)
    }

    @Test
    fun `editMessage flips body optimistically and queues the m_replace`() = runTest {
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s1","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}o","sender":"@me:x","type":"m.room.message",
                  "origin_server_ts":1,"content":{"msgtype":"m.text","body":"old"}}]}}}}"""
        ))
        repo.editMessage("!r:x", "\$o", "new body")
        val row = db.chatMessages().byId("\$o")!!
        assertEquals("new body", row.body)
        assertEquals("old", row.originalBody)
        assertTrue(row.isEdited)
        assertEquals(ChatRepository.TYPE_EDIT, db.outbox().pending().first { it.type == ChatRepository.TYPE_EDIT }.type)
    }

    @Test
    fun `sendText carries formattedBody and mention userIds into the payload`() = runTest {
        repo.sendText("!r:x", "hi @Bob", formattedBody = "hi <a>@Bob</a>", mentionUserIds = listOf("@bob:x"))
        val q = db.outbox().pending().first { it.type == ChatRepository.TYPE_SEND }
        assertTrue(q.payloadJson.contains("formattedBody"))
        assertTrue(q.payloadJson.contains("@bob:x"))
        val echo = db.chatMessages().recent("!r:x", 5).first { it.localEcho }
        assertEquals("hi <a>@Bob</a>", echo.formattedBody)
    }

    @Test
    fun `undoMarkRead restores the prior unread snapshot`() = runTest {
        repo.applyRoomsDelta(env("""{"seq":1,"data":{"!r:x":{"name":"R","isUnread":true,"unreadCount":3,"lastMessageTime":1}}}"""), isSnapshot = true)
        val before = db.chatRooms().byId("!r:x")!!
        repo.markRead("!r:x")
        assertEquals(false, db.chatRooms().byId("!r:x")!!.isUnread)
        repo.undoMarkRead(before)
        val after = db.chatRooms().byId("!r:x")!!
        assertTrue(after.isUnread)
        assertEquals(3, after.unreadCount)
    }

    @Test
    fun `sendReaction is optimistic and queues chatReact`() = runTest {
        repo.ingestMatrixDelta(env(
            """{"nextBatch":"s1","rooms":{"!r:x":{"timeline":{"events":[
                 {"event_id":"${'$'}m","sender":"@a:x","type":"m.room.message",
                  "origin_server_ts":1,"content":{"msgtype":"m.text","body":"react to me"}}]}}}}"""
        ))
        repo.sendReaction("!r:x", "\$m", "❤️")
        val reactions = repo.parseReactions(db.chatMessages().byId("\$m")!!.reactionsJson)
        assertEquals(listOf("me"), reactions["❤️"])
        assertEquals(ChatRepository.TYPE_REACT, db.outbox().pending().first().type)
    }
}
