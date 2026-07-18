package io.amar.console.data.feeds

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.FeedItemRow
import io.amar.console.data.db.FeedReadRow
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class FeedsRepositoryTest {

    private lateinit var db: ConsoleDb
    private lateinit var repo: FeedsRepository
    private lateinit var outbox: Outbox

    private fun item(id: String, feedId: String = "f1", at: Long = 100) = FeedItemRow(
        id = id, feedId = feedId, title = "T$id", link = null, content = null,
        snippet = "s", publishedAt = at, imageUrl = null,
    )

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(), ConsoleDb::class.java
        ).allowMainThreadQueries().build()
        val scope = TestScope()
        outbox = Outbox(
            ApplicationProvider.getApplicationContext(), scope, db,
            HubClient(), SyncBusClient(scope), durableScheduler = {},
        )
        repo = FeedsRepository(db, HubClient(), outbox)
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `markRead persists a pending marker and queues ONE coalesced sync row`() = runTest {
        db.feeds().upsertItems(listOf(item("i1"), item("i2")))
        repo.markRead("i1")
        repo.markRead("i2")
        assertEquals(listOf("i1", "i2"), db.feeds().pendingReadIds().sorted())
        // Coalesced: one outbox row, not two.
        assertEquals(1, db.outbox().pending().size)
    }

    @Test
    fun `flush pushes all pending ids in one PUT and marks them synced`() = runTest {
        db.feeds().upsertItems(listOf(item("i1"), item("i2")))
        repo.markRead("i1")
        repo.markRead("i2")
        // Fake the hub PUT via a substitute handler that mirrors the real
        // one's DAO discipline (HubClient needs a live server).
        outbox.register(FeedsRepository.TYPE_READ_SYNC) { _, _ ->
            val pending = db.feeds().pendingReadIds()
            db.feeds().markSynced(pending)
            Outbox.Result.Done
        }
        assertTrue(outbox.drain())
        assertEquals(0, db.feeds().pendingReadIds().size)
    }

    @Test
    fun `markUnread removes the marker`() = runTest {
        db.feeds().upsertRead(listOf(FeedReadRow("i1", pendingSync = false)))
        repo.markUnread("i1")
        assertEquals(0, db.feeds().pendingReadIds().size)
        assertEquals(emptyList<String>(), db.feeds().observeReadIds().first())
    }

    @Test
    fun `per-feed prune keeps the newest N`() = runTest {
        db.feeds().upsertItems((1..10).map { item("a$it", "feedA", it.toLong()) })
        db.feeds().upsertItems((1..3).map { item("b$it", "feedB", it.toLong()) })
        db.feeds().pruneFeed("feedA", 4)
        val remaining = db.feeds().observeRecent(100).first()
        assertEquals(7, remaining.size) // 4 kept in A + 3 in B
        assertTrue(remaining.none { it.id == "a1" })
        assertTrue(remaining.any { it.id == "a10" })
    }

    @Test
    fun `hub read-state merges down without clobbering pending local marks`() = runTest {
        repo.markRead("local-only")
        // Simulate the reconcile down-merge.
        db.feeds().upsertRead(listOf(FeedReadRow("from-hub", pendingSync = false)))
        val pending = db.feeds().pendingReadIds()
        assertEquals(listOf("local-only"), pending)
    }
}
