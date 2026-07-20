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
import org.junit.Assert.assertNull
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
    fun `delete removes from inbox and queues trash; undo restores and cancels`() = runTest {
        db.mailThreads().upsertAll(listOf(threadRow("t1")))
        db.meta().put(io.amar.console.data.db.MetaRow(MailRepository.ACCOUNT_KEY, "me@x.com"))
        repo.deleteThread("t1")
        assertFalse(db.mailThreads().byId("t1")!!.isInbox)
        assertEquals(MailRepository.TYPE_TRASH, db.outbox().pending().single().type)
        repo.undoDelete("t1")
        assertTrue(db.mailThreads().byId("t1")!!.isInbox)
        assertEquals(0, db.outbox().pending().size)
    }

    @Test
    fun `sendCompose queues a send with html cc from and attachments`() = runTest {
        db.meta().put(io.amar.console.data.db.MetaRow(MailRepository.ACCOUNT_KEY, "me@x.com"))
        repo.sendCompose(
            to = "a@b.c", cc = "c@d.e", subject = "Hi", html = "<p>x</p>", from = "me@x.com",
            attachments = listOf(MailRepository.OutAttachment("f.pdf", "application/pdf", "QUJD")),
        )
        val row = db.outbox().pending().single()
        assertEquals(MailRepository.TYPE_SEND, row.type)
        assertTrue(row.payloadJson.contains("\"html\":true"))
        assertTrue(row.payloadJson.contains("\"cc\":\"c@d.e\""))
        assertTrue(row.payloadJson.contains("\"from\":\"me@x.com\""))
        assertTrue(row.payloadJson.contains("f.pdf"))
    }

    @Test
    fun `sendReply queues reply-send with baseMessageCount and auto-archives`() = runTest {
        db.mailThreads().upsertAll(listOf(threadRow("t1").copy(messageCount = 2)))
        db.meta().put(io.amar.console.data.db.MetaRow(MailRepository.ACCOUNT_KEY, "me@x.com"))
        repo.sendReply(
            threadId = "t1", to = "a@b.c", cc = null, subject = "Re: S", html = "<p>ok</p>",
            from = "me@x.com", attachments = emptyList(), autoArchive = true,
        )
        val q = db.outbox().pending()
        assertEquals(2, q.size) // reply-send + archive
        val reply = q.first { it.type == MailRepository.TYPE_REPLY_SEND }
        assertTrue(reply.payloadJson.contains("\"baseMessageCount\":2"))
        assertEquals("t1", reply.entityId)
        assertFalse(db.mailThreads().byId("t1")!!.isInbox)
    }

    @Test
    fun `sendReply without autoArchive keeps thread in inbox`() = runTest {
        db.mailThreads().upsertAll(listOf(threadRow("t1")))
        db.meta().put(io.amar.console.data.db.MetaRow(MailRepository.ACCOUNT_KEY, "me@x.com"))
        repo.sendReply("t1", "a@b.c", null, "Fwd: S", "<p>fwd</p>", "me@x.com", emptyList(), autoArchive = false)
        assertTrue(db.mailThreads().byId("t1")!!.isInbox)
        assertEquals(1, db.outbox().pending().size)
    }

    @Test
    fun `aliases labelMap and calendar invite round-trip through meta`() = runTest {
        db.meta().put(io.amar.console.data.db.MetaRow(
            MailRepository.ALIASES_KEY,
            """[{"email":"me@x.com","name":"Me","isDefault":true},{"email":"work@y.com","name":"Work"}]""",
        ))
        val aliases = repo.aliases()
        assertEquals(2, aliases.size)
        assertEquals("me@x.com", aliases[0].email)
        assertTrue(aliases[0].isDefault)

        db.meta().put(io.amar.console.data.db.MetaRow(
            MailRepository.LABEL_MAP_KEY, """{"Label_1":"Receipts","Label_2":"Travel"}""",
        ))
        assertEquals("Receipts", repo.labelMap()["Label_1"])

        val invite = CalendarInvite(summary = "Sync", start = 1000, end = 2000, status = "CONFIRMED")
        db.meta().put(io.amar.console.data.db.MetaRow(
            "${MailRepository.CAL_PREFIX}m1",
            kotlinx.serialization.json.Json.encodeToString(CalendarInvite.serializer(), invite),
        ))
        assertEquals("Sync", repo.calendarInvite("m1")?.summary)
        assertNull(repo.calendarInvite("missing"))
    }

    @Test
    fun `threadLabels reads stored user-label ids`() = runTest {
        db.meta().put(io.amar.console.data.db.MetaRow(
            "${MailRepository.LABELS_PREFIX}t1", """["Label_1","Label_2"]""",
        ))
        assertEquals(listOf("Label_1", "Label_2"), repo.threadLabels("t1"))
        assertEquals(emptyList<String>(), repo.threadLabels("none"))
    }

    @Test
    fun `localContacts scans cached messages recency-sorted`() = runTest {
        db.mailThreads().upsertAll(listOf(threadRow("t1")))
        db.mailMessages().upsertAll(listOf(
            io.amar.console.data.db.MailMessageRow(
                id = "m1", threadId = "t1", date = 100, fromHeader = "Alice <alice@x.com>",
                toHeader = "Bob <bob@y.com>, me@x.com", ccHeader = "Carol <carol@z.com>",
                subject = "s", bodyHtml = null, bodyText = "t", isUnread = false, attachmentsJson = null,
            ),
            io.amar.console.data.db.MailMessageRow(
                id = "m2", threadId = "t1", date = 200, fromHeader = "Dave <dave@w.com>",
                toHeader = "alice@x.com", ccHeader = null,
                subject = "s", bodyHtml = null, bodyText = "t", isUnread = false, attachmentsJson = null,
            ),
        ))
        val contacts = repo.localContacts()
        val emails = contacts.map { it.email.lowercase() }
        assertTrue(emails.contains("alice@x.com"))
        assertTrue(emails.contains("bob@y.com"))
        assertTrue(emails.contains("dave@w.com"))
        // Dave (date 200) should outrank Bob (date 100).
        assertTrue(emails.indexOf("dave@w.com") < emails.indexOf("bob@y.com"))
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
