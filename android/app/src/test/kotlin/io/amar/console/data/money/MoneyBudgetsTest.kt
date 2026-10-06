package io.amar.console.data.money

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/** Port of the SPA `BudgetsView.tsx` arithmetic + the `money:budget` outbox contract. */
class MoneyBudgetsTest {

    private val food = MoneyCategory("cat_food", "Food", "🍔", "#a78bfa", "expense")
    private val bills = MoneyCategory("cat_bills", "Bills", "🧾", "#f59e0b", "expense")
    private val salary = MoneyCategory("cat_salary", "Salary", "💸", "#4ade80", "income")
    private val transfer = MoneyCategory("cat_transfer", "Transfer", "🔁", "#94a3b8", "transfer", isSystem = true)
    private val cats = listOf(food, bills, salary, transfer).associateBy { it.id }

    private val foodBudget = Budget("bud_1", "cat_food", 40_000)

    // ---- request body ----------------------------------------------------

    @Test
    fun `an upsert of an existing budget sends its hub id so that row is retargeted`() {
        val body = MoneyBudgets.requestBody(MoneyBudgets.BudgetEdit.SetTarget("cat_food", 50_000, "bud_1"))
        assertEquals("""{"id":"bud_1","categoryId":"cat_food","monthlyTargetPence":50000}""", body)
    }

    @Test
    fun `a create sends no id — the hub matches on categoryId and mints one`() {
        assertEquals(
            """{"categoryId":"cat_food","monthlyTargetPence":50000}""",
            MoneyBudgets.requestBody(MoneyBudgets.BudgetEdit.SetTarget("cat_food", 50_000)),
        )
    }

    @Test
    fun `a temp id is never sent as the hub id`() {
        val temp = MoneyBudgets.tempId(1_700_000_000_000, 42)
        assertTrue(temp.startsWith(MoneyBudgets.TEMP_PREFIX))
        val body = MoneyBudgets.requestBody(MoneyBudgets.BudgetEdit.SetTarget("cat_food", 1_000, temp))
        assertFalse(body.contains("\"id\""))
        assertTrue(Budget(temp, "cat_food", 1_000).isLocal)
        assertFalse(foodBudget.isLocal)
    }

    // ---- optimistic list -------------------------------------------------

    @Test
    fun `merged keeps the existing id and only moves the target`() {
        val m = MoneyBudgets.merged(foodBudget, MoneyBudgets.BudgetEdit.SetTarget("cat_food", 55_000, "bud_1"))
        assertEquals(Budget("bud_1", "cat_food", 55_000), m)
    }

    @Test
    fun `merged mints a temp id for a create`() {
        val m = MoneyBudgets.merged(null, MoneyBudgets.BudgetEdit.SetTarget("cat_bills", 12_345), newId = { "~fixed" })
        assertEquals(Budget("~fixed", "cat_bills", 12_345), m)
    }

    @Test
    fun `upsert replaces by id, then by category, else appends`() {
        val list = listOf(foodBudget)
        assertEquals(
            listOf(Budget("bud_1", "cat_food", 99_000)),
            MoneyBudgets.optimisticUpsert(list, Budget("bud_1", "cat_food", 99_000)),
        )
        // Same category under the real id while we still show the temp one.
        assertEquals(
            listOf(Budget("bud_9", "cat_food", 1_000)),
            MoneyBudgets.optimisticUpsert(listOf(Budget("~1.2", "cat_food", 500)), Budget("bud_9", "cat_food", 1_000)),
        )
        assertEquals(2, MoneyBudgets.optimisticUpsert(list, Budget("bud_2", "cat_bills", 100)).size)
        assertEquals(emptyList<Budget>(), MoneyBudgets.optimisticDelete(list, "bud_1"))
    }

    @Test
    fun `an in-flight edit survives a reconcile that still has the hub's old copy`() {
        val hub = listOf(Budget("bud_1", "cat_food", 40_000), Budget("bud_2", "cat_bills", 10_000))
        val local = listOf(Budget("bud_1", "cat_food", 90_000), Budget("bud_2", "cat_bills", 10_000))
        val merged = MoneyBudgets.withInFlight(hub, local, setOf("cat_food"))
        assertEquals(90_000, merged.first { it.categoryId == "cat_food" }.monthlyTargetPence)
        assertEquals(10_000, merged.first { it.categoryId == "cat_bills" }.monthlyTargetPence)
    }

