package io.amar.console.data.inbox

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.core.HubConfig
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.MetaRow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Inbox routing rules survive offline (SPA ^spry-wren): the Room meta row seeds
 * the rules when the hub can't be reached, a successful pull refreshes the
 * mirror, and a save the hub dropped is PUSHED on the next refresh instead of
 * being overwritten by the stale hub copy.
 */
@RunWith(RobolectricTestRunner::class)
class InboxRulesPersistenceTest {

    private lateinit var db: ConsoleDb
    private lateinit var server: MockWebServer
    private lateinit var scope: CoroutineScope

    private val promoted = InboxRules(feedFeeds = mapOf("feed-1" to "inbox"))

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(), ConsoleDb::class.java
        ).allowMainThreadQueries().build()
        server = MockWebServer()
        server.start()
        HubConfig.init(ApplicationProvider.getApplicationContext())
        HubConfig.setHubBase(server.url("/hub").toString())
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    }

    @After
    fun tearDown() {
        scope.cancel()
        HubConfig.setHubBase("")
        runCatching { server.shutdown() }
        db.close()
    }

    private fun repo() = InboxRepository(scope, db, HubClient(), MutableStateFlow(emptyList()))

    @Test
    fun `offline boot seeds the rules from the Room mirror, not DEFAULT`() = runBlocking {
        db.meta().put(MetaRow(InboxRepository.RULES_META_KEY, promoted.toJson()))
        server.shutdown() // hub unreachable
        val r = repo()
        r.refreshRules()
        assertEquals("inbox", r.currentRules().feedFeeds["feed-1"])
        assertFalse(r.rulesDirty())
    }

    @Test
    fun `a successful pull replaces the rules and rewrites the mirror`() = runBlocking {
        db.meta().put(MetaRow(InboxRepository.RULES_META_KEY, InboxRules.DEFAULT.toJson()))
        server.enqueue(MockResponse().setBody(promoted.toJson()).addHeader("Content-Type", "application/json"))
        val r = repo()
        r.refreshRules()
        assertEquals("inbox", r.currentRules().feedFeeds["feed-1"])
        assertEquals("inbox", InboxRules.fromJson(db.meta().get(InboxRepository.RULES_META_KEY)).feedFeeds["feed-1"])
        assertEquals("/hub/inbox/rules", server.takeRequest().path)
    }

    @Test
    fun `a save the hub dropped stays dirty and is pushed on the next refresh instead of pulled over`() = runBlocking {
        val r = repo()
        server.enqueue(MockResponse().setResponseCode(503))
        r.refreshRules() // GET fails → rules stay DEFAULT, nothing dirty
        server.takeRequest()
        assertFalse(r.rulesDirty())
        // Promote while the hub is down: the POST fails.
        server.enqueue(MockResponse().setResponseCode(503))
        r.toggleRoute(
            InboxEntry(
                key = "feed:i1", source = InboxSource.FEED, sourceId = "i1", routeKey = "feed-1",
                header = "h", body = "b", ts = 1L, inInbox = false,
            )
        )
        server.takeRequest()
        waitUntil { r.rulesDirty() && db.meta().get(InboxRepository.RULES_META_KEY)?.contains("feed-1") == true }
        assertEquals("inbox", r.currentRules().feedFeeds["feed-1"])
        // Hub is back with the STALE copy: the refresh must POST ours, not GET theirs.
        server.enqueue(MockResponse().setBody("{}").addHeader("Content-Type", "application/json"))
        r.refreshRules()
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertTrue(req.body.readUtf8().contains("\"feed-1\":\"inbox\""))
        assertFalse(r.rulesDirty())
        assertEquals("inbox", r.currentRules().feedFeeds["feed-1"])
    }

    private suspend fun waitUntil(timeoutMs: Long = 5000, cond: suspend () -> Boolean) {
        val start = System.currentTimeMillis()
        while (!cond()) {
            if (System.currentTimeMillis() - start > timeoutMs) throw AssertionError("condition not met in ${timeoutMs}ms")
            kotlinx.coroutines.delay(20)
        }
    }
}
