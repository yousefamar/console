package io.amar.console.data.money

import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of the SPA `NetWorthView.tsx` account editor + the `money:account` outbox contract. */
class MoneyAccountsCrudTest {

    private val reading = BalanceEntry("bal_1", "2026-09-30", 123456, "statement")
    private val monzo = Account("acc_monzo", "Monzo", "monzo", "liquid", monzoAccountId = "acc_live_123", sort = 0)
    private val isa = Account(
        "acc_isa", "Vanguard ISA", "manual", "investment",
        emoji = "📈", growthPctYoy = 6.5, sort = 1, ledger = listOf(reading),
    )
    private val house = Account("acc_house", "House", "manual", "illiquid", isExternal = true, sort = 2)
    private val old = Account("acc_old", "Closed", "manual", "liquid", archived = true, sort = 3)

    private val all = listOf(monzo, isa, house, old)

    // ---- ids + grouping --------------------------------------------------

    @Test
    fun `a minted id takes the hub's own shape so the hub stores it verbatim`() {
        assertEquals("acc_0123abcd", MoneyAccounts.mintAccountId("0123abcd-ef01-2345-6789-abcdef012345"))
        assertTrue(MoneyAccounts.mintAccountId().matches(Regex("acc_[0-9a-f]{8}")))
    }

    @Test
    fun `grouped follows the SPA order, hides archived, and drops empty groups`() {
        val groups = MoneyAccounts.grouped(all)
        assertEquals(listOf("Liquid", "Investments", "Illiquid / external"), groups.map { it.first })
        assertEquals(listOf("acc_monzo"), groups[0].second.map { it.id }) // acc_old is archived
        assertEquals(listOf("acc_isa"), groups[1].second.map { it.id })
        assertEquals(listOf("acc_house"), groups[2].second.map { it.id })

        assertEquals(listOf("acc_monzo", "acc_old"), MoneyAccounts.grouped(all, showArchived = true)[0].second.map { it.id })
        assertTrue(MoneyAccounts.grouped(listOf(isa)).map { it.first } == listOf("Investments"))
    }

    @Test
    fun `grouped sorts by the hub's sort then by name, with unsorted rows last`() {
        val b = Account("acc_b", "Barclays", "manual", "liquid", sort = 9)
        val a = Account("acc_a", "Amex", "manual", "liquid", sort = 9)
        val none = Account("acc_n", "Aardvark", "manual", "liquid")
        val rows = MoneyAccounts.grouped(listOf(none, b, a))[0].second
        assertEquals(listOf("acc_a", "acc_b", "acc_n"), rows.map { it.id })
    }

    @Test
    fun `a Monzo account is not deletable from the phone - its link is the desktop's`() {
        assertFalse(MoneyAccounts.canDelete(monzo))
        assertTrue(MoneyAccounts.canDelete(isa))
    }

    // ---- the draft -------------------------------------------------------

    @Test
    fun `draftOf round-trips an account and a new draft starts liquid and empty`() {
        val d = MoneyAccounts.draftOf(isa)
        assertEquals("Vanguard ISA", d.name)
        assertEquals("investment", d.liquidity)
        assertEquals("📈", d.emoji)
        assertEquals("6.5", d.growth)
        assertFalse(d.isExternal)

        val fresh = MoneyAccounts.draftOf(null)
        assertEquals("", fresh.name)
        assertEquals(MoneyAccounts.LIQUID, fresh.liquidity)
        assertEquals("", fresh.growth)
    }

    @Test
    fun `validate refuses a blank name, an unknown liquidity and junk growth`() {
        assertEquals("Name it first", MoneyAccounts.validate(MoneyAccounts.Draft(name = "  ")))
        assertEquals("Pick a liquidity", MoneyAccounts.validate(MoneyAccounts.Draft(name = "X", liquidity = "cash")))
        assertTrue(MoneyAccounts.validate(MoneyAccounts.Draft(name = "X", growth = "lots"))!!.startsWith("Growth"))
        assertNull(MoneyAccounts.validate(MoneyAccounts.Draft(name = "X")))
        assertNull(MoneyAccounts.validate(MoneyAccounts.Draft(name = "X", growth = " 3.25 ")))
    }

