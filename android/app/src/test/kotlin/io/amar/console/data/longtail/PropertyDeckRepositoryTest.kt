package io.amar.console.data.longtail

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
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Repository semantics over a scripted hub: the stack, the outbox rows, the refill, the undo. */
@RunWith(RobolectricTestRunner::class)
class PropertyDeckRepositoryTest {

    private lateinit var db: ConsoleDb
    private lateinit var outbox: Outbox
    private lateinit var repo: PropertyDeckRepository

    /** Every request the fake hub saw: "METHOD path" → body. */
    private val seen = mutableListOf<Pair<String, String>>()
    /** How many cards the fake deck holds; `limit` is honoured, `total` reports the full size. */
    private var deckSize = 3

    private fun card(i: Int) = """{"listingId":"l$i","searchId":"s1","kind":"house","portal":"rightmove","alsoOn":[],"country":"UK",
        "url":"https://x/$i","currency":"GBP","price":${100000 + i},"fixer":false,"lat":51.0,"lon":-1.0,"listedAt":"2026-09-${(12 - i).toString().padStart(2, '0')}"}"""

    private fun deckJson(limit: Int): String {
        val n = minOf(limit, deckSize)
        return """{"cards":[${(1..n).joinToString(",") { card(it) }}],"total":$deckSize,"counts":{"house":$deckSize,"farmland":0,"plot":0}}"""
    }

    private val hub = HubClient(
        OkHttpClient.Builder().addInterceptor { chain ->
            val req = chain.request()
            val body = req.body?.let { b -> okio.Buffer().also { b.writeTo(it) }.readUtf8() } ?: ""
            seen += "${req.method} ${req.url.encodedPath}" to body
            val text = when {
                req.url.encodedPath == "/hub/property/deck" -> deckJson(req.url.queryParameter("limit")?.toInt() ?: 30)
                req.url.encodedPath.endsWith("/review") -> """{"id":"s1"}"""
                else -> """{"error":"nope"}"""
            }
            Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(text.toResponseBody("application/json".toMediaType())).build()
        }.build()
    )

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), ConsoleDb::class.java).allowMainThreadQueries().build()
        val scope = TestScope()
        outbox = Outbox(ApplicationProvider.getApplicationContext(), scope, db, hub, SyncBusClient(scope), durableScheduler = {})
        repo = PropertyDeckRepository(hub, outbox)
        repo.registerOutboxHandlers()
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `load fills the stack newest first with the hub's counts`() = runTest {
        repo.load()
        val s = repo.state.value
        assertEquals(listOf("l1", "l2", "l3"), s.cards.map { it.listingId })
        assertEquals(3, s.total)
        assertEquals(3, s.counts["house"])
        assertEquals("house", s.kind)
    }

    @Test
    fun `judge drops the card, queues the verdict, and the drain posts it`() = runTest {
        repo.load()
        val top = repo.state.value.cards.first()
        repo.judge(top, Verdict.Interested)
        val s = repo.state.value
        assertEquals(listOf("l2", "l3"), s.cards.map { it.listingId })
        assertEquals(2, s.total)
        assertEquals(2, s.counts["house"])
        assertEquals(1, s.history.size)
        val rows = db.outbox().pending()
        assertEquals(1, rows.size)
        assertEquals(PropertyDeckRepository.TYPE_REVIEW, rows[0].type)
        assertEquals("s1/l1", rows[0].entityId)

        seen.clear()
        assertTrue(outbox.drain())
        val (call, body) = seen.single { it.first.startsWith("POST") }
        assertEquals("POST /hub/property/searches/s1/review", call)
        val p = Json.parseToJsonElement(body).jsonObject
        assertEquals("l1", p["listingId"]!!.jsonPrimitive.content)
        assertEquals("interested", p["state"]!!.jsonPrimitive.content)
        assertEquals(0, db.outbox().pending().size)
    }

    @Test
    fun `a judged card never comes back from a later page, even before the verdict lands`() = runTest {
        repo.load()
        repo.judge(repo.state.value.cards.first(), Verdict.Dismissed)
        // The verdict is still in the outbox; the hub would still serve l1.
        repo.load()
        assertEquals(listOf("l2", "l3"), repo.state.value.cards.map { it.listingId })
        assertEquals(2, repo.state.value.total)
    }

    @Test
    fun `undo puts the card back on top, withdraws a pending verdict, and queues none`() = runTest {
        repo.load()
        val top = repo.state.value.cards.first()
        repo.judge(top, Verdict.Dismissed)
        repo.undo()
        val s = repo.state.value
        assertEquals(listOf("l1", "l2", "l3"), s.cards.map { it.listingId })
        assertEquals(3, s.total)
        assertEquals(0, s.history.size)
        val rows = db.outbox().pending()
        assertEquals(1, rows.size) // the dismissed row is gone, one `none` remains
        val p = Json.parseToJsonElement(rows[0].payloadJson).jsonObject
        assertEquals("none", p["state"]!!.jsonPrimitive.content)
        // After the undo the hub may serve l1 again — and it must.
        repo.load()
        assertEquals(listOf("l1", "l2", "l3"), repo.state.value.cards.map { it.listingId })
    }

    @Test
    fun `skip sets a card aside without telling the hub, undo un-skips, show-skipped brings it back`() = runTest {
        repo.load()
        val top = repo.state.value.cards.first()
        repo.judge(top, Verdict.Skipped)
        var s = repo.state.value
        assertEquals(listOf("l2", "l3"), s.cards.map { it.listingId })
        assertEquals(3, s.total) // still to review
        assertEquals(1, s.skippedCount)
        assertEquals(0, db.outbox().pending().size)
        // A reload does not resurrect it this session.
        repo.load()
        assertEquals(listOf("l2", "l3"), repo.state.value.cards.map { it.listingId })
        // Undo puts it back, still nothing queued.
        repo.undo()
        s = repo.state.value
        assertEquals(listOf("l1", "l2", "l3"), s.cards.map { it.listingId })
        assertEquals(0, s.skippedCount)
        assertEquals(0, db.outbox().pending().size)
        // Skip everything → show skipped brings the whole stack back.
        repeat(3) { repo.judge(repo.state.value.cards.first(), Verdict.Skipped) }
        assertTrue(repo.state.value.cards.isEmpty())
        assertEquals(3, repo.state.value.skippedCount)
        repo.reviewSkipped()
        assertEquals(listOf("l1", "l2", "l3"), repo.state.value.cards.map { it.listingId })
        assertEquals(0, repo.state.value.history.size)
    }

    @Test
    fun `the stack refills from the hub when it runs low`() = runTest {
        deckSize = 60
        repo.load()
        assertEquals(PropertyDeckRepository.PAGE, repo.state.value.cards.size)
        assertEquals(60, repo.state.value.total)
        // Judge down to just under the refill line.
        repeat(PropertyDeckRepository.PAGE - PropertyDeckRepository.REFILL_AT + 1) {
            repo.judge(repo.state.value.cards.first(), Verdict.Dismissed)
        }
        val s = repo.state.value
        // Everything judged so far is filtered out of the refilled page; nothing repeats.
        assertEquals(s.cards.size, s.cards.map { it.key }.toSet().size)
        assertTrue(s.cards.size > PropertyDeckRepository.REFILL_AT)
        assertTrue(s.cards.none { it.listingId == "l1" })
        assertEquals(60 - (PropertyDeckRepository.PAGE - PropertyDeckRepository.REFILL_AT + 1), s.total)
    }
}
