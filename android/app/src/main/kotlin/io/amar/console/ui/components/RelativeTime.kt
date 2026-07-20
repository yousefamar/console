package io.amar.console.ui.components

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Relative-time formatting — the native twin of src/utils/date.ts (FEATURES
 * app-wide #101). Handles BOTH past and future (snooze/reminder) instants:
 *
 *   Past:   'now' (<1m), Nm, Nh, Nd (≤7d), then 'MMM d' (+ ', yyyy' off-year)
 *   Future: 'in Nm', 'in Nh', 'in Nd' (≤7d), then the short date.
 *
 * Pure (takes an explicit [now]) so it is deterministic + unit-tested.
 */
object RelativeTime {
    private const val MIN = 60_000L
    private const val HOUR = 60 * MIN
    private const val DAY = 24 * HOUR

    fun format(ts: Long, now: Long = System.currentTimeMillis()): String {
        val diff = ts - now
        val abs = kotlin.math.abs(diff)
        return when {
            abs < MIN -> "now"
            diff < 0 -> pastLabel(abs, ts, now)
            else -> "in " + futureLabel(abs, ts, now)
        }
    }

    private fun pastLabel(abs: Long, ts: Long, now: Long): String = when {
        abs < HOUR -> "${abs / MIN}m"
        abs < DAY -> "${abs / HOUR}h"
        abs < 7 * DAY -> "${abs / DAY}d"
        else -> shortDate(ts, now)
    }

    private fun futureLabel(abs: Long, ts: Long, now: Long): String = when {
        abs < HOUR -> "${abs / MIN}m"
        abs < DAY -> "${abs / HOUR}h"
        abs < 7 * DAY -> "${abs / DAY}d"
        else -> shortDate(ts, now)
    }

    /** 'MMM d', with ', yyyy' appended when the year differs from [now]. */
    fun shortDate(ts: Long, now: Long = System.currentTimeMillis()): String {
        val sameYear = SimpleDateFormat("yyyy", Locale.UK).run {
            format(Date(ts)) == format(Date(now))
        }
        val pattern = if (sameYear) "MMM d" else "MMM d, yyyy"
        return SimpleDateFormat(pattern, Locale.UK).format(Date(ts))
    }
}