    @Test
    fun `an in-flight delete is not resurrected by the hub's list`() {
        val hub = listOf(foodBudget)
        val merged = MoneyBudgets.withInFlight(hub, local = emptyList(), inFlightCategoryIds = setOf("cat_food"))
        assertTrue(merged.isEmpty())
        // Nothing queued: the hub is authoritative.
        assertEquals(hub, MoneyBudgets.withInFlight(hub, emptyList(), emptySet()))
    }

    // ---- rows + totals ---------------------------------------------------

    private fun status(budgetId: String, categoryId: String, target: Long, spent: Long, projected: Long) =
        BudgetStatus(budgetId, categoryId, target, spent, target - spent, if (target > 0) spent.toDouble() / target else 0.0, projected)

    @Test
    fun `a row joins its status and derives the SPA's fractions`() {
        val rows = MoneyBudgets.rows(
            listOf(foodBudget),
            listOf(status("bud_1", "cat_food", 40_000, 20_000, 30_000)),
            cats,
        )
        val r = rows.single()
        assertEquals("🍔 Food", r.label)
        assertEquals(20_000, r.spentPence)
        assertEquals(20_000, r.remainingPence)
        assertEquals(0.5, r.pct, 1e-9)
        assertEquals(0.75, r.projectedPct, 1e-9)
        assertFalse(r.overspending)
        assertFalse(r.over)
    }

    @Test
    fun `projected over target is overspending, spent over target is over`() {
        val onCourseOver = MoneyBudgets.rows(listOf(foodBudget), listOf(status("bud_1", "cat_food", 40_000, 20_000, 48_000)), cats).single()
        assertTrue(onCourseOver.overspending)
        assertFalse(onCourseOver.over)

        val alreadyOver = MoneyBudgets.rows(listOf(foodBudget), listOf(status("bud_1", "cat_food", 40_000, 44_000, 44_000)), cats).single()
        assertTrue(alreadyOver.over)
        assertEquals(-4_000, alreadyOver.remainingPence)
    }

    @Test
    fun `bar fractions are clamped so a wild overshoot cannot blow up the layout`() {
        val r = MoneyBudgets.rows(listOf(foodBudget), listOf(status("bud_1", "cat_food", 40_000, 400_000, 900_000)), cats).single()
        assertEquals(MoneyBudgets.BAR_CLAMP, r.pct, 1e-9)
        assertEquals(MoneyBudgets.BAR_CLAMP, r.projectedPct, 1e-9)
    }

    @Test
    fun `a zero target never divides by zero`() {
        val r = MoneyBudgets.rows(listOf(Budget("b", "cat_food", 0)), listOf(status("b", "cat_food", 0, 500, 900)), cats).single()
        assertEquals(0.0, r.pct, 1e-9)
        assertFalse(r.over)
    }

    @Test
    fun `a just-created budget takes its status by category since its id is still temp`() {
        val r = MoneyBudgets.rows(
            listOf(Budget("~1.2", "cat_food", 40_000)),
            listOf(status("bud_1", "cat_food", 40_000, 12_000, 18_000)),
            cats,
        ).single()
        assertEquals(12_000, r.spentPence)
        assertEquals(18_000, r.projectedPence)
    }

    @Test
    fun `a budget with no status row shows zero spend, and an unknown category falls back to its id`() {
        val r = MoneyBudgets.rows(listOf(Budget("b", "cat_gone", 5_000)), emptyList(), cats).single()
        assertEquals(0, r.spentPence)
        assertEquals(0, r.projectedPence)
        assertNull(r.category)
        assertEquals("cat_gone", r.label)
    }

