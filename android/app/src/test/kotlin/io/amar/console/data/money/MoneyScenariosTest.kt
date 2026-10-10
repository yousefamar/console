package io.amar.console.data.money

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure half of `money:scenario` + the shared-tab panel: codecs, delta edits, request shape, overlays, heal, chart. */
class MoneyScenariosTest {

    private val hubJson = """[
      {"id":"scn_quit","name":"Quit in June","description":"no salary","horizonMonths":36,
       "createdAt":"2026-09-01T10:00:00.000Z","updatedAt":"2026-09-02T10:00:00.000Z",
       "deltas":[
         {"kind":"terminateStream","streamId":"str_salary","date":"2027-06-30"},
         {"kind":"modifyStream","streamId":"str_rent","patch":{"amountPence":150000,"dayOfMonth":3,"notes":"new flat"}},
         {"kind":"categoryAdjust","categoryId":"cat_food","multiplier":0.7,"from":"2027-01","until":"2027-12"},
         {"kind":"oneOff","date":"2027-01-15","amountPence":-250000,"note":"car","categoryId":"cat_car"},
         {"kind":"addStream","tempId":"tmp_1","stream":{"name":"Contract","kind":"income","amountPence":800000,"cadence":"monthly","startDate":"2027-09-01","growthPctYoy":3}},
         {"kind":"investmentGrowth","annualPct":7},
         {"kind":"someFutureKind","x":1},
         {"nokind":true}
       ]},
      {"id":"scn_empty","name":"Empty","deltas":[]},
      {"name":"no id"}
    ]"""

    private val scenarios get() = MoneyScenarios.parseScenarios(hubJson)
    private val quit get() = scenarios.first()
    private val streams = listOf(
        StreamRef("str_salary", "Salary", "income", 500000),
        StreamRef("str_rent", "Rent", "expense", 120000),
        StreamRef("str_old", "Old gig", "income", 1000, archived = true),
    )
    private val cats = mapOf("cat_food" to MoneyCategory(id = "cat_food", name = "Food", emoji = "🍔", color = "#fff", kind = "expense"))

    // ---- codec -----------------------------------------------------------

    @Test
    fun `parsing keeps every delta with a kind - unknown kinds included - and skips records with no id`() {
        assertEquals(listOf("scn_quit", "scn_empty"), scenarios.map { it.id })
        assertEquals(7, quit.deltas.size)
        assertEquals("someFutureKind", quit.deltas[6].kind)
        assertEquals(36, quit.horizonMonths)
        assertNull(scenarios[1].description)
    }

    @Test
    fun `the cache round trip is lossless, down to delta fields the phone never edits`() {
        val back = MoneyScenarios.parseScenarios(MoneyScenarios.encodeScenarios(scenarios))
        assertEquals(scenarios, back)
        val patch = back.first().deltas[1].obj("patch")!!
        assertEquals("3", patch["dayOfMonth"].toString())
        assertEquals("\"2027-12\"", back.first().deltas[2].raw["until"].toString())
    }

    @Test
    fun `streams and trajectories round trip through their caches`() {
        val all = MoneyJson.json.parseToJsonElement(
            """{"streams":[{"id":"s1","name":"Salary","kind":"income","amountPence":500000,"cadence":"monthly"},
                {"id":"s2","name":"Gone","kind":"expense","amountPence":1,"archived":true},{"name":"no id"}]}"""
        ).jsonObject
        val parsed = MoneyScenarios.parseStreams(all["streams"])
        assertEquals(listOf("s1", "s2"), parsed.map { it.id })
        assertTrue(parsed[1].archived)
        assertEquals(parsed, MoneyScenarios.decodeStreams(MoneyScenarios.encodeStreams(parsed)))

        val t = MoneyScenarios.parseTrajectory("""{"trajectory":[{"month":"2026-10","liquidPence":1000,"totalPence":5},{"month":"2026-11","liquidPence":-250.9}],"runway":{}}""")
        assertEquals(listOf(TrajectoryPoint("2026-10", 1000), TrajectoryPoint("2026-11", -251)), t)
        assertEquals(t, MoneyScenarios.decodeTrajectory(MoneyScenarios.encodeTrajectory(t)))
        assertEquals(mapOf("a" to t), MoneyScenarios.decodeOverlays(MoneyScenarios.encodeOverlays(mapOf("a" to t))))
        assertTrue(MoneyScenarios.parseTrajectory("""{"runway":{}}""").isEmpty())
        assertTrue(MoneyScenarios.parseTrajectory("<html>").isEmpty())
    }

