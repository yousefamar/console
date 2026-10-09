package io.amar.console.data.money

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of the SPA `MonthlySpendChart` grouping + the hub's `trailingCategoryAverage`. */
class MoneyMonthlyTest {

    private fun m(month: String, vararg by: Pair<String, Long>) = MonthlySpend(month, by.toMap())

    private val months = listOf(
        m("2026-06", "food" to 10_000, "rent" to 90_000, "salary" to -300_000),
        m("2026-07", "food" to 12_000, "fun" to 5_000),
        m("2026-08", "food" to 8_000, "rent" to 90_000, "fun" to -1_000),
        m("2026-09", "fun" to 20_000),
    )

    @Test
    fun `window keeps the last N months in ascending order`() {
        val c = MoneyMonthly.chart(months, 2)
        assertEquals(listOf("2026-08", "2026-09"), c.rows.map { it.month })
    }

    @Test
    fun `categories are those with an outflow in the window, ordered by window total descending`() {
        val c = MoneyMonthly.chart(months, 12)
        assertEquals(listOf("rent", "food", "fun"), c.categoryIds)
        // Income never shows: salary is negative in every month.
        assertTrue("salary" !in c.categoryIds)
    }

    @Test
    fun `a category outside the window drops out`() {
        assertEquals(listOf("rent", "fun", "food"), MoneyMonthly.chart(months, 2).categoryIds)
        assertEquals(listOf("fun"), MoneyMonthly.chart(months, 1).categoryIds)
    }

    @Test
    fun `ties keep first-seen order like a stable JS sort`() {
        val c = MoneyMonthly.chart(listOf(m("2026-01", "b" to 100, "a" to 100)), 12)
        assertEquals(listOf("b", "a"), c.categoryIds)
    }

    @Test
    fun `inflows clamp to zero and do not count toward the month total`() {
        val row = MoneyMonthly.chart(months, 12).rows.first { it.month == "2026-08" }
        assertEquals(0L, row.byCategory["fun"])
        assertEquals(98_000L, row.totalPence)
    }

    @Test
    fun `percent mode is each category's share of that month, zero for an empty month`() {
        val rows = MoneyMonthly.chart(months + m("2026-10", "salary" to -5), 12).rows
        val aug = rows.first { it.month == "2026-08" }
        assertEquals(8_000.0 / 98_000 * 100, aug.percent("food"), 1e-9)
        assertEquals(0.0, rows.last().percent("food"), 0.0)
    }

    @Test
    fun `breakdown lists the month's non-zero categories largest first`() {
        val row = MoneyMonthly.chart(months, 12).rows.first { it.month == "2026-08" }
        assertEquals(listOf("rent" to 90_000L, "food" to 8_000L), MoneyMonthly.breakdown(row))
    }

    @Test
    fun `trailing average divides by the window length and skips inflows`() {
        val avg = MoneyMonthly.trailingAverage(months, 3)
        // Jul..Sep: food 20000/3, rent 90000/3, fun (5000+20000)/3; fun's -1000 ignored.
        assertEquals(mapOf("food" to 6_667L, "fun" to 8_333L, "rent" to 30_000L), avg)
        assertEquals(emptyMap<String, Long>(), MoneyMonthly.trailingAverage(emptyList(), 3))
    }

    @Test
    fun `forecast rows are positive averages largest first`() {
        assertEquals(
            listOf("rent" to 30_000L, "fun" to 8_333L, "food" to 6_667L),
            MoneyMonthly.forecastRows(MoneyMonthly.trailingAverage(months, 3)),
        )
    }

    @Test
    fun `parse reads the hub shape and encode round-trips it`() {
        val body = """[{"month":"2026-09","byCategory":{"food":1200,"salary":-5000}},
            {"month":"2026-08","byCategory":{"rent":90000.0}},{"nope":1}]"""
        val parsed = MoneyMonthly.parse(body)
        assertEquals(listOf("2026-08", "2026-09"), parsed.map { it.month })
        assertEquals(-5000L, parsed[1].byCategory["salary"])
        assertEquals(90_000L, parsed[0].byCategory["rent"])
        assertEquals(parsed, MoneyMonthly.parse(MoneyMonthly.encode(parsed)))
        assertEquals(emptyList<MonthlySpend>(), MoneyMonthly.parse("not json"))
    }
}
