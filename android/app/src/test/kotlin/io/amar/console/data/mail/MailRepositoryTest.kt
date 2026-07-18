package io.amar.console.data.mail

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.MailThreadRow
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MailRepositoryTest {

    private lateinit var db: ConsoleDb
    private lateinit var repo: MailRepository
    private lateinit var outbox: Outbox

    private fun threadRow(id: String, unread: Boolean = true) = MailThreadRow(
        id = id, subject = "S", fromName = "A", fromEmail = "a@b.c", snippet = "s",
        date = 100, isUnread = unread, isInbox = true, hasAttachments = false,
        messageCount = 1, snoozedUntil = null, account = "me@x.com",
    )

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
        repo = MailRepository(db, HubClient(), syncBus, outbox)
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `archive removes from inbox optimistically and queues`() = runTest {
        db.mailThreads().upsertAll(listOf(threadRow("t1")))
        db.meta().put(io.amar.console.data.db.MetaRow(MailRepository.ACCOUNT_KEY, "me@x.com"))
        repo.archive("t1")
        assertFalse(db.mailThreads().byId("t1")!!.isInbox)
        val q = db.outbox().pending()
        assertEquals(1, q.size)
        assertEquals(MailRepository.TYPE_ARCHIVE, q[0].type)
    }

    @Test
    fun `undoArchive restores and cancels the queued action`() = runTest {
        db.mailThreads().upsertAll(listOf(threadRow("t1")))
        repo.archive("t1")
        repo.undoArchive("t1")
        assertTrue(db.mailThreads().byId("t1")!!.isInbox)
        assertEquals(0, db.outbox().pending().size)
    }

    @Test
    fun `snooze archives locally and remembers the timer`() = runTest {
        db.mailThreads().upsertAll(listOf(threadRow("t1")))
        val until = System.currentTimeMillis() + 60_000
        repo.snooze("t1", until)
        val row = db.mailThreads().byId("t1")!!
        assertFalse(row.isInbox)
        assertEquals(until, row.snoozedUntil)
    }

    @Test
    fun `expired snooze re-inboxes on checkSnoozes`() = runTest {
        db.mailThreads().upsertAll(listOf(threadRow("t1").copy(isInbox = false, snoozedUntil = 1L)))
        repo.checkSnoozes()
        val row = db.mailThreads().byId("t1")!!
        assertTrue(row.isInbox)
        assertEquals(null, row.snoozedUntil)
        // Unarchive queued for Gmail
        assertEquals(MailRepository.TYPE_UNARCHIVE, db.outbox().pending().first().type)
    }

    @Test
    fun `reply queues with baseMessageCount for conflict detection and auto-archives`() = runTest {
        db.mailThreads().upsertAll(listOf(threadRow("t1").copy(messageCount = 3)))
        repo.reply("t1", "sounds good")
        val q = db.outbox().pending()
        assertEquals(2, q.size) // reply + archive
        val reply = q.first { it.type == MailRepository.TYPE_REPLY }
        assertTrue(reply.payloadJson.contains("\"baseMessageCount\":3"))
        assertNotNull(reply.dedupeToken) // clientToken rides the dedupe token
        assertFalse(db.mailThreads().byId("t1")!!.isInbox)
    }

    @Test
    fun `markRead and markUnread flip flags optimistically`() = runTest {
        db.mailThreads().upsertAll(listOf(threadRow("t1", unread = true)))
        repo.markRead("t1")
        assertFalse(db.mailThreads().byId("t1")!!.isUnread)
        repo.markUnread("t1")
        assertTrue(db.mailThreads().byId("t1")!!.isUnread)
    }

    @Test
    fun `inbox flow filters snoozed threads`() = runTest {
        db.mailThreads().upsertAll(
            listOf(
                threadRow("visible"),
                threadRow("snoozed").copy(snoozedUntil = System.currentTimeMillis() + 100_000),
            )
        )
        val rows = db.mailThreads().observeInbox(System.currentTimeMillis()).first()
        assertEquals(listOf("visible"), rows.map { it.id })
    }

    @Test
    fun `body eviction keeps newest N`() = runTest {
        val threads = (1..5).map { threadRow("t$it").copy(date = it.toLong()) }
        db.mailThreads().upsertAll(threads)
        db.mailMessages().upsertAll((1..5).map {
            io.amar.console.data.db.MailMessageRow(
                id = "m$it", threadId = "t$it", date = it.toLong(), fromHeader = "a@b.c",
                toHeader = "", ccHeader = null, subject = "s", bodyHtml = "<p>$it</p>",
                bodyText = "t", isUnread = false, attachmentsJson = null,
            )
        })
        db.mailMessages().evictBodiesOutsideNewest(2)
        // newest two (t5, t4) keep bodies
        assertNotNull(db.mailMessages().forThread("t5").first().bodyHtml)
        assertNotNull(db.mailMessages().forThread("t4").first().bodyHtml)
        assertEquals(null, db.mailMessages().forThread("t1").first().bodyHtml)
        // text fallback survives eviction
        assertEquals("t", db.mailMessages().forThread("t1").first().bodyText)
    }
}