    @Test
    fun `toAccount carries through everything the phone must never redefine`() {
        val edited = MoneyAccounts.toAccount(
            MoneyAccounts.draftOf(monzo).copy(name = "Monzo current", liquidity = MoneyAccounts.ILLIQUID),
            existing = monzo,
        )
        assertEquals("acc_monzo", edited.id)
        assertEquals("Monzo current", edited.name)
        assertEquals("illiquid", edited.liquidity)
        assertEquals("monzo", edited.type)                 // never converted
        assertEquals("acc_live_123", edited.monzoAccountId) // never unlinked
        assertEquals(monzo.sort, edited.sort)

        val keepsLedger = MoneyAccounts.toAccount(MoneyAccounts.draftOf(isa).copy(name = "ISA"), existing = isa)
        assertEquals(listOf(reading), keepsLedger.ledger)
    }

    @Test
    fun `a created account is manual, unsorted, and carries the typed growth`() {
        val a = MoneyAccounts.toAccount(
            MoneyAccounts.Draft(name = " Chase saver ", liquidity = MoneyAccounts.LIQUID, growth = "3.25", emoji = " "),
            existing = null,
            id = "acc_new",
        )
        assertEquals("acc_new", a.id)
        assertEquals("Chase saver", a.name)
        assertEquals("manual", a.type)
        assertNull(a.sort)            // the hub appends it
        assertNull(a.emoji)           // blank is unset, not " "
        assertEquals(3.25, a.growthPctYoy!!, 1e-9)
        assertTrue(a.ledger.isEmpty())
        assertFalse(a.archived)
    }

    // ---- growth ----------------------------------------------------------

    @Test
    fun `growth parses blank as unset - which is meaningful - and tolerates a percent sign`() {
        assertNull(MoneyAccounts.parseGrowth(""))
        assertNull(MoneyAccounts.parseGrowth("   "))
        assertEquals(6.5, MoneyAccounts.parseGrowth(" 6.5 % ")!!, 1e-9)
        assertEquals(0.0, MoneyAccounts.parseGrowth("0")!!, 1e-9)
        assertNull(MoneyAccounts.parseGrowth("six"))
        assertTrue(MoneyAccounts.growthValid(""))
        assertTrue(MoneyAccounts.growthValid("3.25%"))
        assertFalse(MoneyAccounts.growthValid("3.2.5"))
        assertEquals("6.5", MoneyAccounts.formatGrowth(6.5))
        assertEquals("6", MoneyAccounts.formatGrowth(6.0))
        assertEquals("0", MoneyAccounts.formatGrowth(0.0))
    }

    @Test
    fun `growthSummary says what the projection will actually assume`() {
        assertEquals("6.5% a year", MoneyAccounts.growthSummary(isa))
        assertEquals("growth: the global investment rate", MoneyAccounts.growthSummary(isa.copy(growthPctYoy = null)))
        assertEquals("no growth", MoneyAccounts.growthSummary(monzo))
    }

    // ---- write bodies ----------------------------------------------------

    @Test
    fun `an edit sends the cleared optionals as explicit nulls - omitting them would keep the old value`() {
        val cleared = isa.copy(emoji = null, growthPctYoy = null, notes = null)
        val o = MoneyJson.json.parseToJsonElement(MoneyAccounts.accountBody(cleared, isEdit = true)).jsonObject
        assertEquals("null", o["emoji"].toString())
        assertEquals("null", o["growthPctYoy"].toString())
        assertEquals("null", o["notes"].toString())
        assertEquals("null", o["color"].toString())
        assertEquals("null", o["monzoAccountId"].toString())
    }