    @Test
    fun `shared tabs parse, label themselves, and an error page is not an empty list`() {
        val tabs = MoneyScenarios.parseSharedTabs(
            """[{"counterparty":"Veronica","theyOwePence":12000,"theyPaidPence":4500,"netOwedToYouPence":7500,
                 "oldestSharedDate":"2026-08-01","latestSharedDate":"2026-10-01",
                 "sampleShared":[{"id":"tx1","date":"2026-10-01","merchant":"Sainsbury's","grossPence":6000,"theirSharePence":3000}],
                 "sampleReimbursements":[{"id":"tx2","date":"2026-09-20","amountPence":4500,"note":"groceries"}]},
                {"counterparty":"Sam","theyOwePence":0,"theyPaidPence":1000,"netOwedToYouPence":-1000,"oldestSharedDate":null,"latestSharedDate":null,"sampleShared":[],"sampleReimbursements":[]},
                {"counterparty":"Even","theyOwePence":5,"theyPaidPence":5,"netOwedToYouPence":0}]"""
        )!!
        assertEquals("owes you £75.00", tabs[0].summary)
        assertEquals("you owe £10.00", tabs[1].summary)
        assertEquals("settled", tabs[2].summary)
        assertEquals("Sainsbury's", tabs[0].sampleShared.single().merchant)
        assertEquals(4500L, tabs[0].sampleReimbursements.single().amountPence)
        assertNull(tabs[1].oldestSharedDate)
        assertEquals(emptyList<SharedTabBalance>(), MoneyScenarios.parseSharedTabs("[]"))
        assertNull(MoneyScenarios.parseSharedTabs("<html>502</html>"))
        assertNull(MoneyScenarios.parseSharedTabs("""{"error":"x"}"""))
    }

    // ---- deltas ----------------------------------------------------------

    @Test
    fun `editing one key of a delta leaves the rest of it alone, and null removes a key`() {
        val modify = quit.deltas[1]
        val edited = modify.withIn("patch", "amountPence", JsonPrimitive(160000L))
        assertEquals("160000", edited.obj("patch")!!["amountPence"].toString())
        assertEquals("\"new flat\"", edited.obj("patch")!!["notes"].toString())
        assertEquals("str_rent", edited.str("streamId"))

        val cleared = modify.withIn("patch", "amountPence", null)
        assertFalse(cleared.obj("patch")!!.containsKey("amountPence"))
        assertFalse(cleared.raw.toString().contains("null"))

        val adjust = quit.deltas[2].with("multiplier", JsonPrimitive(1.3))
        assertEquals(1.3, adjust.double("multiplier")!!, 1e-9)
        assertEquals("2027-01", adjust.str("from"))
    }

    @Test
    fun `the adders build what the SPA's buttons build`() {
        val one = MoneyScenarios.newOneOff("2026-10-10")
        assertEquals("""{"kind":"oneOff","date":"2026-10-10","amountPence":0,"note":""}""", one.raw.toString())
        assertEquals("""{"kind":"modifyStream","streamId":"s","patch":{}}""", MoneyScenarios.newModifyStream("s").raw.toString())
        assertEquals("""{"kind":"terminateStream","streamId":"s","date":"2026-10-10"}""", MoneyScenarios.newTerminateStream("s", "2026-10-10").raw.toString())
        assertEquals(
            """{"kind":"addStream","tempId":"tmp_x","stream":{"name":"New stream","kind":"income","amountPence":0,"cadence":"monthly","startDate":"2026-10-10"}}""",
            MoneyScenarios.newAddStream("2026-10-10", "tmp_x").raw.toString(),
        )
        assertEquals("""{"kind":"categoryAdjust","categoryId":"c","multiplier":1.0}""", MoneyScenarios.newCategoryAdjust("c").raw.toString())
        assertEquals("""{"kind":"investmentGrowth","annualPct":5.0}""", MoneyScenarios.newInvestmentGrowth().raw.toString())
        assertTrue(MoneyScenarios.newAddStream().str("tempId")!!.matches(Regex("tmp_[0-9a-f]{6}")))
    }

    @Test
    fun `each delta describes itself in one line`() {
        val d = quit.deltas.map { MoneyScenarios.describe(it, streams, cats) }
        assertEquals("End Salary on 2027-06-30", d[0])
        assertEquals("Modify Rent → £1,500", d[1])
        assertEquals("🍔 Food × 0.7", d[2])
        assertEquals("One-off -£2,500 on 2027-01-15 · car", d[3])
        assertEquals("New income Contract £8,000/mo", d[4])
        assertEquals("Investment growth 7%/yr", d[5])
        assertEquals("someFutureKind", d[6])
        assertEquals("End ? on 2027-06-30", MoneyScenarios.describe(quit.deltas[0], emptyList(), cats))
    }

