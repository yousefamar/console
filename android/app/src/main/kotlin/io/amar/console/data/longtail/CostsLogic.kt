package io.amar.console.data.longtail

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Bedrock spend — pure port of the SPA's CostReport (src/store/dashboard.ts)
 * + the CostsCard rendering rules (src/components/home/CostsCard.tsx). No
 * Android deps so plain-JUnit testable.
 *
 * Every numeric field is read through [finite]: a report cached by an older
 * hub lacks newer keys, and the SPA once rendered `$NaN/day` for a whole TTL
 * because of exactly that. Here a missing/non-finite number is 0, and the
 * average is additionally flagged absent via [CostReport.hasAverage] so the
 * header can omit it instead of showing a fake $0/day.
 */

private val json = Json { ignoreUnknownKeys = true }

/** Day-window choices — identical to the SPA's COST_DAY_OPTIONS. */
val COST_DAY_OPTIONS = listOf(7, 30, 90)
const val COST_DAYS_DEFAULT = 30

data class CostDay(val date: String, val byOwner: Map<String, Double>, val byModel: Map<String, Double>, val usd: Double)

data class CostReport(
    val generatedAt: Long,
    val days: List<CostDay>,
    /** Owners ranked by spend, `untagged` last — the stacking order. */
    val owners: List<String>,
    val models: List<String>,
    val totalUsd: Double,
    val avgPerDayUsd: Double,
    val avgDayCount: Int,
    val todayUsd: Double,
    /** False when the cached report predates the average fields. */
    val hasAverage: Boolean,
    val totalByOwner: Map<String, Double>,
    val totalByModel: Map<String, Double>,
    val empty: Boolean,
    val ownerTagEpoch: String,
    val ownerNames: Map<String, String>,
    val regionAttributedUsd: Map<String, Double>,
)

enum class CostStackBy { OWNER, MODEL }

/** Non-finite (NaN/±Inf) or absent → null; the caller picks the fallback. */
private fun finite(v: Double?): Double? = v?.takeIf { it.isFinite() }

private fun numberMap(o: JsonObject?): Map<String, Double> =
    o?.mapNotNull { (k, v) -> finite(v.jsonPrimitive.doubleOrNull)?.let { k to it } }?.toMap() ?: emptyMap()

private fun stringList(a: JsonArray?): List<String> =
    a?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList()

/** GET /dashboard/costs?days=N → [CostReport]; null when the body isn't a report
 *  (an `{error}` body, garbage). */
