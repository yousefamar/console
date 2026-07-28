package io.amar.console.sync.outbox

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.SyncBusClient
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Outbox semantics ported from the SPA's sync-queue: retry→failed after 3,
 * conflict parking, dedupe-token stability across retries, undo cancellation,
 * crash recovery.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class OutboxTest {

    private lateinit var db: ConsoleDb
    private lateinit var outbox: Outbox
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(context, ConsoleDb::class.java)
            .allowMainThreadQueries()
            .build()
        val scope = TestScope()
        outbox = Outbox(
            context, scope, db,
            HubClient(), SyncBusClient(scope),
            durableScheduler = { /* no WorkManager in unit tests */ },
        )
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun `success removes the row`() = runTest {
        outbox.register("noop") { _, _ -> Outbox.Result.Done }
        outbox.enqueue("noop", "{}")
        assertTrue(outbox.drain())
        assertEquals(0, db.outbox().pending().size)
    }

    @Test
    fun `retry three times then terminal failed`() = runTest {
        var attempts = 0
        outbox.register("flaky") { _, _ ->
            attempts++
            Outbox.Result.Retry("still down")
        }
        val id = outbox.enqueue("flaky", "{}")
        // Drain repeatedly — each drain retries pending rows once.
        repeat(5) { outbox.drain() }
        assertEquals(Outbox.MAX_RETRIES, attempts)
        assertEquals("failed", db.outbox().byId(id)?.status)
    }

    @Test
    fun `NotReady never consumes the retry budget`() = runTest {
        var attempts = 0
        outbox.register("gated") { _, _ ->
            attempts++
            Outbox.Result.NotReady("hub disconnected")
        }
        val id = outbox.enqueue("gated", "{}")
        // Far more drains than MAX_RETRIES (a reconnect storm) — the row must
        // stay pending with retryCount 0, never parked as terminal failed.
        repeat(10) { outbox.drain() }
        assertEquals(10, attempts)
        val row = db.outbox().byId(id)
        assertEquals("pending", row?.status)
        assertEquals(0, row?.retryCount)
    }

    @Test
    fun `drain recovers rows leaked in 'processing' by an aborted earlier drain`() = runTest {
        outbox.register("noop") { _, _ -> Outbox.Result.Done }
        val id = outbox.enqueue("noop", "{}")
        // Simulate a drain cancelled mid-row: status was flipped to
        // processing but no result was ever written.
        db.outbox().setStatus(id, "processing")
        assertTrue(outbox.drain()) // must reset → pending → handle → Done
        assertEquals(0, db.outbox().pending().size)
        assertEquals(null, db.outbox().byId(id))
    }

    @Test
    fun `retryOrNotReady classifies transport-down vs real errors`() {
        assertTrue(Outbox.retryOrNotReady(RuntimeException("hub disconnected"), "x") is Outbox.Result.NotReady)
        assertTrue(Outbox.retryOrNotReady(RuntimeException("Failed to connect to /127.0.0.1:9877"), "x") is Outbox.Result.NotReady)
        assertTrue(Outbox.retryOrNotReady(RuntimeException("Unable to resolve host con.amar.io"), "x") is Outbox.Result.NotReady)
        assertTrue(Outbox.retryOrNotReady(RuntimeException("HTTP 500"), "x") is Outbox.Result.Retry)
        assertTrue(Outbox.retryOrNotReady(RuntimeException(), "fallback") is Outbox.Result.Retry)
    }

    @Test
    fun `dedupe token is stable across retries`() = runTest {
        val seenTokens = mutableSetOf<String>()
        var calls = 0
        outbox.register("send") { row, _ ->
            seenTokens.add(row.dedupeToken)
            calls++
            if (calls < 2) Outbox.Result.Retry("first fails") else Outbox.Result.Done
        }
        outbox.enqueue("send", "{}")
        outbox.drain()
        outbox.drain()
        assertEquals(2, calls)
        assertEquals(1, seenTokens.size) // same token both attempts
    }

    @Test
    fun `conflict parks the row without retries`() = runTest {
        var calls = 0
        outbox.register("reply") { _, _ ->
            calls++
            Outbox.Result.Conflict("thread changed")
        }
        val id = outbox.enqueue("reply", "{}")
        outbox.drain()
        outbox.drain() // conflict rows are not pending — must not re-run
        assertEquals(1, calls)
        assertEquals("conflict", db.outbox().byId(id)?.status)
    }

    @Test
    fun `cancel drops a pending action for the entity (undo)`() = runTest {
        outbox.register("archive") { _, _ -> Outbox.Result.Done }
        outbox.enqueue("archive", "{}", entityId = "thread-1")
        outbox.cancel("thread-1", "archive")
        assertTrue(outbox.drain())
        assertEquals(0, db.outbox().pending().size)
    }

    @Test
    fun `unknown type is parked as failed, not crash`() = runTest {
        val id = outbox.enqueue("from-the-future", "{}")
        outbox.drain()
        assertEquals("failed", db.outbox().byId(id)?.status)
    }

    @Test
    fun `resetStuckProcessing recovers crash-wedged rows`() = runTest {
        outbox.register("noop") { _, _ -> Outbox.Result.Done }
        val id = outbox.enqueue("noop", "{}")
        db.outbox().setStatus(id, "processing") // simulate crash mid-drain
        outbox.resetStuckProcessing()
        assertTrue(outbox.drain())
        assertEquals(0, db.outbox().pending().size)
    }

    @Test
    fun `rows drain oldest first`() = runTest {
        val order = mutableListOf<String>()
        outbox.register("seq") { row, _ ->
            order.add(row.payloadJson)
            Outbox.Result.Done
        }
        outbox.enqueue("seq", "first")
        outbox.enqueue("seq", "second")
        outbox.enqueue("seq", "third")
        outbox.drain()
        assertEquals(listOf("first", "second", "third"), order)
    }

    @Test
    fun `onFailed hook fires when a row goes terminal`() = runTest {
        var badgeSet = false
        outbox.register("chatSend") { _, _ -> Outbox.Result.Retry("down") }
        outbox.register("chatSend:onFailed") { _, _ ->
            badgeSet = true
            Outbox.Result.Done
        }
        outbox.enqueue("chatSend", "{}")
        repeat(4) { outbox.drain() }
        assertTrue(badgeSet)
    }
}
