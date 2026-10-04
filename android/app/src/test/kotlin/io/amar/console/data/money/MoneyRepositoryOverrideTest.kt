package io.amar.console.data.money

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.MoneyTxRow
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** `money:override` end to end over a scripted hub: optimistic write, the request, the refresh, the heal. */
@RunWith(RobolectricTestRunner::class)
class MoneyRepositoryOverrideTest {

    private lateinit var db: ConsoleDb
    private lateinit var outbox: Outbox
    private lateinit var repo: MoneyRepository

    private val seen = mutableListOf<Pair<String, String>>()
    /** Status the fake hub answers writes with. */
    private var writeCode = 200
    /** What `/finance/categorise` says once the write lands. */
    private var hubClass = """{"categoryId":"cat_bills","ignored":false,"isTransfer":false}"""

    private val hub = HubClient(
        OkHttpClient.Builder().addInterceptor { chain ->
            val req = chain.request()
            val path = req.url.encodedPath
            val body = req.body?.let { b -> okio.Buffer().also { b.writeTo(it) }.readUtf8() } ?: ""
            seen += "${req.method} $path" to body
            val (code, text) = when {
                req.method != "GET" -> writeCode to (if (writeCode == 200) """{"ok":true}""" else """{"error":"x"}""")
                path.endsWith("/finance/categorise") -> 200 to """{"tx_1":$hubClass}"""
                path.endsWith("/finance/overrides") -> 200 to """[{"txId":"tx_1","categoryId":"cat_bills","ignore":false}]"""
                else -> 404 to """{"error":"nope"}"""
            }
            Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .body(text.toResponseBody("application/json".toMediaType())).build()
        }.build()
    )

    private val row = MoneyTxRow(
        id = "tx_1", amount = -1200, currency = "GBP", created = "2026-10-01T12:00:00Z", createdAt = 1, settled = "",
        description = "TESCO", merchantName = "Tesco", merchantEmoji = null, merchantLogo = null, counterpartyName = null,
        monzoCategory = "groceries", declineReason = null, notes = null, categoryId = "cat_food", ignored = false, isTransfer = false,
    )

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), ConsoleDb::class.java).allowMainThreadQueries().build()
        val scope = TestScope()
        outbox = Outbox(ApplicationProvider.getApplicationContext(), scope, db, hub, SyncBusClient(scope), durableScheduler = {})
        repo = MoneyRepository(db, hub, outbox)
        repo.registerOutboxHandlers()
        db.money().upsertAll(listOf(row))
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `recategorise writes the row now, posts the override, then takes the hub's classification`() = runTest {
        repo.applyOverride("tx_1", OverrideEdit.SetCategory("cat_bills"))
        assertEquals("cat_bills", db.money().byId("tx_1")!!.categoryId) // optimistic, before any drain
        assertEquals(TxOverride("tx_1", "cat_bills", false), repo.state.value.overrides["tx_1"])

        hubClass = """{"categoryId":"cat_bills","ignored":false,"isTransfer":false}"""
        outbox.drain()
        val post = seen.first { it.first.startsWith("POST") }
        assertTrue(post.first.endsWith("/finance/overrides"))
        assertEquals("""{"txId":"tx_1","categoryId":"cat_bills","ignore":false}""", post.second)
        assertTrue(seen.any { it.first == "GET /hub/finance/categorise" || it.first.endsWith("/finance/categorise") })
        assertEquals("cat_bills", db.money().byId("tx_1")!!.categoryId)
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test
    fun `reset deletes the override and pulls the rule-derived category back`() = runTest {
        repo.applyOverride("tx_1", OverrideEdit.SetCategory("cat_bills"))
        outbox.drain()
        hubClass = """{"categoryId":"cat_groceries","ignored":false,"isTransfer":false}"""
        repo.applyOverride("tx_1", OverrideEdit.Reset)
        outbox.drain()
        assertTrue(seen.any { it.first.startsWith("DELETE") && it.first.endsWith("/finance/overrides/tx_1") })
        assertEquals("cat_groceries", db.money().byId("tx_1")!!.categoryId)
    }

    @Test
    fun `reset of an override the hub no longer has is still done`() = runTest {
        writeCode = 404
        repo.applyOverride("tx_1", OverrideEdit.Reset)
        outbox.drain()
        assertTrue(db.outbox().pending().isEmpty())
        assertEquals(0, db.outbox().inFlightEntityIds(MoneyRepository.TYPE_OVERRIDE).size)
    }

    @Test
    fun `a rejected write heals the row and the override map`() = runTest {
        writeCode = 400
        repo.applyOverride("tx_1", OverrideEdit.Ignore(true))
        assertTrue(db.money().byId("tx_1")!!.ignored)
        outbox.drain()
        val healed = db.money().byId("tx_1")!!
        assertFalse(healed.ignored)
        assertEquals("cat_food", healed.categoryId)
        assertNull(repo.state.value.overrides["tx_1"])
    }
}
