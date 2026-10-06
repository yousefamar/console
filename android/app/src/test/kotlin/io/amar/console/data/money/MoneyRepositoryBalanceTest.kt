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

/**
 * `money:balance` end to end over a scripted hub: the optimistic ledger write,
 * the request, the refresh, the heal, and the in-flight guard that stops a
 * reconcile re-applying the pre-edit copy.
 */
@RunWith(RobolectricTestRunner::class)
class MoneyRepositoryBalanceTest {

    private lateinit var db: ConsoleDb
    private lateinit var outbox: Outbox
    private lateinit var repo: MoneyRepository

    private val seen = mutableListOf<Triple<String, String, String>>() // method, path, body
    private var writeCode = 200

    /** The hub's ledger — what every GET answers with. */
    private var hubLedger = """[{"id":"bal_1","date":"2026-08-01","balancePence":120000}]"""

    private fun accountsJson() = """
        [{"id":"acc_1","name":"Lloyds","type":"manual","liquidity":"liquid","currency":"GBP","ledger":$hubLedger},
         {"id":"acc_2","name":"Monzo","type":"monzo","liquidity":"liquid","currency":"GBP"}]
    """.trimIndent()

    private val hub = HubClient(
        OkHttpClient.Builder().addInterceptor { chain ->
            val req = chain.request()
            val path = req.url.encodedPath
            val body = req.body?.let { b -> okio.Buffer().also { b.writeTo(it) }.readUtf8() } ?: ""
            seen += Triple(req.method, path, body)
            val (code, text) = when {
                req.method != "GET" -> writeCode to (
                    if (writeCode != 200) """{"error":"nope"}"""
                    else """{"id":"bal_2","date":"2026-10-06","balancePence":160000,"note":"checked app"}"""
                    )
                path.endsWith("/finance/accounts") -> 200 to accountsJson()
                path.endsWith("/finance/all") -> 200 to """{"categories":[],"accounts":${accountsJson()},"settings":{"emergencyFund":{"mode":"fixed"}}}"""
                path.endsWith("/finance/networth/history") -> 200 to """[{"date":"2026-09-30","liquidPence":150050,"investmentPence":0,"totalPence":150050}]"""
                path.endsWith("/finance/networth") -> 200 to """{"date":"2026-10-06","liquidPence":160000,"investmentPence":0,"totalPence":160000,"byAccount":[{"accountId":"acc_1","balancePence":160000}]}"""
                path.endsWith("/finance/projection") -> 200 to """{"emergencyFundPence":100000,"runway":{"liquidPence":160000,"investmentPence":0,"totalPence":160000,"emergencyFundPence":100000,"monthlyBurnPence":-1000,"monthsToFloor":12.0,"floorDate":"2027-10","monthsToZero":null,"zeroDate":null}}"""
                path.endsWith("/finance/categorise") -> 200 to "{}"
                path.endsWith("/finance/overrides") -> 200 to "[]"
                path.endsWith("/money/transactions") -> 200 to "[]"
                path.endsWith("/money/status") -> 200 to """{"connected":true,"hasCredentials":true,"lastSync":null,"transactionCount":0}"""
                else -> 404 to """{"error":"nope"}"""
            }
            Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .body(text.toResponseBody("application/json".toMediaType())).build()
        }.build()
    )

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), ConsoleDb::class.java)
            .allowMainThreadQueries().build()
        val scope = TestScope()
        outbox = Outbox(ApplicationProvider.getApplicationContext(), scope, db, hub, SyncBusClient(scope), durableScheduler = {})
        repo = MoneyRepository(db, hub, outbox)
        repo.registerOutboxHandlers()
        repo.reconcile()
        seen.clear()
    }

    @After
    fun tearDown() = db.close()

    private fun ledgerOf(id: String = "acc_1") = repo.state.value.accounts.first { it.id == id }.ledger

    @Test
    fun `reconcile loads accounts with their ledgers and per-account balances`() {
        assertEquals(listOf("acc_1", "acc_2"), repo.state.value.accounts.map { it.id })
        assertEquals(1, ledgerOf().size)
        assertEquals(160_000L, repo.state.value.balances["acc_1"])
    }

    @Test
    fun `logging a balance shows now, posts the reading, then takes the hub's ledger`() = runTest {
        repo.applyBalanceEdit("acc_1", LedgerEdit.Add("2026-10-06", 160_000, "checked app"))
        // Optimistic, before any drain: a local entry the row can already render.
        assertEquals(2, ledgerOf().size)
        val local = ledgerOf().last()
        assertTrue(local.isLocal)
        assertEquals(160_000L, local.balancePence)

        hubLedger = """[{"id":"bal_1","date":"2026-08-01","balancePence":120000},
                        {"id":"bal_2","date":"2026-10-06","balancePence":160000,"note":"checked app"}]"""
        outbox.drain()

        val post = seen.first { it.first == "POST" }
        assertTrue(post.second.endsWith("/finance/accounts/acc_1/balance"))
        assertEquals("""{"date":"2026-10-06","balancePence":160000,"note":"checked app"}""", post.third)
        // The hub's own entry replaced the local one — no duplicate, no local id left.
        assertEquals(listOf("bal_1", "bal_2"), ledgerOf().map { it.id })
        assertFalse(ledgerOf().any { it.isLocal })
        assertTrue(db.outbox().pending().isEmpty())
        // The ledger IS the net-worth input, so the history and runway were refetched.
        assertTrue(seen.any { it.second.endsWith("/finance/networth/history") })
        assertEquals(150_050L, repo.state.value.netWorthHistory.lastOrNull()?.liquidPence)
        assertEquals(160_000L, repo.state.value.projection?.runway?.liquidPence)
    }

    @Test
    fun `editing a reading patches that entry`() = runTest {
        repo.applyBalanceEdit("acc_1", LedgerEdit.Update("bal_1", "2026-08-02", 121_000, ""))
        assertEquals(121_000L, ledgerOf().first().balancePence)
        assertEquals("2026-08-02", ledgerOf().first().date)

        hubLedger = """[{"id":"bal_1","date":"2026-08-02","balancePence":121000}]"""
        outbox.drain()
        val patch = seen.first { it.first == "PATCH" }
        assertTrue(patch.second.endsWith("/finance/accounts/acc_1/balance/bal_1"))
        assertEquals("""{"date":"2026-08-02","balancePence":121000,"note":""}""", patch.third)
        assertEquals(121_000L, ledgerOf().first().balancePence)
    }

    @Test
    fun `deleting a reading drops it, and a 404 means it was already gone`() = runTest {
        repo.applyBalanceEdit("acc_1", LedgerEdit.Delete("bal_1"))
        assertTrue(ledgerOf().isEmpty())

        writeCode = 404
        hubLedger = "[]"
        outbox.drain()
        assertEquals("DELETE", seen.first { it.first == "DELETE" }.first)
        assertTrue(ledgerOf().isEmpty())
        // 404 on a delete is the state we wanted: Done, not a parked row or a heal.
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test
    fun `a rejected write heals the ledger back`() = runTest {
        repo.applyBalanceEdit("acc_1", LedgerEdit.Add("2026-10-06", 160_000, null))
        assertEquals(2, ledgerOf().size)

        writeCode = 400
        outbox.drain()
        // Terminal failure → the optimistic reading is gone, not left looking logged.
        assertEquals(listOf("bal_1"), ledgerOf().map { it.id })
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test
    fun `a reconcile while the reading is queued keeps the local copy`() = runTest {
        repo.applyBalanceEdit("acc_1", LedgerEdit.Add("2026-10-06", 160_000, null))
        assertEquals(2, ledgerOf().size)

        // The hub has not seen it yet (offline), so its accounts still hold one entry.
        repo.reconcile()
        assertEquals(2, ledgerOf().size)
        assertTrue(ledgerOf().any { it.isLocal })
        // Accounts with no queued edit still follow the hub.
        assertTrue(repo.state.value.accounts.first { it.id == "acc_2" }.ledger.isEmpty())
    }

    @Test
    fun `the ledger survives a restart from the offline cache`() = runTest {
        repo.applyBalanceEdit("acc_1", LedgerEdit.Add("2026-10-06", 160_000, "cash machine"))
        val fresh = MoneyRepository(db, hub, outbox)
        fresh.hydrate()
        val cached = fresh.state.value.accounts.first { it.id == "acc_1" }
        assertEquals(2, cached.ledger.size)
        assertEquals("cash machine", cached.ledger.last().note)
        assertEquals(160_000L, fresh.state.value.balances["acc_1"])
    }

    @Test
    fun `an edit to an unknown account is refused rather than enqueued`() = runTest {
        val e = runCatching { repo.applyBalanceEdit("acc_nope", LedgerEdit.Add("2026-10-06", 1, null)) }.exceptionOrNull()
        assertNull(db.outbox().pending().firstOrNull { it.type == MoneyRepository.TYPE_BALANCE })
        assertTrue(e is IllegalStateException)
    }
}