    @Test
    fun `a create leaves the empty optionals out entirely`() {
        val fresh = MoneyAccounts.toAccount(MoneyAccounts.Draft(name = "Chase"), null, "acc_new")
        val o = MoneyJson.json.parseToJsonElement(MoneyAccounts.accountBody(fresh, isEdit = false)).jsonObject
        assertFalse(o.containsKey("emoji"))
        assertFalse(o.containsKey("growthPctYoy"))
        assertFalse(o.containsKey("notes"))
        assertEquals("\"acc_new\"", o["id"].toString())
    }

    @Test
    fun `no write body ever carries a ledger - the hub's Object-assign would overwrite its balance history`() {
        for (isEdit in listOf(true, false)) {
            val o = MoneyJson.json.parseToJsonElement(MoneyAccounts.accountBody(isa, isEdit)).jsonObject
            assertFalse("isEdit=$isEdit", o.containsKey("ledger"))
        }
        // The local cache encoder still keeps it.
        assertTrue(MoneyJson.accountJson(isa).containsKey("ledger"))
    }

    @Test
    fun `the booleans are always sent so unticking held-externally reaches the hub`() {
        val o = MoneyJson.json.parseToJsonElement(MoneyAccounts.accountBody(house.copy(isExternal = false), isEdit = true)).jsonObject
        assertEquals("false", o["isExternal"].toString())
        assertEquals("false", o["archived"].toString())
    }

    @Test
    fun `a create carrying growth needs the follow-up PATCH the hub's create branch drops`() {
        val withGrowth = MoneyAccounts.toAccount(MoneyAccounts.Draft(name = "ISA", growth = "6.5"), null, "acc_new")
        assertTrue(MoneyAccounts.needsPatch(withGrowth, isEdit = false))
        assertFalse(MoneyAccounts.needsPatch(withGrowth, isEdit = true))  // the edit path applies it itself
        assertFalse(MoneyAccounts.needsPatch(MoneyAccounts.toAccount(MoneyAccounts.Draft(name = "Plain"), null), false))

        val patch = MoneyJson.json.parseToJsonElement(MoneyAccounts.patchBody(withGrowth)).jsonObject
        assertEquals("6.5", patch["growthPctYoy"].toString())
        assertEquals("false", patch["archived"].toString())
    }

    @Test
    fun `path encodes the id`() {
        assertEquals("/finance/accounts/acc_isa", MoneyAccounts.path("acc_isa"))
        assertEquals("/finance/accounts/a%2Fb", MoneyAccounts.path("a/b"))
    }

    @Test
    fun `upsertInto replaces by id and appends a new one`() {
        assertEquals(4, MoneyAccounts.upsertInto(all, isa.copy(name = "ISA")).size)
        assertEquals("ISA", MoneyAccounts.upsertInto(all, isa.copy(name = "ISA")).first { it.id == "acc_isa" }.name)
        assertEquals(5, MoneyAccounts.upsertInto(all, house.copy(id = "acc_x")).size)
    }

    // ---- reconcile overlays ----------------------------------------------

    @Test
    fun `a queued rename survives a reconcile but keeps the hub's ledger`() {
        val local = listOf(isa.copy(name = "ISA (Vanguard)", ledger = emptyList()))
        val out = MoneyAccounts.withInFlightAccounts(listOf(isa), local, setOf("acc_isa"))
        assertEquals("ISA (Vanguard)", out.single().name)
        assertEquals(listOf(reading), out.single().ledger) // money:balance owns the readings
    }

    @Test
    fun `a queued delete stays gone and a queued create shows before the hub has it`() {
        val deleted = MoneyAccounts.withInFlightAccounts(all, all.filterNot { it.id == "acc_isa" }, setOf("acc_isa"))
        assertTrue(deleted.none { it.id == "acc_isa" })

        val made = Account("acc_new", "Chase", "manual", "liquid")
        val created = MoneyAccounts.withInFlightAccounts(all, all + made, setOf("acc_new"))
        assertTrue(created.any { it.id == "acc_new" })
        assertEquals(all.size + 1, created.size)

        // Nothing queued = the hub's list verbatim.
        assertEquals(all, MoneyAccounts.withInFlightAccounts(all, emptyList(), emptySet()))
    }

