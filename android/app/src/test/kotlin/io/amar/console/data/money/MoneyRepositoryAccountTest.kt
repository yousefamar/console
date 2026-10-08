package io.amar.console.data.money

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
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
 * `money:account` end to end over a scripted hub (responses by PATH, never
 * FIFO — HubConfig is process-wide and background pollers share it): the
 * optimistic write, the request shape the hub's `Object.assign` demands, the
 * refresh, the heal, and the reconcile guards.
 */
@RunWith(RobolectricTestRunner::class)
class MoneyRepositoryAccountTest {

    private lateinit var db: ConsoleDb
    private lateinit var outbox: Outbox
    private lateinit var repo: MoneyRepository

    private val seen = mutableListOf<Pair<String, String>>()
    private var writeCode = 200

    /** Set to make every call throw, i.e. the phone is offline. */
    private var offline = false

    private var hubAccounts = """[
        {"id":"acc_monzo","name":"Monzo","type":"monzo","liquidity":"liquid","monzoAccountId":"acc_live_1","sort":0},
        {"id":"acc_isa","name":"Vanguard ISA","type":"manual","liquidity":"investment","emoji":"📈","growthPctYoy":6.5,"sort":1,
         "ledger":[{"id":"bal_1","date":"2026-09-30","balancePence":123456,"note":"statement"}]},
        {"id":"acc_old","name":"Closed","type":"manual","liquidity":"liquid","archived":true,"sort":2}]"""