    @Test
    fun `an archived stream is offered only to the delta that already names it`() {
        assertEquals(listOf("str_salary", "str_rent"), MoneyScenarios.pickableStreams(streams).map { it.id })
        assertEquals(3, MoneyScenarios.pickableStreams(streams, "str_old").size)
    }

    @Test
    fun `amount and number fields parse what a thumb types`() {
        assertEquals(-1250L, MoneyScenarios.poundsToSignedPence("-12.50"))
        assertEquals(-1250L, MoneyScenarios.poundsToSignedPence("−12.5"))
        assertEquals(120000L, MoneyScenarios.poundsToSignedPence("£1,200"))
        assertEquals(30000L, MoneyScenarios.poundsToSignedPence("+300"))
        assertNull(MoneyScenarios.poundsToSignedPence(""))
        assertNull(MoneyScenarios.poundsToSignedPence("-"))
        assertNull(MoneyScenarios.poundsToSignedPence("12."+"x"))
        assertEquals("-12.50", MoneyScenarios.penceToText(-1250))
        assertEquals("300", MoneyScenarios.penceToText(30000))
        assertEquals("", MoneyScenarios.penceToText(0))
        assertEquals("", MoneyScenarios.penceToText(null))
        assertEquals(1.3, MoneyScenarios.parseNumber(" 1.3 ")!!, 1e-9)
        assertEquals(5.0, MoneyScenarios.parseNumber("5%")!!, 1e-9)
        assertNull(MoneyScenarios.parseNumber("abc"))
        assertEquals("5", MoneyScenarios.formatNumber(5.0))
        assertEquals("0.7", MoneyScenarios.formatNumber(0.7))
        assertEquals("0", MoneyScenarios.formatNumber(0.0))
    }

    // ---- draft + requests ------------------------------------------------

    @Test
    fun `a new scenario gets a hub-shaped id and an edit keeps what the phone does not edit`() {
        assertTrue(MoneyScenarios.mintScenarioId().matches(Regex("scn_[0-9a-f]{8}")))
        assertEquals("Name it first", MoneyScenarios.validate(MoneyScenarios.Draft(name = "  ")))
        assertNull(MoneyScenarios.validate(MoneyScenarios.draftOf(null)))

        val created = MoneyScenarios.toScenario(MoneyScenarios.Draft(" Raise ", " ", emptyList()), null, "scn_new")
        assertEquals(Scenario("scn_new", "Raise"), created)

        val edited = MoneyScenarios.toScenario(MoneyScenarios.draftOf(quit).copy(name = "Quit", description = ""), quit)
        assertEquals("scn_quit", edited.id)
        assertNull(edited.description)
        assertEquals(36, edited.horizonMonths)
        assertEquals(quit.createdAt, edited.createdAt)
        assertEquals(quit.deltas, edited.deltas)
    }

    @Test
    fun `a create omits an empty description, an edit sends it as null, and neither sends horizon or timestamps`() {
        val create = MoneyJson.json.parseToJsonElement(MoneyScenarios.scenarioBody(Scenario("scn_a", "A"), isEdit = false)).jsonObject
        assertEquals(setOf("id", "name", "deltas"), create.keys)

        val edit = MoneyJson.json.parseToJsonElement(MoneyScenarios.scenarioBody(quit.copy(description = null), isEdit = true)).jsonObject
        assertEquals(setOf("id", "name", "description", "deltas"), edit.keys)
        assertEquals(JsonNull, edit["description"])
        // Deltas go exactly as held, the untouched ones byte for byte.
        assertEquals(quit.deltas.map { it.raw }, edit["deltas"]!!.jsonArray.map { it.jsonObject })

        val kept = MoneyJson.json.parseToJsonElement(MoneyScenarios.scenarioBody(quit, isEdit = true)).jsonObject
        assertEquals("\"no salary\"", kept["description"].toString())
    }

    @Test
    fun `a clone is a new scenario with the same deltas`() {
        val c = MoneyScenarios.cloneOf(quit, "scn_copy")
        assertEquals("Quit in June (copy)", c.name)
        assertEquals(quit.deltas, c.deltas)
        assertEquals("no salary", c.description)
        assertNull(c.horizonMonths)
        assertNull(c.createdAt)
    }