fun parseCostReport(raw: String?): CostReport? {
    if (raw.isNullOrBlank()) return null
    val o = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
    if (o["error"] != null || o["days"] !is JsonArray) return null
    val days = (o["days"] as JsonArray).mapNotNull { el ->
        val d = el as? JsonObject ?: return@mapNotNull null
        CostDay(
            date = d["date"]?.jsonPrimitive?.content ?: return@mapNotNull null,
            byOwner = numberMap(d["byOwner"] as? JsonObject),
            byModel = numberMap(d["byModel"] as? JsonObject),
            usd = finite(d["usd"]?.jsonPrimitive?.doubleOrNull) ?: 0.0,
        )
    }
    val avg = finite(o["avgPerDayUsd"]?.jsonPrimitive?.doubleOrNull)
    return CostReport(
        generatedAt = o["generatedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
        days = days,
        owners = stringList(o["owners"] as? JsonArray),
        models = stringList(o["models"] as? JsonArray),
        totalUsd = finite(o["totalUsd"]?.jsonPrimitive?.doubleOrNull) ?: 0.0,
        avgPerDayUsd = avg ?: 0.0,
        avgDayCount = o["avgDayCount"]?.jsonPrimitive?.intOrNull ?: 0,
        todayUsd = finite(o["todayUsd"]?.jsonPrimitive?.doubleOrNull) ?: 0.0,
        hasAverage = avg != null,
        totalByOwner = numberMap(o["totalByOwner"] as? JsonObject),
        totalByModel = numberMap(o["totalByModel"] as? JsonObject),
        empty = o["empty"]?.jsonPrimitive?.booleanOrNull ?: days.isEmpty(),
        ownerTagEpoch = o["ownerTagEpoch"]?.jsonPrimitive?.content ?: "",
        ownerNames = (o["ownerNames"] as? JsonObject)?.mapNotNull { (k, v) ->
            runCatching { k to v.jsonPrimitive.content }.getOrNull()
        }?.toMap() ?: emptyMap(),
        regionAttributedUsd = numberMap(o["regionAttributedUsd"] as? JsonObject),
    )
}

/** Series keys in stacking order for the chosen breakdown. */
fun CostReport.series(stackBy: CostStackBy): List<String> = if (stackBy == CostStackBy.OWNER) owners else models

fun CostReport.totals(stackBy: CostStackBy): Map<String, Double> = if (stackBy == CostStackBy.OWNER) totalByOwner else totalByModel

fun CostDay.by(stackBy: CostStackBy): Map<String, Double> = if (stackBy == CostStackBy.OWNER) byOwner else byModel

/** Tag value → person's name; `untagged` is never renamed, unknown tags render as
 *  themselves rather than vanishing (SPA `personName`). */
fun CostReport.personName(key: String): String = if (key == "untagged") key else (ownerNames[key] ?: key)

/** Row label for the owner table — `~` marks region-derived attribution. */
fun CostReport.ownerLabel(key: String): String =
    if ((regionAttributedUsd[key] ?: 0.0) > 0) "${personName(key)} ~" else personName(key)

/** Stable per-series colour: palette walked in ranking order (biggest spender
 *  first) skipping `untagged`, which is always neutral grey (SPA `colorFor`). */
private val COST_PALETTE = longArrayOf(
    0xFF3B82F6, 0xFFA855F7, 0xFF22C55E, 0xFFF59E0B, 0xFFEC4899, 0xFF14B8A6, 0xFFEF4444, 0xFF8B5CF6,
)
const val COST_UNTAGGED_ARGB = 0xFF6B7280

fun costColorArgb(key: String, ranked: List<String>): Long {
    if (key == "untagged") return COST_UNTAGGED_ARGB
    val named = ranked.filter { it != "untagged" }
    val idx = named.indexOf(key)
    return COST_PALETTE[(if (idx < 0) 0 else idx) % COST_PALETTE.size]
}

/** SPA `fmtUsd`: `$0` / `<$0.01` / two decimals under $100 / whole dollars above. */
fun fmtUsd(n: Double): String = when {
    n == 0.0 -> "$0"
    n < 0.01 -> "<$0.01"
    n < 100 -> "$" + "%.2f".format(java.util.Locale.US, n)
    else -> "$" + "%,d".format(java.util.Locale.US, Math.round(n))
}

/** `2026-07-29` → `29 Jul`. Date-only, so no timezone shift. */
fun fmtCostDay(date: String): String {
    val parts = date.split('-')
    if (parts.size != 3) return date
    val month = parts[1].toIntOrNull()?.takeIf { it in 1..12 } ?: return date
    val day = parts[2].toIntOrNull() ?: return date
    val mon = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")[month - 1]
    return "$day $mon"
}

/** One stacked segment: [key]'s slice of a day, as cumulative [from]..[to] USD. */
data class StackSegment(val key: String, val from: Double, val to: Double)

/** Per-day stacked segments in series order (bottom-up), with the chart's
 *  y-ceiling (max daily total, never 0 so an all-zero window still draws axes). */
data class CostStack(val days: List<CostDay>, val segments: List<List<StackSegment>>, val maxUsd: Double)

fun stackCosts(report: CostReport, stackBy: CostStackBy): CostStack {
    val keys = report.series(stackBy)
    val segments = report.days.map { d ->
        val src = d.by(stackBy)
        var acc = 0.0
        keys.map { k ->
            val v = (src[k] ?: 0.0).coerceAtLeast(0.0)
            StackSegment(k, acc, acc + v).also { acc += v }
        }
    }
    val max = segments.maxOfOrNull { it.lastOrNull()?.to ?: 0.0 } ?: 0.0
    return CostStack(report.days, segments, if (max > 0) max else 1.0)
}

/** Days strictly before the owner-tag epoch can never be split by person —
 *  the SPA shades them "no attribution". Index range (inclusive) or null. */
fun unattributableRange(report: CostReport, stackBy: CostStackBy): IntRange? {
    if (stackBy != CostStackBy.OWNER || report.ownerTagEpoch.isEmpty()) return null
    val idx = report.days.indices.filter { report.days[it].date < report.ownerTagEpoch }
    return if (idx.isEmpty()) null else idx.first()..idx.last()
}

/** "Nice" y-axis ticks from 0 in rounded steps; the last tick is the first one
 *  at or above [maxUsd], so the tallest bar is never clipped. */
fun costYTicks(maxUsd: Double): List<Double> {
    if (maxUsd <= 0) return listOf(0.0)
    val step = niceStep(maxUsd / 4)
    val ticks = mutableListOf<Double>()
    var v = 0.0
    while (true) {
        ticks.add(v)
        if (v >= maxUsd - step * 0.001) break
        v += step
    }
    return ticks
}

private fun niceStep(raw: Double): Double {
    if (raw <= 0) return 1.0
    val mag = Math.pow(10.0, Math.floor(Math.log10(raw)))
    val n = raw / mag
    val nice = when {
        n <= 1 -> 1.0
        n <= 2 -> 2.0
        n <= 2.5 -> 2.5
        n <= 5 -> 5.0
        else -> 10.0
    }
    return nice * mag
}
