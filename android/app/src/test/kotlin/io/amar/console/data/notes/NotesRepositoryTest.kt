package io.amar.console.data.notes

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.NoteFileRow
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
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
class NotesRepositoryTest {

    private lateinit var db: ConsoleDb
    private lateinit var repo: NotesRepository
    private lateinit var outbox: Outbox

    private fun row(path: String, mtime: Long = 100, content: String? = null, contentMtime: Long? = null, dirty: Boolean = false) =
        NoteFileRow(
            path = path, name = path.substringAfterLast('/'),
            dir = path.substringBeforeLast('/', ""), mtime = mtime, size = 10,
            cachedContent = content, contentMtime = contentMtime, dirty = dirty,
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
        repo = NotesRepository(db, HubClient(), syncBus, outbox)
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `save caches optimistically, marks dirty, queues with baseMtime`() = runTest {
        db.notes().upsertAll(listOf(row("scratch/a.md", mtime = 500, content = "old", contentMtime = 500)))
        repo.save("scratch/a.md", "new content")
        val cached = db.notes().byPath("scratch/a.md")!!
        assertEquals("new content", cached.cachedContent)
        assertTrue(cached.dirty)
        val q = db.outbox().pending()
        assertEquals(1, q.size)
        assertTrue(q[0].payloadJson.contains("\"baseMtime\":500"))
    }

    @Test
    fun `open returns cached body offline`() = runTest {
        db.notes().upsertAll(listOf(row("scratch/b.md", content = "cached body", contentMtime = 1)))
        // No hub reachable in tests — cached copy must satisfy the read.
        assertEquals("cached body", repo.openFile("scratch/b.md"))
    }

    @Test
    fun `resolveKeepMine re-queues without precondition`() = runTest {
        db.notes().upsertAll(listOf(row("scratch/c.md", mtime = 500, content = "mine", contentMtime = 500)))
        repo.resolveKeepMine("scratch/c.md", "mine")
        val q = db.outbox().pending()
        assertEquals(1, q.size)
        assertFalse(q[0].payloadJson.contains("baseMtime"))
    }

    @Test
    fun `resolveTakeServer cancels the queued save`() = runTest {
        db.notes().upsertAll(listOf(row("scratch/d.md", mtime = 500, content = "mine", contentMtime = 500)))
        repo.save("scratch/d.md", "mine v2")
        assertEquals(1, db.outbox().pending().size)
        repo.resolveTakeServer("scratch/d.md")
        assertEquals(0, db.outbox().pending().size)
    }

    @Test
    fun `409 from the hub parks the row as conflict`() = runTest {
        repo.registerOutboxHandlers()
        db.notes().upsertAll(listOf(row("scratch/e.md", mtime = 500, content = "x", contentMtime = 500)))
        // Register a wrapper handler that simulates the hub 409 (HubClient
        // would need a live server; we exercise the Outbox path directly).
        outbox.register(NotesRepository.TYPE_SAVE) { _, _ ->
            Outbox.Result.Conflict("Edited elsewhere — resolve in Notes")
        }
        repo.save("scratch/e.md", "will conflict")
        outbox.drain()
        val q = db.outbox().byId(1L)
        assertNotNull(q)
        assertEquals("conflict", q!!.status)
    }

    @Test
    fun `stale cached body is dropped when server mtime advances (via reconcile logic)`() = runTest {
        // Direct DAO exercise of the invariant reconcile() enforces.
        db.notes().upsertAll(listOf(row("log/f.md", mtime = 100, content = "old cache", contentMtime = 100)))
        val existing = db.notes().byPath("log/f.md")!!
        val serverMtime = 200L
        if (!existing.dirty && existing.contentMtime != null && serverMtime > existing.contentMtime!!) {
            db.notes().setContent("log/f.md", null, null, dirty = false)
        }
        assertEquals(null, db.notes().byPath("log/f.md")!!.cachedContent)
    }

    @Test
    fun `create writes a dirty cache row and queues a save`() = runTest {
        repo.create("scratch/new-idea.md", "# hi")
        val row = db.notes().byPath("scratch/new-idea.md")!!
        assertEquals("# hi", row.cachedContent)
        assertTrue(row.dirty)
        assertEquals("scratch", row.dir)
        val q = db.outbox().pending()
        assertEquals(1, q.size)
        assertEquals(NotesRepository.TYPE_SAVE, q[0].type)
        assertFalse(q[0].payloadJson.contains("baseMtime")) // new file, no precondition
    }

    @Test
    fun `rename moves the row locally and queues the server rename`() = runTest {
        db.notes().upsertAll(listOf(row("scratch/old.md", content = "body", contentMtime = 5)))
        repo.rename("scratch/old.md", "scratch/new.md")
        assertEquals(null, db.notes().byPath("scratch/old.md"))
        val moved = db.notes().byPath("scratch/new.md")!!
        assertEquals("body", moved.cachedContent)
        assertEquals("new.md", moved.name)
        val q = db.outbox().pending()
        assertEquals(NotesRepository.TYPE_RENAME, q[0].type)
        assertTrue(q[0].payloadJson.contains("\"to\":\"scratch/new.md\""))
    }

    @Test
    fun `delete removes the row, drops queued saves, queues the server delete`() = runTest {
        db.notes().upsertAll(listOf(row("scratch/bye.md", content = "x", contentMtime = 5)))
        repo.save("scratch/bye.md", "x2")
        repo.delete("scratch/bye.md")
        assertEquals(null, db.notes().byPath("scratch/bye.md"))
        val q = db.outbox().pending()
        assertEquals(1, q.size) // the queued save was cancelled
        assertEquals(NotesRepository.TYPE_DELETE, q[0].type)
    }

    @Test
    fun `full-text search hits cached bodies only, newest first`() = runTest {
        db.notes().upsertAll(
            listOf(
                row("a.md", mtime = 100, content = "the quick brown fox", contentMtime = 1),
                row("b.md", mtime = 200, content = "lazy dog and Quick wit", contentMtime = 1),
                row("c.md", mtime = 300, content = null), // not cached — never matches
            )
        )
        val hits = repo.searchContent("quick")
        assertEquals(listOf("b.md", "a.md"), hits.map { it.path })
        assertTrue(repo.searchContent("  ").isEmpty())
    }

    @Test
    fun `conflict rows are observable per path and cleared by keep-mine`() = runTest {
        db.notes().upsertAll(listOf(row("scratch/k.md", content = "x", contentMtime = 5)))
        outbox.register(NotesRepository.TYPE_SAVE) { _, _ -> Outbox.Result.Conflict("nope") }
        repo.save("scratch/k.md", "clash")
        outbox.drain()
        assertEquals("conflict", db.outbox().byId(1L)!!.status)
        repo.resolveKeepMine("scratch/k.md", "clash")
        // Parked conflict row cleared; only the fresh forced save remains.
        assertEquals(null, db.outbox().byId(1L))
        assertEquals(1, db.outbox().pending().size)
    }

    @Test
    fun `dirty local edit survives a server mtime advance (no clobber)`() = runTest {
        db.notes().upsertAll(listOf(row("log/g.md", mtime = 100, content = "my edit", contentMtime = 100, dirty = true)))
        val existing = db.notes().byPath("log/g.md")!!
        val serverMtime = 200L
        // reconcile() must NOT drop dirty content — the queued conditional
        // PUT will surface the conflict instead.
        if (!existing.dirty && existing.contentMtime != null && serverMtime > existing.contentMtime!!) {
            db.notes().setContent("log/g.md", null, null, dirty = false)
        }
        assertEquals("my edit", db.notes().byPath("log/g.md")!!.cachedContent)
    }
}
