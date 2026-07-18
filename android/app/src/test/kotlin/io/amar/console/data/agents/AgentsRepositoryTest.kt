package io.amar.console.data.agents

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.AgentMessageRow
import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AgentsRepositoryTest {

    private lateinit var db: ConsoleDb
    private lateinit var repo: AgentsRepository
    private lateinit var outbox: Outbox
    private lateinit var scope: TestScope

    private fun session(id: String, unread: Boolean = false) = AgentSessionRow(
        id = id, name = "S$id", status = "idle", hasUnread = unread, needsAttention = false,
        attentionSnippet = null, agentKey = null, modelLabel = null, hibernated = false,
        cwd = null, lastCachedIndex = -1, messageLogLength = 0,
    )

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(), ConsoleDb::class.java
        ).allowMainThreadQueries().build()
        scope = TestScope()
        outbox = Outbox(
            ApplicationProvider.getApplicationContext(), scope, db,
            HubClient(), SyncBusClient(scope), durableScheduler = {},
        )
        repo = AgentsRepository(scope, db, HubClient(), outbox)
        repo.registerOutboxHandlers()
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `sendPrompt writes optimistic user_prompt row and queues with dedupeKey`() = runTest {
        db.agents().upsertSessions(listOf(session("s1")))
        repo.sendPrompt("s1", "do the thing")
        val messages = db.agents().observeRecent("s1", 10).first()
        assertEquals(1, messages.size)
        assertEquals("user_prompt", messages[0].kind)
        val q = db.outbox().pending()
        assertEquals(1, q.size)
        assertTrue(q[0].dedupeToken.startsWith("apk-"))
    }

    @Test
    fun `queued send retries while agents ws is down`() = runTest {
        db.agents().upsertSessions(listOf(session("s1")))
        repo.sendPrompt("s1", "offline prompt")
        // WS never started — handler must Retry, keeping the row pending.
        assertFalse(outbox.drain())
        assertEquals(1, db.outbox().pending().size)
        assertEquals(1, db.outbox().pending()[0].retryCount)
    }

    @Test
    fun `messages get consecutive absolute indices (unique per session)`() = runTest {
        db.agents().upsertSessions(listOf(session("s1")))
        repo.sendPrompt("s1", "one")
        repo.sendPrompt("s1", "two")
        val messages = db.agents().observeRecent("s1", 10).first()
        assertEquals(listOf(1L, 0L), messages.map { it.absIndex })
    }

    @Test
    fun `insert is idempotent on (session, absIndex) — catch-up overlap safe`() = runTest {
        db.agents().insertMessages(
            listOf(
                AgentMessageRow(sessionId = "s1", absIndex = 5, kind = "text", payloadJson = "{}"),
                AgentMessageRow(sessionId = "s1", absIndex = 5, kind = "text", payloadJson = "{\"dup\":1}"),
            )
        )
        val messages = db.agents().observeRecent("s1", 10).first()
        assertEquals(1, messages.size)
        assertEquals("{}", messages[0].payloadJson) // first insert wins (IGNORE)
    }

    @Test
    fun `session list replace drops absent sessions`() = runTest {
        db.agents().upsertSessions(listOf(session("a"), session("b")))
        db.agents().deleteAbsent(listOf("a"))
        val remaining = db.agents().observeSessions().first()
        assertEquals(listOf("a"), remaining.map { it.id })
    }

    @Test
    fun `prune bounds a session transcript`() = runTest {
        db.agents().insertMessages((0L until 300L).map {
            AgentMessageRow(sessionId = "s1", absIndex = it, kind = "text", payloadJson = "{}")
        })
        db.agents().pruneSession("s1", 200)
        val kept = db.agents().observeRecent("s1", 500).first()
        assertEquals(200, kept.size)
        assertEquals(299L, kept.first().absIndex) // newest survives
    }
}