    @Test
    fun `paths encode the id`() {
        assertEquals("/finance/scenarios/scn_a", MoneyScenarios.path("scn_a"))
        assertEquals("/finance/projection?scenario=a%2Fb", MoneyScenarios.projectionPath("a/b"))
    }

    // ---- overlays + heal -------------------------------------------------

    @Test
    fun `queued edits lie over the hub's list - an edit wins, a delete stays gone, a create is appended`() {
        val hub = scenarios
        val local = listOf(quit.copy(name = "Renamed"), Scenario("scn_new", "Fresh")) // scn_empty deleted locally
        val out = MoneyScenarios.withInFlight(hub, local, setOf("scn_quit", "scn_empty", "scn_new"))
        assertEquals(listOf("Renamed", "Fresh"), out.map { it.name })
        // Nothing in flight: the hub's list as is.
        assertEquals(hub, MoneyScenarios.withInFlight(hub, local, emptySet()))
        // Only the create in flight: hub rows untouched, the create kept.
        assertEquals(listOf("Quit in June", "Empty", "Fresh"), MoneyScenarios.withInFlight(hub, local, setOf("scn_new")).map { it.name })
    }

    @Test
    fun `the outbox payload round trips and heals each kind of failed write`() {
        val edit = MoneyScenarios.Action("scn_quit", MoneyScenarios.scenarioBody(quit.copy(name = "X"), true), quit)
        assertEquals(edit, MoneyScenarios.decodeAction(MoneyScenarios.encodeAction(edit)))
        val del = MoneyScenarios.Action("scn_quit", null, quit)
        assertEquals(del, MoneyScenarios.decodeAction(MoneyScenarios.encodeAction(del)))
        val create = MoneyScenarios.Action("scn_new", "{}", null)
        assertEquals(create, MoneyScenarios.decodeAction(MoneyScenarios.encodeAction(create)))
        assertNull(MoneyScenarios.decodeAction("not json"))

        // A refused edit: the old record back, in its old place.
        val afterEdit = MoneyScenarios.healed(listOf(quit.copy(name = "X"), scenarios[1]), edit)
        assertEquals(scenarios, afterEdit)
        // A refused delete: the record is back.
        assertEquals(listOf(scenarios[1], quit), MoneyScenarios.healed(listOf(scenarios[1]), del))
        // A refused create: the row goes.
        assertEquals(scenarios, MoneyScenarios.healed(scenarios + Scenario("scn_new", "Fresh"), create))
    }

    // ---- chart -----------------------------------------------------------

    @Test
    fun `the comparison joins scenarios to the baseline's months and keeps the floor in range`() {
        val base = listOf(TrajectoryPoint("2026-10", 5000), TrajectoryPoint("2026-11", 4000), TrajectoryPoint("2026-12", 3000))
        val overlays = mapOf("scn_quit" to listOf(TrajectoryPoint("2026-10", 5000), TrajectoryPoint("2026-11", -200)))
        val c = MoneyScenarios.comparison(base, overlays, scenarios, emergencyPence = 9000)
        assertEquals(listOf("2026-10", "2026-11", "2026-12"), c.months)
        assertEquals(listOf("baseline", "scn_quit", "scn_empty"), c.series.map { it.id })
        assertEquals(listOf<Long?>(5000, -200, null), c.series[1].values) // shorter trajectory = a gap, not a zero
        assertEquals(listOf<Long?>(null, null, null), c.series[2].values) // no line yet
        assertEquals(-200L, c.series[1].last)
        assertNull(c.series[2].last)
        assertEquals(-200L, c.minPence)
        assertEquals(9000L, c.maxPence) // the emergency floor is above every line and still on the chart
        assertEquals(MoneyScenarios.COLORS[0], c.series[0].color)
        assertEquals(MoneyScenarios.COLORS[1], c.series[1].color)
        assertEquals(MoneyScenarios.COLORS[0], MoneyScenarios.colorFor(6)) // wraps like the SPA's modulo

        assertTrue(MoneyScenarios.comparison(emptyList(), overlays, scenarios, 0).isEmpty)
    }

    @Test
    fun `row labels`() {
        assertEquals("@ Nov 26 → -£2.00", MoneyScenarios.endLabel(listOf(TrajectoryPoint("2026-10", 5000), TrajectoryPoint("2026-11", -200))))
        assertNull(MoneyScenarios.endLabel(null))
        assertNull(MoneyScenarios.endLabel(emptyList()))
        assertEquals("7 deltas", MoneyScenarios.deltaCount(quit))
        assertEquals("1 delta", MoneyScenarios.deltaCount(Scenario("a", "A", deltas = listOf(MoneyScenarios.newOneOff()))))
    }
}
