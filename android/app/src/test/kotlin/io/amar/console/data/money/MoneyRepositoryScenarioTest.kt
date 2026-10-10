package io.amar.console.data.money

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
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
 * `money:scenario` end to end over a scripted hub (responses by PATH, never
 * FIFO): the optimistic write, the request shape, the per-scenario projection
 * lines, the heal and the reconcile guards — plus the read-only shared tabs.
 */
@RunWith(RobolectricTestRunner::class)
class MoneyRepositoryScenarioTest {

    private lateinit var db: ConsoleDb
    private lateinit var outbox: Outbox
    private lateinit var repo: MoneyRepository

    private val seen = mutableListOf<Pair<String, String>>()
    private var writeCode = 200
    private var offline = false
    private var baselineEnd = 3000
    private var sharedTab = """[{"counterparty":"Veronica","theyOwePence":12000,"theyPaidPence":4500,"netOwedToYouPence":7500}]"""

    private var hubScenarios = """[
        {"id":"scn_quit","name":"Quit in June","description":"no salary","horizonMonths":36,"createdAt":"c","updatedAt":"u",
         "deltas":[{"kind":"terminateStream","streamId":"str_salary","date":"2027-06-30"},
                   {"kind":"modifyStream","streamId":"str_rent","patch":{"amountPence":150000,"dayOfMonth":3}}]},
        {"id":"scn_raise","name":"Raise","deltas":[]}]"""

    private fun trajectory(scenario: String?): String {
        val end = when (scenario) { null -> baselineEnd; "scn_quit" -> -500; "scn_raise" -> 9000; else -> baselineEnd }
        return """{"emergencyFundPence":1000,"runway":{},"trajectory":[
            {"month":"2026-10","liquidPence":5000},{"month":"2026-11","liquidPence":$end}]}"""
    }

