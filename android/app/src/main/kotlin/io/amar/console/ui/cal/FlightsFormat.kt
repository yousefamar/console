package io.amar.console.ui.cal

import io.amar.console.data.cal.FlightsRepository
import java.text.SimpleDateFormat
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

/** Pure flight-panel formatting helpers (region labels, price, delta, meta). */
object FlightsFormat {

    private val REGION_LABEL = mapOf(
        "europe" to "Europe", "asia" to "Asia", "north_america" to "N.America",
        "south_america" to "S.America", "africa" to "Africa", "oceania" to "Oceania",
    )
    private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    fun currencySymbol(currency: String): String = when (currency.uppercase()) {
        "GBP" -> "£"; "USD" -> "$"; "EUR" -> "€"; else -> ""
    }

    fun formatPrice(major: Double, currency: String): String {
        val sym = currencySymbol(currency)
        val n = major.roundToInt()
        return if (sym.isNotEmpty()) "$sym$n" else "$n ${currency.uppercase()}"
    }

    /** Auto-description when no user label: explore = 'ORG → region/dest · Mon',
     *  route = 'ORG → DST · date'. */
    fun describe(wl: FlightsRepository.Watchlist): String {
        return if (wl.kind == "route") {
            val dst = wl.destination ?: "?"
            val date = wl.outboundDate ?: ""
            "${wl.origin} → $dst" + if (date.isNotBlank()) " · ${compactDate(date)}" else ""
        } else {
            val target = wl.destination ?: wl.region?.let { REGION_LABEL[it] ?: it } ?: "anywhere"
            val month = wl.month?.let { if (it in 1..12) MONTHS[it - 1] else "next 6mo" } ?: "next 6mo"
            "${wl.origin} → $target · $month"
        }
    }

    /** Delta vs the previous poll from the last two history entries. */
    fun priceDelta(wl: FlightsRepository.Watchlist): Double? {
        if (wl.history.size < 2) return null
        return wl.history.last() - wl.history[wl.history.size - 2]
    }

    fun deltaLabel(delta: Double): String = (if (delta < 0) "↓" else "↑") + abs(delta).roundToInt()

    /** Result meta line: flight numbers (else airlines) · direct/Nst · XhYm. */
    fun resultMeta(r: FlightsRepository.ResultRow): String {
        val parts = mutableListOf<String>()
        if (r.flightNumbers.isNotEmpty()) parts.add(r.flightNumbers.joinToString(","))
        else if (r.airlines.isNotEmpty()) parts.add(r.airlines.joinToString(", "))
        r.stops?.let { parts.add(if (it == 0) "direct" else "${it}st") }
        r.totalDurationMin?.let { parts.add(formatDuration(it)) }
        return parts.joinToString(" · ")
    }

    fun formatDuration(min: Int): String {
        val h = min / 60; val m = min % 60
        return if (h > 0) "${h}h${if (m > 0) "${m}m" else ""}" else "${m}m"
    }

    /** SerpApi 'YYYY-MM-DD HH:MM' → 'HH:MM' tail, '?' when absent. */
    fun clockTime(s: String?): String? {
        if (s.isNullOrBlank()) return null
        val tail = s.substringAfter(" ", "")
        return tail.ifBlank { null }
    }

    /** 'YYYY-MM-DD' → 'DD Mon'. */
    fun compactDate(s: String?): String {
        if (s.isNullOrBlank()) return ""
        return runCatching {
            val d = SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(s.substringBefore(" "))
            SimpleDateFormat("d MMM", Locale.UK).format(d!!)
        }.getOrDefault(s)
    }

    /** Human "checked N ago". */
    fun timeAgo(atMs: Long, nowMs: Long): String {
        val diff = (nowMs - atMs).coerceAtLeast(0)
        val min = diff / 60000
        return when {
            min < 1 -> "just now"
            min < 60 -> "${min}m ago"
            min < 60 * 24 -> "${min / 60}h ago"
            else -> "${min / (60 * 24)}d ago"
        }
    }
}
