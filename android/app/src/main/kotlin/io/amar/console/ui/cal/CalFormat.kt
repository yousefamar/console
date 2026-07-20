package io.amar.console.ui.cal

import androidx.compose.ui.graphics.Color
import io.amar.console.data.db.CalEventRow
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Shared calendar formatting + colour helpers for the ui/cal composables. Kept
 * separate from CalGrid.kt (pure math, no Android) so both stay focused.
 */

/** "#9fe1e7" → Color; null/garbage → theme-ish blue (#3b82f6, SPA fallback). */
fun parseCalColor(hex: String?): Color {
    if (hex == null) return Color(0xFF3B82F6)
    return runCatching { Color(android.graphics.Color.parseColor(hex)) }
        .getOrDefault(Color(0xFF3B82F6))
}

/** Muted event fill: calendar colour at ~0.3 alpha over the surface. */
fun mutedFill(color: Color): Color = color.copy(alpha = 0.3f)

fun timeShort(ms: Long): String = SimpleDateFormat("HH:mm", Locale.UK).format(Date(ms))
fun dayKey(ms: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(ms))
fun dayLabelLong(ms: Long): String = SimpleDateFormat("EEEE d MMMM", Locale.UK).format(Date(ms))
fun dayLabelShort(ms: Long): String = SimpleDateFormat("EEE d MMM", Locale.UK).format(Date(ms))
fun monthLabel(ms: Long): String = SimpleDateFormat("MMMM yyyy", Locale.UK).format(Date(ms))

/** "July 13–19, 2026" (same month) / "Jun 29 – Jul 5, 2026" (cross-month). */
fun weekRangeLabel(weekStartMs: Long): String {
    val startCal = Calendar.getInstance().apply { timeInMillis = weekStartMs }
    val endCal = Calendar.getInstance().apply { timeInMillis = weekStartMs + 6 * 24L * 60 * 60 * 1000 }
    val sameMonth = startCal.get(Calendar.MONTH) == endCal.get(Calendar.MONTH)
    val year = SimpleDateFormat("yyyy", Locale.UK).format(endCal.time)
    return if (sameMonth) {
        val month = SimpleDateFormat("MMMM", Locale.UK).format(startCal.time)
        "$month ${startCal.get(Calendar.DAY_OF_MONTH)}–${endCal.get(Calendar.DAY_OF_MONTH)}, $year"
    } else {
        val s = SimpleDateFormat("MMM d", Locale.UK).format(startCal.time)
        val e = SimpleDateFormat("MMM d", Locale.UK).format(endCal.time)
        "$s – $e, $year"
    }
}

/** Day-view header: 'Today · EEE d MMM' when today, else 'EEEE d MMM'. */
fun dayNavLabel(dayStartMs: Long): String {
    val today = Calendar.getInstance().apply {
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
    }.timeInMillis
    return if (dayStartMs == today) "Today · " + dayLabelShort(dayStartMs)
    else SimpleDateFormat("EEEE d MMM", Locale.UK).format(Date(dayStartMs))
}

/** Compound-key helper for calendar lookup: accountEmail:calendarId. */
fun calKeyOf(e: CalEventRow) = "${e.accountEmail}:${e.calendarId}"
fun calKeyOf(c: io.amar.console.data.db.CalendarRow) = c.id

fun nextHour(): Long {
    val cal = Calendar.getInstance()
    cal.add(Calendar.HOUR_OF_DAY, 1)
    cal.set(Calendar.MINUTE, 0); cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
    return cal.timeInMillis
}