    private val hub = HubClient(
        OkHttpClient.Builder().addInterceptor { chain ->
            val req = chain.request()
            val path = req.url.encodedPath
            val body = req.body?.let { b -> okio.Buffer().also { b.writeTo(it) }.readUtf8() } ?: ""
            val q = req.url.queryParameter("scenario")
            seen += "${req.method} $path${q?.let { "?scenario=$it" } ?: ""}" to body
            if (offline) throw java.io.IOException("offline")
            val (code, text) = when {
                req.method != "GET" -> writeCode to (if (writeCode == 200) """{"ok":true}""" else """{"error":"x"}""")
                path.endsWith("/finance/all") -> 200 to """{"categories":[],"rules":[],"budgets":[],"accounts":[],
                    "streams":[{"id":"str_salary","name":"Salary","kind":"income","amountPence":500000},
                               {"id":"str_rent","name":"Rent","kind":"expense","amountPence":120000}],
                    "scenarios":$hubScenarios}"""
                path.endsWith("/finance/scenarios") -> 200 to hubScenarios
                path.endsWith("/finance/projection") -> 200 to trajectory(q)
                path.endsWith("/finance/shared-tab") -> 200 to sharedTab
                path.endsWith("/finance/networth/history") -> 200 to "[]"
                path.endsWith("/finance/networth") -> 200 to """{"byAccount":[]}"""
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

    private fun calls(method: String, suffix: String) =
        seen.filter { it.first.startsWith(method) && it.first.endsWith(suffix) }

    private fun bodyOf(req: Pair<String, String>) = MoneyJson.json.parseToJsonElement(req.second).jsonObject

    private val s get() = repo.state.value
    private val quit get() = s.scenarios.first { it.id == "scn_quit" }

    // ---- reconcile -------------------------------------------------------

    @Test
    fun `reconcile reads scenarios, streams, the baseline line, one line per scenario and the shared tabs`() = runTest {
        repo.reconcile()
        assertNull(s.error)
        assertEquals(listOf("scn_quit", "scn_raise"), s.scenarios.map { it.id })
        assertEquals(listOf("Salary", "Rent"), s.streams.map { it.name })
        assertEquals(listOf(5000L, 3000L), s.trajectory.map { it.liquidPence })
        assertEquals(-500L, s.scenarioOverlays["scn_quit"]!!.last().liquidPence)
        assertEquals(9000L, s.scenarioOverlays["scn_raise"]!!.last().liquidPence)
        assertEquals("owes you £75.00", s.sharedTabs.single().summary)

        val c = s.comparison
        assertEquals(listOf("baseline", "scn_quit", "scn_raise"), c.series.map { it.id })
        assertEquals(1000L, c.emergencyPence)
        assertEquals(-500L, c.minPence)
    }

    @Test
    fun `everything survives a restart through the meta cache`() = runTest {
        repo.reconcile()
        val fresh = MoneyRepository(db, hub, outbox)
        fresh.hydrate()
        val f = fresh.state.value
        assertEquals(s.scenarios, f.scenarios)
        assertEquals(s.streams, f.streams)
        assertEquals(s.trajectory, f.trajectory)
        assertEquals(s.scenarioOverlays, f.scenarioOverlays)
        assertEquals(s.sharedTabs, f.sharedTabs)
    }

    @Test
    fun `a hub without the shared-tab route or an error page keeps the cached tabs and raises no error`() = runTest {
        repo.reconcile()
        sharedTab = "<html>502</html>"
        repo.reconcile()
        assertEquals(1, s.sharedTabs.size)
        assertNull(s.error)
        sharedTab = "[]"
        repo.reconcile()
        assertTrue(s.sharedTabs.isEmpty())
    }

    @Test
    fun `offline, the cached lines stand`() = runTest {
        repo.reconcile()
        offline = true
        repo.reconcile()
        assertEquals(2, s.scenarioOverlays.size)
        assertEquals(2, s.scenarios.size)
        assertEquals(2, s.trajectory.size)
    }

    @Test
    fun `lines are refetched only when the baseline moved, a line is missing, or the desktop changed the deltas`() = runTest {
        repo.reconcile()
        assertEquals(2, calls("GET", "/finance/projection?scenario=scn_quit").size + calls("GET", "/finance/projection?scenario=scn_raise").size)
        repo.reconcile() // nothing moved: no scenario projection is fetched again
        assertEquals(1, calls("GET", "/finance/projection?scenario=scn_quit").size)
        assertEquals(1, calls("GET", "/finance/projection?scenario=scn_raise").size)

        // Edited on the desktop: only that scenario's line is redrawn.
        hubScenarios = hubScenarios.replace("\"date\":\"2027-06-30\"", "\"date\":\"2027-03-31\"")
        repo.reconcile()
        assertEquals(2, calls("GET", "/finance/projection?scenario=scn_quit").size)
        assertEquals(1, calls("GET", "/finance/projection?scenario=scn_raise").size)

        // The baseline moved: every line is redrawn.
        baselineEnd = 2500
        repo.reconcile()
        assertEquals(3, calls("GET", "/finance/projection?scenario=scn_quit").size)
        assertEquals(2, calls("GET", "/finance/projection?scenario=scn_raise").size)
    }

    // ---- create ----------------------------------------------------------

    @Test
    fun `a new scenario shows at once under its minted id, posts that id, then gets its line`() = runTest {
        repo.reconcile()
        val n = MoneyScenarios.toScenario(
            MoneyScenarios.Draft("Windfall", "", listOf(MoneyScenarios.newOneOff("2026-11-01"))), null, "scn_new",
        )
        repo.upsertScenario(n)
        assertTrue(s.scenarios.any { it.id == "scn_new" })
        assertNull(s.scenarioOverlays["scn_new"])

        hubScenarios = hubScenarios.trimEnd(']') +
            """,{"id":"scn_new","name":"Windfall","createdAt":"hub","updatedAt":"hub","deltas":[{"kind":"oneOff","date":"2026-11-01","amountPence":0,"note":""}]}]"""
        outbox.drain()

        val post = calls("POST", "/finance/scenarios").single()
        assertEquals(setOf("id", "name", "deltas"), bodyOf(post).keys)
        assertEquals("\"scn_new\"", bodyOf(post)["id"].toString())
        assertEquals(1, bodyOf(post)["deltas"]!!.jsonArray.size)
        assertEquals("hub", s.scenarios.first { it.id == "scn_new" }.createdAt) // the hub's copy replaced ours
        assertEquals(1, calls("GET", "/finance/projection?scenario=scn_new").size)
        assertEquals(2, s.scenarioOverlays["scn_new"]!!.size)
        assertTrue(db.outbox().pending().isEmpty())
        assertEquals(0, db.outbox().inFlightEntityIds(MoneyRepository.TYPE_SCENARIO).size)
    }

    @Test
    fun `while a create is queued a reconcile neither drops it nor draws the baseline as its line`() = runTest {
        repo.reconcile()
        repo.upsertScenario(Scenario("scn_new", "Windfall"))
        repo.reconcile() // the hub does not know scn_new: it would answer with the baseline
        assertTrue(s.scenarios.any { it.id == "scn_new" })
        assertTrue(calls("GET", "/finance/projection?scenario=scn_new").isEmpty())
        assertNull(s.scenarioOverlays["scn_new"])
    }

    // ---- edit ------------------------------------------------------------

    @Test
    fun `an edit posts the record with the cleared description as null and every delta as held`() = runTest {
        repo.reconcile()
        val edited = MoneyScenarios.toScenario(MoneyScenarios.draftOf(quit).copy(name = "Quit", description = ""), quit)
        repo.upsertScenario(edited)
        assertEquals("Quit", quit.name)
        // Same deltas: the line it had is still the right one.
        assertEquals(2, s.scenarioOverlays["scn_quit"]!!.size)

        hubScenarios = hubScenarios.replace("\"name\":\"Quit in June\",\"description\":\"no salary\",", "\"name\":\"Quit\",")
        outbox.drain()

        val body = bodyOf(calls("POST", "/finance/scenarios").single())
        assertEquals(setOf("id", "name", "description", "deltas"), body.keys)
        assertEquals(JsonNull, body["description"])
        assertEquals("3", body["deltas"]!!.jsonArray[1].jsonObject["patch"]!!.jsonObject["dayOfMonth"].toString())
        assertEquals("Quit", quit.name)
        assertNull(quit.description)
        assertEquals(36, quit.horizonMonths)
    }

    @Test
    fun `changing the deltas drops the stale line until the write lands and the new one is fetched`() = runTest {
        repo.reconcile()
        offline = true
        repo.upsertScenario(quit.copy(deltas = quit.deltas.take(1)))
        assertNull(s.scenarioOverlays["scn_quit"])
        outbox.drain()
        repo.reconcile()
        assertNull(s.scenarioOverlays["scn_quit"]) // still queued: the hub's line is for the OLD deltas
        assertEquals(1, quit.deltas.size)

        offline = false
        hubScenarios = hubScenarios.replace(""",
                   {"kind":"modifyStream","streamId":"str_rent","patch":{"amountPence":150000,"dayOfMonth":3}}""", "")
        outbox.drain()
        assertEquals(-500L, s.scenarioOverlays["scn_quit"]!!.last().liquidPence)
        assertTrue(db.outbox().pending().isEmpty())
    }

    // ---- delete ----------------------------------------------------------

    @Test
    fun `deleting drops the scenario and its line now, then DELETEs it`() = runTest {
        repo.reconcile()
        repo.deleteScenario(quit)
        assertEquals(listOf("scn_raise"), s.scenarios.map { it.id })
        assertFalse(s.scenarioOverlays.containsKey("scn_quit"))

        hubScenarios = """[{"id":"scn_raise","name":"Raise","deltas":[]}]"""
        outbox.drain()
        assertEquals(1, calls("DELETE", "/finance/scenarios/scn_quit").size)
        assertEquals(listOf("scn_raise"), s.scenarios.map { it.id })
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test
    fun `a delete the hub has already applied is still done`() = runTest {
        repo.reconcile()
        writeCode = 404
        repo.deleteScenario(quit)
        hubScenarios = """[{"id":"scn_raise","name":"Raise","deltas":[]}]"""
        outbox.drain()
        assertTrue(db.outbox().pending().isEmpty())
        assertEquals(0, db.outbox().inFlightEntityIds(MoneyRepository.TYPE_SCENARIO).size)
        assertEquals(listOf("scn_raise"), s.scenarios.map { it.id })
    }

    @Test
    fun `deleting a scenario whose create is still queued drops the create and sends one DELETE`() = runTest {
        repo.reconcile()
        val n = Scenario("scn_oops", "Oops")
        repo.upsertScenario(n)
        repo.deleteScenario(n)
        writeCode = 404 // the hub never had it
        outbox.drain()
        assertTrue(calls("POST", "/finance/scenarios").isEmpty())
        assertEquals(1, calls("DELETE", "/finance/scenarios/scn_oops").size)
        assertTrue(db.outbox().pending().isEmpty())
        assertTrue(s.scenarios.none { it.id == "scn_oops" })
    }

    @Test
    fun `a reconcile does not undo a queued rename or resurrect a queued delete`() = runTest {
        repo.reconcile()
        offline = true
        repo.upsertScenario(quit.copy(name = "Renamed"))
        repo.deleteScenario(s.scenarios.first { it.id == "scn_raise" })
        offline = false
        repo.reconcile() // the hub still serves its pre-edit copies
        assertEquals(listOf("Renamed"), s.scenarios.map { it.name })
        assertFalse(s.scenarioOverlays.containsKey("scn_raise"))
    }

    // ---- heals + guards --------------------------------------------------

    @Test
    fun `a rejected create drops its row, a rejected edit restores the record, a refused delete puts it back`() = runTest {
        repo.reconcile()
        writeCode = 400
        repo.upsertScenario(Scenario("scn_nope", "Nope"))
        repo.upsertScenario(quit.copy(name = "Renamed"))
        repo.deleteScenario(s.scenarios.first { it.id == "scn_raise" })
        assertEquals(listOf("Renamed", "Nope"), s.scenarios.map { it.name })
        outbox.drain()

        assertEquals(setOf("Quit in June", "Raise"), s.scenarios.map { it.name }.toSet())
        assertEquals(2, quit.deltas.size)
        assertEquals(0, db.outbox().pending().size)
    }

    @Test
    fun `being offline keeps the write pending instead of failing it`() = runTest {
        repo.reconcile()
        repo.upsertScenario(quit.copy(name = "Quit"))
        offline = true
        outbox.drain()
        offline = false
        assertEquals(1, db.outbox().pending().count { it.type == MoneyRepository.TYPE_SCENARIO })
        assertEquals("Quit", quit.name)

        hubScenarios = hubScenarios.replace("\"name\":\"Quit in June\"", "\"name\":\"Quit\"")
        outbox.drain()
        assertTrue(db.outbox().pending().isEmpty())
        assertEquals("Quit", quit.name)
    }

    @Test
    fun `once the write lands the hub's copy wins - the settled row is not kept as an overlay`() = runTest {
        repo.reconcile()
        repo.upsertScenario(quit.copy(name = "Quit"))
        hubScenarios = hubScenarios.replace("\"name\":\"Quit in June\"", "\"name\":\"Quit (hub)\"")
        outbox.drain()
        assertEquals("Quit (hub)", quit.name)
    }

    @Test
    fun `a later edit still overlays while its own row waits`() = runTest {
        repo.reconcile()
        offline = true
        repo.upsertScenario(quit.copy(name = "First"))
        repo.upsertScenario(quit.copy(name = "Second"))
        outbox.drain()
        offline = false
        repo.reconcile()
        assertEquals("Second", quit.name)
    }
}