    @Test
    fun `deletingAccountIds is the queued ids with no local row`() {
        assertEquals(setOf("acc_isa"), MoneyAccounts.deletingAccountIds(setOf("acc_isa", "acc_house"), listOf(house)))
        assertTrue(MoneyAccounts.deletingAccountIds(emptySet(), all).isEmpty())
    }

    // ---- the outbox payload ----------------------------------------------

    @Test
    fun `an action round-trips, and before keeps its ledger so a refused rename does not lose readings`() {
        val a = MoneyAccounts.AccountAction(
            accountId = "acc_isa",
            body = MoneyAccounts.accountBody(isa.copy(name = "ISA"), isEdit = true),
            before = isa,
            patch = null,
        )
        val back = MoneyAccounts.decodeAccountAction(MoneyAccounts.encodeAccountAction(a))!!
        assertEquals("acc_isa", back.accountId)
        assertEquals(a.body, back.body)
        assertEquals(isa, back.before)
        assertEquals(listOf(reading), back.before!!.ledger)
        assertNull(back.patch)

        val del = MoneyAccounts.decodeAccountAction(
            MoneyAccounts.encodeAccountAction(MoneyAccounts.AccountAction("acc_isa", null, isa))
        )!!
        assertNull(del.body)
        assertNull(MoneyAccounts.decodeAccountAction("not json"))
        assertNull(MoneyAccounts.decodeAccountAction("""{"body":null}"""))
    }

    @Test
    fun `a create's patch body rides the payload`() {
        val made = MoneyAccounts.toAccount(MoneyAccounts.Draft(name = "ISA", growth = "6.5"), null, "acc_new")
        val a = MoneyAccounts.AccountAction("acc_new", MoneyAccounts.accountBody(made, false), null, MoneyAccounts.patchBody(made))
        val back = MoneyAccounts.decodeAccountAction(MoneyAccounts.encodeAccountAction(a))!!
        assertEquals(MoneyAccounts.patchBody(made), back.patch)
        assertNull(back.before)
    }

    @Test
    fun `healing puts an edited record back and drops a failed create`() {
        val localEdited = listOf(monzo, isa.copy(name = "ISA"), house)
        val healed = MoneyAccounts.healedAccounts(
            localEdited,
            MoneyAccounts.AccountAction("acc_isa", "{}", isa),
        )
        assertEquals("Vanguard ISA", healed.first { it.id == "acc_isa" }.name)
        assertEquals(listOf(reading), healed.first { it.id == "acc_isa" }.ledger)

        val made = Account("acc_new", "Chase", "manual", "liquid")
        val dropped = MoneyAccounts.healedAccounts(
            listOf(monzo, made),
            MoneyAccounts.AccountAction("acc_new", "{}", null),
        )
        assertEquals(listOf("acc_monzo"), dropped.map { it.id })
    }

    // ---- parsing ---------------------------------------------------------

    @Test
    fun `the account parser reads the three fields the write path needs`() {
        val o = MoneyJson.json.parseToJsonElement(
            """{"id":"acc_x","name":"X","type":"monzo","liquidity":"liquid","color":"#60a5fa",
               "monzoAccountId":"acc_live_9","growthPctYoy":3.25,"isExternal":true,"sort":4}"""
        ).jsonObject
        val a = MoneyJson.parseAccount(o)!!
        assertEquals("#60a5fa", a.color)
        assertEquals("acc_live_9", a.monzoAccountId)
        assertEquals(3.25, a.growthPctYoy!!, 1e-9)
        assertTrue(a.isExternal)
        assertEquals(4, a.sort)

        // Unset growth stays unset — it is NOT 0 (liquid gets 0%, investment the global rate).
        val bare = MoneyJson.parseAccount(
            MoneyJson.json.parseToJsonElement("""{"id":"a","name":"A","type":"manual","liquidity":"investment"}""").jsonObject
        )!!
        assertNull(bare.growthPctYoy)
        assertNull(bare.sort)
    }
}
