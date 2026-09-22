package io.amar.console.data.agents

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.core.HubConfig
import io.amar.console.data.db.AgentMessageRow
import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
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
    private lateinit var server: MockWebServer

    /** A hub session log as `GET /agents/sessions/:id/messages` sees it: rows
     *  `[offset, total)` are in memory, everything before rolled off. Mirrors
     *  server/src/index.ts (from = max(since, offset); truncated = since < offset). */
    private class FakeLog(var total: Long, var offset: Long = 0) {
        val requests = java.util.concurrent.CopyOnWriteArrayList<Long>()
        fun respond(since: Long, limit: Long): String {
            requests.add(since)
            val from = maxOf(since, offset)
            val end = minOf(from + limit, total)
            val rows = if (from < end) (from until end).map { """{"type":"text","content":"m$it","absIndex":$it}""" } else emptyList()
            return """{"messages":[${rows.joinToString(",")}],"fromIndex":$from,"totalLength":$total,"hasMore":${from + rows.size < total},"truncated":${since < offset}}"""
        }
    }
    private val logs = java.util.concurrent.ConcurrentHashMap<String, FakeLog>()

    private fun session(id: String, unread: Boolean = false, logLen: Long = 0) = AgentSessionRow(
        id = id, name = "S$id", status = "idle", hasUnread = unread, needsAttention = false,
        attentionSnippet = null, agentKey = null, modelLabel = null, hibernated = false,
        cwd = null, lastCachedIndex = -1, messageLogLength = logLen,
    )

    private suspend fun cachedIndices(id: String) = db.agents().observeRecent(id, 10_000).first().map { it.absIndex }.sorted()

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(), ConsoleDb::class.java
        ).allowMainThreadQueries().build()
        scope = TestScope()
        // Serve by PATH: HubConfig is process-wide and the real ConsoleApp's
        // pollers also hit this base (see InboxRulesPersistenceTest).
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val m = Regex("""^/hub/agents/sessions/([^/]+)/messages\?since=(\d+)&limit=(\d+)$""").find(request.path ?: "")
                    ?: return MockResponse().setResponseCode(404)
                val log = logs[m.groupValues[1]] ?: return MockResponse().setResponseCode(404)
                return MockResponse().setHeader("Content-Type", "application/json")
                    .setBody(log.respond(m.groupValues[2].toLong(), m.groupValues[3].toLong()))
            }
        }
        server.start()
        HubConfig.init(ApplicationProvider.getApplicationContext())
        HubConfig.setHubBase(server.url("/hub").toString())
        outbox = Outbox(
            ApplicationProvider.getApplicationContext(), scope, db,
            HubClient(), SyncBusClient(scope), durableScheduler = {},
        )
        repo = AgentsRepository(scope, db, HubClient(), outbox)
        repo.registerOutboxHandlers()
    }

    @After
    fun tearDown() {
        HubConfig.setHubBase("")
        runCatching { server.shutdown() }
        db.close()
    }

    // --- Catch-up (^prim-tern: one 200-row page per sync left the phone stuck
    // behind a chatty fork; now it follows hasMore and tail-jumps a big gap) ---

    @Test
    fun `catch-up follows hasMore until current — three pages for a 450-row gap`() = runTest {
        db.agents().upsertSessions(listOf(session("s1", logLen = 500)))
        db.agents().insertMessages((0L until 50L).map { AgentMessageRow(sessionId = "s1", absIndex = it, kind = "text", payloadJson = "{}") })
        logs["s1"] = FakeLog(total = 500, offset = 0)

        repo.catchUpSession("s1", since = 50)

        assertEquals(listOf(50L, 250L, 450L), logs["s1"]!!.requests)
        assertEquals((0L until 500L).toList(), cachedIndices("s1"))
        assertEquals(499L, db.agents().byId("s1")!!.lastCachedIndex)
    }

    @Test
    fun `catch-up stops after one page when the hub says no more`() = runTest {
        db.agents().upsertSessions(listOf(session("s1", logLen = 120)))
        logs["s1"] = FakeLog(total = 120)

        repo.catchUpSession("s1", since = 0)

        assertEquals(listOf(0L), logs["s1"]!!.requests)
        assertEquals(120, cachedIndices("s1").size)
    }

    @Test
    fun `gap wider than the hub window jumps to the tail and leaves a seam`() = runTest {
        // Phone cached rows 0..199 of a session now 1000 long; the hub holds
        // only [500, 1000). The old code fetched [500, 700) — the next slice
        // of backlog — and never reached the present.
        db.agents().upsertSessions(listOf(session("s1", logLen = 1000)))
        db.agents().insertMessages((0L until 200L).map { AgentMessageRow(sessionId = "s1", absIndex = it, kind = "text", payloadJson = "{}") })
        logs["s1"] = FakeLog(total = 1000, offset = 500)

        repo.catchUpSession("s1", since = 200)

        // First request probes (truncated) → second lands on the tail.
        assertEquals(listOf(200L, 800L), logs["s1"]!!.requests)
        val cached = cachedIndices("s1")
        assertEquals((0L until 200L) + (800L until 1000L), cached)
        assertEquals(999L, db.agents().byId("s1")!!.lastCachedIndex)
        assertTrue(cached.none { it in 200L..799L }) // the seam
    }

    @Test
    fun `truncated but small window is stored as-is (no jump past what exists)`() = runTest {
        // Hub restarted: window is just the 40 rows logged since.
        db.agents().upsertSessions(listOf(session("s1", logLen = 1000)))
        logs["s1"] = FakeLog(total = 1000, offset = 960)

        repo.catchUpSession("s1", since = 300)

        assertEquals(listOf(300L), logs["s1"]!!.requests)
        assertEquals((960L until 1000L).toList(), cachedIndices("s1"))
    }

    @Test
    fun `catch-up is bounded even if the session keeps growing`() = runTest {
        db.agents().upsertSessions(listOf(session("s1", logLen = 400)))
        val log = FakeLog(total = 400)
        logs["s1"] = log
        // Every page adds another 200 rows to the hub — hasMore is never false.
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val m = Regex("""since=(\d+)&limit=(\d+)""").find(request.path ?: "") ?: return MockResponse().setResponseCode(404)
                val body = log.respond(m.groupValues[1].toLong(), m.groupValues[2].toLong())
                log.total += 200
                return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            }
        }

        repo.catchUpSession("s1", since = 0)

        assertEquals(AgentsRepository.MAX_CATCHUP_PAGES, log.requests.size)
    }

    @Test
    fun `sessions_list runs the catch-up for every lagging session`() = runTest {
        db.agents().upsertSessions(listOf(session("s1", logLen = 0)))
        db.agents().insertMessages((0L until 10L).map { AgentMessageRow(sessionId = "s1", absIndex = it, kind = "text", payloadJson = "{}") })
        logs["s1"] = FakeLog(total = 30)
        logs["s2"] = FakeLog(total = 5)

        repo.applySessionsList(listOf(
            sessionInfo("s1", 30), sessionInfo("s2", 5),
        ))

        assertEquals((0L until 30L).toList(), cachedIndices("s1"))
        assertEquals((0L until 5L).toList(), cachedIndices("s2"))
        assertEquals(listOf(10L), logs["s1"]!!.requests)
    }

    @Test
    fun `hub numbering reset (a slash-clear on another client) drops the stale cache and re-catches-up`() = runTest {
        // Console mobile, 2026-09-22: phone held rows 4282..4481 from before a
        // /clear; the hub's counter had restarted and stood at 1289. New rows
        // landed BELOW the stale ones and `len-1 > cached` never fired.
        db.agents().upsertSessions(listOf(session("s1", logLen = 4482)))
        db.agents().insertMessages((4282L until 4482L).map { AgentMessageRow(sessionId = "s1", absIndex = it, kind = "text", payloadJson = "{}") })
        logs["s1"] = FakeLog(total = 1289, offset = 789)

        repo.applySessionsList(listOf(sessionInfo("s1", 1289)))

        assertEquals(listOf(0L, 1089L), logs["s1"]!!.requests) // probe from 0 → tail jump
        assertEquals((1089L until 1289L).toList(), cachedIndices("s1"))
    }

    @Test
    fun `a cache a couple of rows past the hub count is a live echo, not a reset`() = runTest {
        // Optimistic user_prompt echo / streaming text row sit at maxIndex+1.
        db.agents().upsertSessions(listOf(session("s1", logLen = 100)))
        db.agents().insertMessages((0L until 101L).map { AgentMessageRow(sessionId = "s1", absIndex = it, kind = "text", payloadJson = "{}") })
        logs["s1"] = FakeLog(total = 100)

        repo.applySessionsList(listOf(sessionInfo("s1", 100)))

        assertTrue(logs["s1"]!!.requests.isEmpty())
        assertEquals(101, cachedIndices("s1").size)
    }

    @Test
    fun `a remote slash-clear user_prompt wipes the session cache like a local one`() = runTest {
        db.agents().upsertSessions(listOf(session("s1", logLen = 50)))
        db.agents().insertMessages((0L until 50L).map { AgentMessageRow(sessionId = "s1", absIndex = it, kind = "text", payloadJson = "{}") })
        logs["s1"] = FakeLog(total = 50)
        repo.applySessionsList(listOf(sessionInfo("s1", 50))) // opens the live-append gate

        repo.handleHubMessage("""{"type":"user_prompt","sessionId":"s1","content":"/clear","absIndex":0}""")

        assertEquals(emptyList<Long>(), cachedIndices("s1"))
        // The next hub row starts the new numbering cleanly.
        repo.handleHubMessage("""{"type":"user_prompt","sessionId":"s1","content":"hello again","absIndex":1}""")
        assertEquals(listOf(1L), cachedIndices("s1"))
    }

    @Test
    fun `older_messages fills a mid-transcript seam by each row's own absIndex`() = runTest {
        // Tail-jumped cache: [0, 200) ∪ [800, 1000). A seam load asks for the
        // 100 rows before 800; the hub answers with rows 700..799.
        db.agents().upsertSessions(listOf(session("s1", logLen = 1000)))
        db.agents().insertMessages(((0L until 200L) + (800L until 1000L)).map { AgentMessageRow(sessionId = "s1", absIndex = it, kind = "text", payloadJson = "{}") })
        val older = (700L until 800L).joinToString(",") { """{"type":"text","content":"m$it","absIndex":$it}""" }

        repo.handleHubMessage("""{"type":"older_messages","sessionId":"s1","messages":[$older],"hasMore":true}""")

        val cached = cachedIndices("s1")
        assertEquals((0L until 200L) + (700L until 1000L), cached)
        // The pre-fix arithmetic (minIndex − n + i) would have written these
        // as negative indices below row 0.
        assertTrue(cached.none { it < 0 })
    }

    @Test
    fun `an empty older_messages reply marks the seam exhausted so it is not re-asked`() = runTest {
        db.agents().upsertSessions(listOf(session("s1", logLen = 1000)))
        db.agents().insertMessages((800L until 1000L).map { AgentMessageRow(sessionId = "s1", absIndex = it, kind = "text", payloadJson = "{}") })
        assertTrue(repo.hasOlder("s1"))

        repo.handleHubMessage("""{"type":"older_messages","sessionId":"s1","messages":[],"hasMore":false}""")

        assertEquals(setOf(800L), repo.exhaustedOlder.value["s1"])
        assertFalse(repo.hasOlder("s1"))
    }

    private fun sessionInfo(id: String, logLen: Long) = kotlinx.serialization.json.buildJsonObject {
        put("id", kotlinx.serialization.json.JsonPrimitive(id))
        put("name", kotlinx.serialization.json.JsonPrimitive("S$id"))
        put("status", kotlinx.serialization.json.JsonPrimitive("idle"))
        put("messageLogLength", kotlinx.serialization.json.JsonPrimitive(logLen))
        put("lastReadIndex", kotlinx.serialization.json.JsonPrimitive(0))
    }

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
    fun `queued send stays pending with NO retry burn while agents ws is down`() = runTest {
        db.agents().upsertSessions(listOf(session("s1")))
        repo.sendPrompt("s1", "offline prompt")
        // WS never started — transport-down is NotReady, not Retry: the send
        // was never attempted so it must not consume the retry budget. A
        // drain storm during reconnect used to burn all 3 retries on "hub
        // disconnected" and park the row as terminal `failed`.
        repeat(5) { assertFalse(outbox.drain()) }
        assertEquals(1, db.outbox().pending().size)
        assertEquals(0, db.outbox().pending()[0].retryCount)
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
