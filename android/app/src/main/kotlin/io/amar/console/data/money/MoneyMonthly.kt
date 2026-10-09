package io.amar.console.data.money

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * One month of `GET /finance/monthly` (hub `aggregateMonthlySpend`): pence per
 * category, positive = outflow, negative = inflow, already scaled by
 * `sharedFraction`. Months arrive sorted ascending (`YYYY-MM`).
 */
data class MonthlySpend(val month: String, val byCategory: Map<String, Long>)

/**
 * Port of the SPA's `MonthlySpendChart` grouping (`src/components/money/MonthlySpendChart.tsx`)
 * and the hub's `trailingCategoryAverage` (`server/src/finance/projection.ts`).
 * Keep in sync with both.
 */
object MoneyMonthly {
    const val DEFAULT_WINDOW = 12
    val WINDOWS = listOf(6, 12, 24, 36)
    const val FORECAST_WINDOW = 3

    data class Row(val month: String, val byCategory: Map<String, Long>, val totalPence: Long) {
        /** `% of total` mode: this category's share of the month's outflow, 0 when the month spent nothing. */
        fun percent(categoryId: String): Double =
            if (totalPence > 0) (byCategory[categoryId] ?: 0L).toDouble() / totalPence * 100.0 else 0.0
    }

    /** [categoryIds] = stack order, bottom first: largest window total first (SPA `ordered`). */
    data class Chart(val rows: List<Row>, val categoryIds: List<String>)

    /**
     * The last [windowMonths] months; categories with any positive month in the
     * window, ordered by their window total descending (stable on ties, so the
     * first-seen order breaks them, as JS `sort` does); inflows clamp to 0.
     */
    fun chart(monthly: List<MonthlySpend>, windowMonths: Int): Chart {
        val recent = monthly.takeLast(windowMonths.coerceAtLeast(0))
        val seen = LinkedHashSet<String>()
        for (m in recent) for ((id, p) in m.byCategory) if (p > 0) seen.add(id)
        val totals = HashMap<String, Long>()
        for (m in recent) for (id in seen) {
            val v = m.byCategory[id] ?: 0L
            if (v > 0) totals[id] = (totals[id] ?: 0L) + v
        }
        val ordered = seen.sortedByDescending { totals[it] ?: 0L }
        val rows = recent.map { m ->
            val values = LinkedHashMap<String, Long>()
            var total = 0L
            for (id in ordered) {
                val v = (m.byCategory[id] ?: 0L).coerceAtLeast(0L)
                values[id] = v
                total += v
            }
            Row(m.month, values, total)
        }
        return Chart(rows, ordered)
    }

    /** Hub `trailingCategoryAverage`: mean positive outflow per category over the last N months (Math.round). */
    fun trailingAverage(monthly: List<MonthlySpend>, windowMonths: Int = FORECAST_WINDOW): Map<String, Long> {
        val window = monthly.takeLast(windowMonths.coerceAtLeast(0))
        if (window.isEmpty()) return emptyMap()
        val sums = LinkedHashMap<String, Long>()
        for (m in window) for ((id, p) in m.byCategory) {
            if (p <= 0) continue
            sums[id] = (sums[id] ?: 0L) + p
        }
        return sums.mapValues { (_, t) -> Math.round(t.toDouble() / window.size) }
    }

    /** The SPA ForecastPanel's rows: positive averages, largest first. */
    fun forecastRows(forecast: Map<String, Long>): List<Pair<String, Long>> =
        forecast.entries.filter { it.value > 0 }.sortedByDescending { it.value }.map { it.key to it.value }

    /** Tap-a-bar breakdown: the month's non-zero categories, largest first. */
    fun breakdown(row: Row): List<Pair<String, Long>> =
        row.byCategory.entries.filter { it.value > 0 }.sortedByDescending { it.value }.map { it.key to it.value }

    fun parse(body: String): List<MonthlySpend> {
        val arr = runCatching { MoneyJson.json.parseToJsonElement(body) as? JsonArray }.getOrNull() ?: return emptyList()
        return arr.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val month = (o["month"] as? JsonPrimitive)?.content ?: return@mapNotNull null
            val by = (o["byCategory"] as? JsonObject)?.mapNotNull { (k, v) ->
                val p = v.jsonPrimitive
                (p.longOrNull ?: p.doubleOrNull?.let { Math.round(it) })?.let { k to it }
            }?.toMap() ?: emptyMap()
            MonthlySpend(month, by)
        }.sortedBy { it.month }
    }

    fun encode(monthly: List<MonthlySpend>): String = buildJsonArray {
        for (m in monthly) add(buildJsonObject {
            put("month", JsonPrimitive(m.month))
            put("byCategory", buildJsonObject { for ((k, v) in m.byCategory) put(k, JsonPrimitive(v)) })
        })
    }.toString()
}
