package io.amar.console.data.money

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
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

/** `money:budget` end to end over a scripted hub: optimistic write, the request, the refresh, the heal. */
@RunWith(RobolectricTestRunner::class)
class MoneyRepositoryBudgetTest {

    private lateinit var db: ConsoleDb
    private lateinit var outbox: Outbox
    private lateinit var repo: MoneyRepository

    private val seen = mutableListOf<Pair<String, String>>()
    private var writeCode = 200

    /** What the hub's budget list says — the test moves this to mimic a landed write. */
    private var hubBudgets = """[{"id":"bud_1","categoryId":"cat_food","monthlyTargetPence":40000}]"""
    private var hubStatus =
        """[{"budgetId":"bud_1","categoryId":"cat_food","monthlyTargetPence":40000,"spentPence":21000,"remainingPence":19000,"pct":0.525,"projectedEndOfMonthPence":32000}]"""

    private val hub = HubClient(
        OkHttpClient.Builder().addInterceptor { chain ->
            val req = chain.request()
            val path = req.url.encodedPath
            val body = req.body?.let { b -> okio.Buffer().also { b.writeTo(it) }.readUtf8() } ?: ""
            seen += "${req.method} $path" to body
            val (code, text) = when {
                req.method != "GET" -> writeCode to (if (writeCode == 200) """{"ok":true}""" else """{"error":"x"}""")
                path.endsWith("/finance/budget-status") -> 200 to hubStatus
                path.endsWith("/finance/budgets") -> 200 to hubBudgets
                path.endsWith("/finance/all") -> 200 to """{"categories":[
                    {"id":"cat_food","name":"Food","emoji":"🍔","color":"#a78bfa","kind":"expense"},
                    {"id":"cat_bills","name":"Bills","emoji":"🧾","color":"#f59e0b","kind":"expense"}],
                    "budgets":$hubBudgets,"settings":{"emergencyFund":{"mode":"months","months":6}}}"""
                path.endsWith("/money/transactions") -> 200 to "[]"
                path.endsWith("/finance/categorise") -> 200 to "{}"
                path.endsWith("/finance/overrides") -> 200 to "[]"
                path.endsWith("/finance/projection") -> 200 to """{"emergencyFundPence":100,"runway":{}}"""
                path.endsWith("/finance/networth/history") -> 200 to "[]"
                path.endsWith("/money/status") -> 200 to """{"connected":true,"hasCredentials":true,"transactionCount":0}"""
                else -> 404 to """{"error":"nope"}"""
            }
            Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .body(text.toResponseBody("application/json".toMediaType())).build()
        }.build()
    )

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), ConsoleDb::class.java).allowMainThreadQueries().build()
        val scope = TestScope()
        outbox = Outbox(ApplicationProvider.getApplicationContext(), scope, db, hub, SyncBusClient(scope), durableScheduler = {})
        repo = MoneyRepository(db, hub, outbox)
        repo.registerOutboxHandlers()
    }

    @After
    fun tearDown() = db.close()

    private fun posts() = seen.filter { it.first.startsWith("POST") && it.first.endsWith("/finance/budgets") }

    @Test
    fun `reconcile takes budgets off the finance-all payload and the status off its own route`() = runTest {
        repo.reconcile()
        assertEquals(listOf("bud_1"), repo.state.value.budgets.map { it.id })
        assertEquals(21000L, repo.state.value.budgetStatus.single().spentPence)
        assertEquals(MoneyBudgets.currentMonth(), repo.state.value.budgetMonth)
        // No separate GET /finance/budgets — /finance/all already carried them.
        assertFalse(seen.any { it.first == "GET /finance/budgets" })
        val row = repo.state.value.budgetRows.single()
        assertEquals("🍔 Food", row.label)
        assertEquals(0.8, row.projectedPct, 1e-9)
    }

    @Test
    fun `a new budget shows at once under a temp id, posts without one, then takes the hub's`() = runTest {
        repo.reconcile()
        repo.upsertBudget("cat_bills", 15_000)
        val local = repo.state.value.budgets.first { it.categoryId == "cat_bills" }
        assertTrue(local.isLocal) // optimistic, before any drain
        assertEquals(15_000L, local.monthlyTargetPence)

        hubBudgets = """[{"id":"bud_1","categoryId":"cat_food","monthlyTargetPence":40000},
                         {"id":"bud_2","categoryId":"cat_bills","monthlyTargetPence":15000}]"""
        outbox.drain()

        assertEquals("""{"categoryId":"cat_bills","monthlyTargetPence":15000}""", posts().single().second)
        val landed = repo.state.value.budgets.first { it.categoryId == "cat_bills" }
        // The refresh runs while its own outbox row is still `processing`, so it
        // must exclude that category from the in-flight overlay — otherwise our
        // `~` temp row wins over the hub's and the real id never arrives.
        assertEquals("bud_2", landed.id)
        assertFalse(landed.isLocal)
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test
    fun `retargeting an existing budget sends its hub id`() = runTest {
        repo.reconcile()
        repo.upsertBudget("cat_food", 55_000, "bud_1")
        assertEquals(55_000L, repo.state.value.budgets.single { it.categoryId == "cat_food" }.monthlyTargetPence)
        hubBudgets = """[{"id":"bud_1","categoryId":"cat_food","monthlyTargetPence":55000}]"""
        outbox.drain()
        assertEquals("""{"id":"bud_1","categoryId":"cat_food","monthlyTargetPence":55000}""", posts().single().second)
        assertEquals(55_000L, repo.state.value.budgets.single().monthlyTargetPence)
    }

    @Test
    fun `deleting a synced budget drops the row now and DELETEs it`() = runTest {
        repo.reconcile()
        val b = repo.state.value.budgets.single()
        repo.deleteBudget(b)
        assertTrue(repo.state.value.budgets.isEmpty())
        hubBudgets = "[]"
        hubStatus = "[]"
        outbox.drain()
        assertTrue(seen.any { it.first.startsWith("DELETE") && it.first.endsWith("/finance/budgets/bud_1") })
        assertTrue(repo.state.value.budgets.isEmpty())
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test
    fun `deleting a budget the hub never saw just cancels the queued create`() = runTest {
        repo.reconcile()
        repo.upsertBudget("cat_bills", 15_000)
        val local = repo.state.value.budgets.first { it.categoryId == "cat_bills" }
        repo.deleteBudget(local)
        assertTrue(repo.state.value.budgets.none { it.categoryId == "cat_bills" })
        assertEquals(0, db.outbox().inFlightEntityIds(MoneyRepository.TYPE_BUDGET).size)
        outbox.drain()
        // Nothing was ever sent for it — no POST of 15000, and no `~`-id DELETE to 404 forever.
        assertTrue(posts().isEmpty())
        assertFalse(seen.any { it.first.startsWith("DELETE") })
    }

    @Test
    fun `a delete the hub has already applied is still done`() = runTest {
        repo.reconcile()
        val b = repo.state.value.budgets.single()
        writeCode = 404
        repo.deleteBudget(b)
        outbox.drain()
        assertTrue(db.outbox().pending().isEmpty())
        assertEquals(0, db.outbox().inFlightEntityIds(MoneyRepository.TYPE_BUDGET).size)
    }

    @Test
    fun `a rejected edit heals the list back`() = runTest {
        repo.reconcile()
        writeCode = 400
        repo.upsertBudget("cat_food", 90_000, "bud_1")
        assertEquals(90_000L, repo.state.value.budgets.single().monthlyTargetPence)
        outbox.drain()
        assertEquals(40_000L, repo.state.value.budgets.single().monthlyTargetPence)
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test
    fun `a rejected create drops the row it added`() = runTest {
        repo.reconcile()
        writeCode = 400
        repo.upsertBudget("cat_bills", 15_000)
        assertEquals(2, repo.state.value.budgets.size)
        outbox.drain()
        assertEquals(listOf("cat_food"), repo.state.value.budgets.map { it.categoryId })
    }

    @Test
    fun `a reconcile does not undo an edit whose write is still queued`() = runTest {
        repo.reconcile()
        repo.upsertBudget("cat_food", 90_000, "bud_1")
        // The hub still serves its pre-edit copy while our POST sits in the outbox.
        repo.reconcile()
        assertEquals(90_000L, repo.state.value.budgets.single { it.categoryId == "cat_food" }.monthlyTargetPence)
        hubBudgets = """[{"id":"bud_1","categoryId":"cat_food","monthlyTargetPence":90000}]"""
        outbox.drain()
        repo.reconcile()
        assertEquals(90_000L, repo.state.value.budgets.single().monthlyTargetPence)
    }

    @Test
    fun `a reconcile does not resurrect a budget whose delete is still queued`() = runTest {
        repo.reconcile()
        repo.deleteBudget(repo.state.value.budgets.single())
        repo.reconcile() // hub still lists bud_1
        assertTrue(repo.state.value.budgets.isEmpty())
    }

    @Test
    fun `budgets and the status month survive a restart through the meta cache`() = runTest {
        repo.reconcile()
        val fresh = MoneyRepository(db, hub, outbox)
        fresh.hydrate()
        assertEquals(listOf("bud_1"), fresh.state.value.budgets.map { it.id })
        assertEquals(21000L, fresh.state.value.budgetStatus.single().spentPence)
        assertEquals(MoneyBudgets.currentMonth(), fresh.state.value.budgetMonth)
        assertNull(fresh.state.value.error)
    }
}