    private val hub = HubClient(
        OkHttpClient.Builder().addInterceptor { chain ->
            val req = chain.request()
            val path = req.url.encodedPath
            val body = req.body?.let { b -> okio.Buffer().also { b.writeTo(it) }.readUtf8() } ?: ""
            seen += "${req.method} $path" to body
            if (offline) throw java.io.IOException("offline")
            val (code, text) = when {
                req.method != "GET" -> writeCode to (if (writeCode == 200) """{"ok":true}""" else """{"error":"x"}""")
                path.endsWith("/finance/all") ->
                    200 to """{"categories":[],"rules":[],"budgets":[],"accounts":$hubAccounts}"""
                path.endsWith("/finance/accounts") -> 200 to hubAccounts
                path.endsWith("/finance/networth/history") -> 200 to "[]"
                path.endsWith("/finance/networth") -> 200 to """{"byAccount":[{"accountId":"acc_isa","balancePence":123456}]}"""
                path.endsWith("/finance/projection") -> 200 to """{"emergencyFundPence":100,"runway":{}}"""
                path.endsWith("/finance/budget-status") -> 200 to "[]"
                path.endsWith("/finance/categorise") -> 200 to "{}"
                path.endsWith("/finance/overrides") -> 200 to "[]"
                path.endsWith("/money/transactions") -> 200 to "[]"
                path.endsWith("/money/status") -> 200 to """{"connected":true,"hasCredentials":true,"transactionCount":0}"""
                else -> 404 to """{"error":"nope"}"""
            }
            Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .body(text.toResponseBody("application/json".toMediaType())).build()
        }.build()
    )

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), ConsoleDb::class.java)
            .allowMainThreadQueries().build()
        val scope = TestScope()
        outbox = Outbox(ApplicationProvider.getApplicationContext(), scope, db, hub, SyncBusClient(scope), durableScheduler = {})
        repo = MoneyRepository(db, hub, outbox)
        repo.registerOutboxHandlers()
    }

    @After
    fun tearDown() = db.close()

    private fun writes(method: String, suffix: String) =
        seen.filter { it.first.startsWith(method) && it.first.endsWith(suffix) }

    private fun bodyOf(req: Pair<String, String>) = MoneyJson.json.parseToJsonElement(req.second).jsonObject

    private val isa get() = repo.state.value.accounts.first { it.id == "acc_isa" }
    private val monzo get() = repo.state.value.accounts.first { it.id == "acc_monzo" }

    // ---- reconcile -------------------------------------------------------

    @Test
    fun `reconcile reads the fields the write path needs, off finance-all`() = runTest {
        repo.reconcile()
        assertEquals(listOf("acc_monzo", "acc_isa", "acc_old"), repo.state.value.accounts.map { it.id })
        assertEquals(6.5, isa.growthPctYoy!!, 1e-9)
        assertEquals("acc_live_1", monzo.monzoAccountId)
        assertEquals(1, isa.ledger.size)
        // Archived accounts are cached but not shown.
        assertTrue(MoneyAccounts.grouped(repo.state.value.accounts).flatMap { it.second }.none { it.id == "acc_old" })
        assertTrue(writes("GET", "/finance/accounts").isEmpty()) // the one payload covers it
    }

    @Test
    fun `accounts survive a restart through the meta cache, growth and all`() = runTest {
        repo.reconcile()
        val fresh = MoneyRepository(db, hub, outbox)
        fresh.hydrate()
        assertEquals(repo.state.value.accounts, fresh.state.value.accounts)
        assertEquals(6.5, fresh.state.value.accounts.first { it.id == "acc_isa" }.growthPctYoy!!, 1e-9)
    }

    // ---- create ----------------------------------------------------------

    @Test
    fun `a new account shows at once under its minted id and posts that id with no ledger`() = runTest {
        repo.reconcile()
        val a = MoneyAccounts.toAccount(MoneyAccounts.Draft(name = "Chase saver", liquidity = "liquid"), null)
        repo.upsertAccount(a)
        assertTrue(repo.state.value.accounts.any { it.id == a.id && it.name == "Chase saver" })

        hubAccounts = hubAccounts.trimEnd(']') +
            """,{"id":"${a.id}","name":"Chase saver","type":"manual","liquidity":"liquid","sort":3}]"""
        outbox.drain()

        val post = writes("POST", "/finance/accounts").single()
        assertEquals("\"${a.id}\"", bodyOf(post)["id"].toString())
        assertEquals("\"manual\"", bodyOf(post)["type"].toString())
        assertFalse(bodyOf(post).containsKey("ledger"))
        assertTrue(repo.state.value.accounts.any { it.id == a.id })
        assertEquals(3, repo.state.value.accounts.first { it.id == a.id }.sort) // the hub's own sort won
        assertTrue(db.outbox().pending().isEmpty())
        assertEquals(0, db.outbox().inFlightEntityIds(MoneyRepository.TYPE_ACCOUNT).size)
    }

    @Test
    fun `a create carrying a growth rate PATCHes it back - the hub's create branch drops it`() = runTest {
        repo.reconcile()
        val a = MoneyAccounts.toAccount(MoneyAccounts.Draft(name = "Chase saver", growth = "3.25"), null)
        repo.upsertAccount(a)
        hubAccounts = hubAccounts.trimEnd(']') +
            """,{"id":"${a.id}","name":"Chase saver","type":"manual","liquidity":"liquid","growthPctYoy":3.25,"sort":3}]"""
        outbox.drain()

        assertEquals(1, writes("POST", "/finance/accounts").size)
        val patch = writes("PATCH", "/finance/accounts/${a.id}").single()
        assertEquals("3.25", bodyOf(patch)["growthPctYoy"].toString())
        assertEquals(3.25, repo.state.value.accounts.first { it.id == a.id }.growthPctYoy!!, 1e-9)
    }

    @Test
    fun `a plain create sends no PATCH at all`() = runTest {
        repo.reconcile()
        repo.upsertAccount(MoneyAccounts.toAccount(MoneyAccounts.Draft(name = "Plain"), null))
        outbox.drain()
        assertTrue(seen.none { it.first.startsWith("PATCH") })
    }

    // ---- edit ------------------------------------------------------------

    @Test
    fun `an edit posts the whole record and sends the cleared optionals as nulls`() = runTest {
        repo.reconcile()
        repo.upsertAccount(
            MoneyAccounts.toAccount(MoneyAccounts.draftOf(isa).copy(name = "ISA", emoji = "", growth = ""), existing = isa)
        )
        assertEquals("ISA", isa.name)
        assertNull(isa.growthPctYoy)

        hubAccounts = hubAccounts
            .replace("\"name\":\"Vanguard ISA\"", "\"name\":\"ISA\"")
            .replace("\"emoji\":\"📈\",\"growthPctYoy\":6.5,", "")
        outbox.drain()

        val body = bodyOf(writes("POST", "/finance/accounts").single())
        assertEquals("\"acc_isa\"", body["id"].toString())
        assertEquals("null", body["emoji"].toString())
        assertEquals("null", body["growthPctYoy"].toString())
        assertEquals("ISA", isa.name)
    }

    @Test
    fun `an edit never sends a ledger, so the hub's balance history is untouchable from here`() = runTest {
        repo.reconcile()
        repo.upsertAccount(isa.copy(name = "ISA"))
        outbox.drain()
        assertFalse(bodyOf(writes("POST", "/finance/accounts").single()).containsKey("ledger"))
        // And the local copy keeps its readings through the write + refresh.
        assertEquals(1, isa.ledger.size)
    }

    @Test
    fun `an edit cannot rewrite the type or the Monzo link even if the caller tries`() = runTest {
        repo.reconcile()
        repo.upsertAccount(monzo.copy(name = "Monzo current", type = "manual", monzoAccountId = null))
        assertEquals("monzo", monzo.type)
        assertEquals("acc_live_1", monzo.monzoAccountId)
        outbox.drain()
        val body = bodyOf(writes("POST", "/finance/accounts").single())
        assertEquals("\"monzo\"", body["type"].toString())
        assertEquals("\"acc_live_1\"", body["monzoAccountId"].toString())
    }

    @Test
    fun `archiving an account hides it from the list but keeps it cached`() = runTest {
        repo.reconcile()
        repo.upsertAccount(isa.copy(archived = true))
        assertTrue(MoneyAccounts.grouped(repo.state.value.accounts).flatMap { it.second }.none { it.id == "acc_isa" })
        assertTrue(repo.state.value.accounts.any { it.id == "acc_isa" })
        outbox.drain()
        assertEquals("true", bodyOf(writes("POST", "/finance/accounts").single())["archived"].toString())
    }

    // ---- delete ----------------------------------------------------------

    @Test
    fun `deleting an account drops it now, DELETEs it, then refreshes the projection`() = runTest {
        repo.reconcile()
        repo.deleteAccount(isa)
        assertTrue(repo.state.value.accounts.none { it.id == "acc_isa" })

        hubAccounts = """[{"id":"acc_monzo","name":"Monzo","type":"monzo","liquidity":"liquid","sort":0}]"""
        outbox.drain()

        assertEquals(1, writes("DELETE", "/finance/accounts/acc_isa").size)
        assertEquals(listOf("acc_monzo"), repo.state.value.accounts.map { it.id })
        // Liquidity and growth are projection inputs, so the runway is refetched after the write.
        assertEquals(2, writes("GET", "/finance/projection").size)
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test
    fun `a delete the hub has already applied is still done`() = runTest {
        repo.reconcile()
        writeCode = 404
        repo.deleteAccount(isa)
        hubAccounts = """[{"id":"acc_monzo","name":"Monzo","type":"monzo","liquidity":"liquid","sort":0}]"""
        outbox.drain()
        assertTrue(db.outbox().pending().isEmpty())
        assertTrue(repo.state.value.accounts.none { it.id == "acc_isa" })
    }

    @Test
    fun `deleting an account whose create is still queued drops the create and sends one DELETE`() = runTest {
        repo.reconcile()
        val a = MoneyAccounts.toAccount(MoneyAccounts.Draft(name = "Oops"), null)
        repo.upsertAccount(a)
        repo.deleteAccount(a)
        assertTrue(repo.state.value.accounts.none { it.id == a.id })
        writeCode = 404 // the hub never had it
        outbox.drain()
        assertTrue(writes("POST", "/finance/accounts").isEmpty())
        assertEquals(1, writes("DELETE", "/finance/accounts/${a.id}").size)
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a Monzo account is refused before anything is queued`() = runTest {
        repo.reconcile()
        repo.deleteAccount(monzo)
    }

    // ---- heals + guards --------------------------------------------------

    @Test
    fun `a rejected create drops the row it added and a rejected edit restores the old record`() = runTest {
        repo.reconcile()
        writeCode = 400
        repo.upsertAccount(MoneyAccounts.toAccount(MoneyAccounts.Draft(name = "Nope"), null, "acc_nope"))
        repo.upsertAccount(isa.copy(name = "Renamed", growthPctYoy = null))
        assertEquals(4, repo.state.value.accounts.size)
        outbox.drain()

        assertEquals(3, repo.state.value.accounts.size)
        assertEquals("Vanguard ISA", isa.name)
        assertEquals(6.5, isa.growthPctYoy!!, 1e-9)
        assertEquals(1, isa.ledger.size) // the heal put the readings back too
    }

    @Test
    fun `a refused delete puts the account back with its ledger`() = runTest {
        repo.reconcile()
        writeCode = 400
        repo.deleteAccount(isa)
        assertTrue(repo.state.value.accounts.none { it.id == "acc_isa" })
        outbox.drain()
        assertEquals("Vanguard ISA", isa.name)
        assertEquals(1, isa.ledger.size)
    }

    @Test
    fun `being offline keeps the write pending instead of failing it`() = runTest {
        repo.reconcile()
        repo.upsertAccount(isa.copy(name = "ISA"))
        offline = true
        outbox.drain()
        offline = false
        // NotReady: the row is back to pending with its retry budget intact, and the edit still stands.
        assertEquals(1, db.outbox().pending().count { it.type == MoneyRepository.TYPE_ACCOUNT })
        assertEquals("ISA", isa.name)

        hubAccounts = hubAccounts.replace("\"name\":\"Vanguard ISA\"", "\"name\":\"ISA\"")
        outbox.drain()
        assertTrue(db.outbox().pending().isEmpty())
        assertEquals("ISA", isa.name)
    }

    @Test
    fun `a reconcile does not undo a queued rename or resurrect a queued delete`() = runTest {
        repo.reconcile()
        repo.upsertAccount(isa.copy(name = "ISA (Vanguard)"))
        repo.deleteAccount(repo.state.value.accounts.first { it.id == "acc_old" })
        repo.reconcile() // the hub still serves its pre-edit copies

        val s = repo.state.value
        assertEquals("ISA (Vanguard)", s.accounts.first { it.id == "acc_isa" }.name)
        assertEquals(1, s.accounts.first { it.id == "acc_isa" }.ledger.size) // the hub's readings, not ours
        assertTrue(s.accounts.none { it.id == "acc_old" })
    }

    @Test
    fun `once the write lands the hub's copy wins - the settled row is not kept as an overlay`() = runTest {
        repo.reconcile()
        repo.upsertAccount(isa.copy(name = "ISA"))
        // The hub takes the write AND normalises the name on its side.
        hubAccounts = hubAccounts.replace("\"name\":\"Vanguard ISA\"", "\"name\":\"ISA (hub)\"")
        outbox.drain()
        assertEquals("ISA (hub)", isa.name)
    }

    @Test
    fun `a later edit still overlays while its own row waits`() = runTest {
        repo.reconcile()
        offline = true
        repo.upsertAccount(isa.copy(name = "First"))
        repo.upsertAccount(isa.copy(name = "Second"))
        outbox.drain()
        offline = false
        repo.reconcile()
        assertEquals("Second", isa.name)
    }
}