    @Test
    fun `totals sum the rows, including a not-yet-synced one`() {
        val rows = MoneyBudgets.rows(
            listOf(foodBudget, Budget("~1.2", "cat_bills", 10_000)),
            listOf(status("bud_1", "cat_food", 40_000, 20_000, 30_000), status("bud_x", "cat_bills", 10_000, 9_000, 11_000)),
            cats,
        )
        val t = MoneyBudgets.totals(rows)
        assertEquals(50_000, t.targetPence)
        assertEquals(29_000, t.spentPence)
        assertEquals(41_000, t.projectedPence)
        assertFalse(t.overspending)
        assertTrue(MoneyBudgets.totals(MoneyBudgets.rows(listOf(foodBudget), listOf(status("bud_1", "cat_food", 40_000, 39_000, 46_000)), cats)).overspending)
    }

    // ---- picker + input --------------------------------------------------

    @Test
    fun `the picker offers expense categories that have no budget, never income or system ones`() {
        val available = MoneyBudgets.availableCategories(listOf(food, bills, salary, transfer), listOf(foodBudget))
        assertEquals(listOf("cat_bills"), available.map { it.id })
    }

    @Test
    fun `pounds parse to pence and back`() {
        assertEquals(1_250L, MoneyBudgets.poundsToPence("12.50"))
        assertEquals(1_200L, MoneyBudgets.poundsToPence("12"))
        assertEquals(1_250L, MoneyBudgets.poundsToPence(" £12.50 "))
        assertEquals(123_456L, MoneyBudgets.poundsToPence("1,234.56"))
        assertEquals(1_235L, MoneyBudgets.poundsToPence("12.345")) // rounded, like the SPA's Math.round
        assertNull(MoneyBudgets.poundsToPence(""))
        assertNull(MoneyBudgets.poundsToPence("abc"))
        assertNull(MoneyBudgets.poundsToPence("0"))
        assertNull(MoneyBudgets.poundsToPence("-5"))
        assertEquals(1L, MoneyBudgets.poundsToPence("0.001")) // never rounds a positive amount to nothing
        assertEquals("12", MoneyBudgets.penceToPounds(1_200))
        assertEquals("12.50", MoneyBudgets.penceToPounds(1_250))
    }

    @Test
    fun `the status month is the current one, zero-padded`() {
        assertEquals("2026-01", MoneyBudgets.currentMonth(LocalDate.of(2026, 1, 9)))
        assertEquals("2026-10", MoneyBudgets.currentMonth(LocalDate.of(2026, 10, 31)))
    }

    // ---- outbox payload --------------------------------------------------

    @Test
    fun `an action round-trips through its payload`() {
        val a = MoneyBudgets.Action(
            categoryId = "cat_food",
            budgetId = "bud_1",
            body = MoneyBudgets.requestBody(MoneyBudgets.BudgetEdit.SetTarget("cat_food", 50_000, "bud_1")),
            before = foodBudget.copy(rollover = true, notes = "n"),
        )
        assertEquals(a, MoneyBudgets.decodeAction(MoneyBudgets.encodeAction(a)))
        val del = MoneyBudgets.Action("cat_food", "bud_1", body = null, before = foodBudget)
        assertEquals(del, MoneyBudgets.decodeAction(MoneyBudgets.encodeAction(del)))
        assertNull(MoneyBudgets.decodeAction("not json"))
        assertNull(MoneyBudgets.decodeAction("""{"categoryId":"cat_food"}"""))
    }

    @Test
    fun `a rejected edit heals back to the record it replaced`() {
        val a = MoneyBudgets.Action("cat_food", "bud_1", body = "{}", before = foodBudget)
        val afterEdit = listOf(Budget("bud_1", "cat_food", 90_000), Budget("bud_2", "cat_bills", 10_000))
        val healed = MoneyBudgets.healed(afterEdit, a)
        assertEquals(40_000, healed.first { it.categoryId == "cat_food" }.monthlyTargetPence)
        assertEquals(2, healed.size)
    }

    @Test
    fun `a rejected create drops the row it added`() {
        val a = MoneyBudgets.Action("cat_bills", "~1.2", body = "{}", before = null)
        val healed = MoneyBudgets.healed(listOf(foodBudget, Budget("~1.2", "cat_bills", 10_000)), a)
        assertEquals(listOf(foodBudget), healed)
    }

    @Test
    fun `a rejected delete puts the budget back`() {
        val a = MoneyBudgets.Action("cat_food", "bud_1", body = null, before = foodBudget)
        assertEquals(listOf(foodBudget), MoneyBudgets.healed(emptyList(), a))
    }
}
