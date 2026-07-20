package io.amar.console.data.cal

import io.amar.console.data.db.CalEventRow
import java.util.Calendar
import java.util.TimeZone

/**
 * Pure, unit-tested layout math for the calendar grids — no Android, no Compose.
 * Ports the geometry the SPA's CalendarGrid.tsx / CalendarMonth.tsx do inline:
 * concurrent-column lane packing, month 6×7 grid, multi-day all-day row packing,
 * cross-calendar duplicate merging, and 15-min snapping.
 */

const val QUARTER_MS = 15L * 60 * 1000
const val HOUR_MS = 60L * 60 * 1000
const val DAY_MS = 24L * 60 * 60 * 1000

/** Placement of one timed event within its overlap cluster. */
data class LaneInfo(val lane: Int, val laneCount: Int)

/**
 * Concurrent-column packing. Events are grouped into clusters of transitively
 * overlapping blocks; within a cluster each event gets the first free column and
 * the whole cluster shares one column count. A non-overlapping event is its own
 * cluster (count 1 → full width) — fixes the "non-overlapping events shrink too"
 * bug from dividing by the day's global max lane. Input need not be sorted.
 */
fun packLanes(events: List<CalEventRow>): Map<String, LaneInfo> {
    if (events.isEmpty()) return emptyMap()
    val sorted = events.sortedWith(compareBy({ it.startTime }, { it.endTime }))
    val out = HashMap<String, LaneInfo>()

    var clusterStart = 0
    var clusterMaxEnd = Long.MIN_VALUE
    val laneEnds = ArrayList<Long>() // per-column last end within the current cluster
    val laneOf = HashMap<String, Int>()

    fun flushCluster(endExclusive: Int) {
        val count = laneEnds.size.coerceAtLeast(1)
        for (i in clusterStart until endExclusive) {
            val e = sorted[i]
            out[e.compoundKey] = LaneInfo(laneOf[e.compoundKey] ?: 0, count)
        }
        laneEnds.clear()
        laneOf.clear()
    }

    for ((idx, e) in sorted.withIndex()) {
        // A gap (this event starts at/after every prior event in the cluster ended)
        // closes the cluster and starts a new one.
        if (idx > clusterStart && e.startTime >= clusterMaxEnd) {
            flushCluster(idx)
            clusterStart = idx
            clusterMaxEnd = Long.MIN_VALUE
        }
        // Overlap uses raw end times; the min visible height is a render concern
        // applied separately (heightMin), not here.
        var lane = laneEnds.indexOfFirst { it <= e.startTime }
        if (lane < 0) {
            laneEnds.add(e.endTime)
            lane = laneEnds.size - 1
        } else {
            laneEnds[lane] = e.endTime
        }
        laneOf[e.compoundKey] = lane
        clusterMaxEnd = maxOf(clusterMaxEnd, e.endTime)
    }
    flushCluster(sorted.size)
    return out
}

// -------------------------------------------------------------------------- //
// Duplicate merge across calendars

/** A grid-ready event: one visible block that may aggregate copies from several
 *  calendars (color stripes). `primary` is the copy we display/edit/RSVP. */
data class MergedEvent(
    val primary: CalEventRow,
    val colors: List<String>,       // one per source calendar (hex, in stable order)
    val accepted: Boolean,          // true if ANY copy is accepted / owned
)

/**
 * Merge duplicate events that appear on multiple calendars (e.g. an invite that
 * lands on both your work + personal calendar). Key = start+end+summary. The
 * displayed copy prefers the user's OWN calendar (id == accountEmail); accepted
 * is the union across copies. `colorOf`/`ownedBy`/`acceptedOf` are injected so
 * this stays pure. Order of the returned list follows first-seen start order.
 */
fun mergeDuplicates(
    events: List<CalEventRow>,
    colorOf: (CalEventRow) -> String,
    ownedBy: (CalEventRow) -> Boolean,
    acceptedOf: (CalEventRow) -> Boolean,
): List<MergedEvent> {
    val groups = LinkedHashMap<String, MutableList<CalEventRow>>()
    for (e in events) {
        val key = "${e.startTime}|${e.endTime}|${e.summary}"
        groups.getOrPut(key) { mutableListOf() }.add(e)
    }
    return groups.values.map { copies ->
        val primary = copies.firstOrNull { ownedBy(it) } ?: copies.first()
        val colors = copies.map(colorOf).distinct()
        val accepted = copies.any { acceptedOf(it) }
        MergedEvent(primary, colors, accepted)
    }
}

// -------------------------------------------------------------------------- //
// All-day / multi-day row packing

/** One placed all-day bar: [startCol, endCol] inclusive within the visible week,
 *  and the row it sits on (greedy packing). */
data class AllDayBar(val event: CalEventRow, val startCol: Int, val endCol: Int, val row: Int)

/**
 * Pack multi-day all-day bars into rows across a [numCols]-day window beginning
 * at [weekStartMs] (local midnight). Google all-day end dates are EXCLUSIVE, so
 * a 1-day event has end == start+1day and occupies a single column. Sorted by
 * start column, then longer spans first, then greedily assigned the first row
 * with no column collision.
 */
fun packAllDayBars(events: List<CalEventRow>, weekStartMs: Long, numCols: Int): List<AllDayBar> {
    data class Span(val e: CalEventRow, val start: Int, val end: Int)
    val spans = events.mapNotNull { e ->
        val startCol = ((e.startTime - weekStartMs) / DAY_MS).toInt()
        // Exclusive end date → last covered day is end - 1ms.
        val endMs = maxOf(e.endTime - 1, e.startTime)
        val endCol = ((endMs - weekStartMs) / DAY_MS).toInt()
        val clampedStart = startCol.coerceIn(0, numCols - 1)
        val clampedEnd = endCol.coerceIn(0, numCols - 1)
        if (endCol < 0 || startCol > numCols - 1) null
        else Span(e, clampedStart, clampedEnd)
    }.sortedWith(compareBy({ it.start }, { -(it.end - it.start) }))

    val rowEnds = ArrayList<Int>() // last occupied col per row
    val out = ArrayList<AllDayBar>()
    for (s in spans) {
        var row = rowEnds.indexOfFirst { it < s.start }
        if (row < 0) {
            rowEnds.add(s.end)
            row = rowEnds.size - 1
        } else {
            rowEnds[row] = s.end
        }
        out.add(AllDayBar(s.e, s.start, s.end, row))
    }
    return out
}

// -------------------------------------------------------------------------- //
// Month grid

/** Always 6 rows × 7 days, Monday-anchored, including prev/next-month spillover.
 *  Returns local-midnight epoch millis for each of the 42 cells. */
fun monthGridDays(year: Int, month0: Int, tz: TimeZone = TimeZone.getDefault()): List<Long> {
    val cal = Calendar.getInstance(tz)
    cal.firstDayOfWeek = Calendar.MONDAY
    cal.clear()
    cal.set(year, month0, 1, 0, 0, 0)
    // Back up to the Monday on/before the 1st.
    val dow = cal.get(Calendar.DAY_OF_WEEK) // SUN=1..SAT=7
    val backDays = ((dow - Calendar.MONDAY) + 7) % 7
    cal.add(Calendar.DAY_OF_YEAR, -backDays)
    return (0 until 42).map {
        val ms = cal.timeInMillis
        cal.add(Calendar.DAY_OF_YEAR, 1)
        ms
    }
}

/** Clamp day-of-month when adding months (Jan 31 + 1mo → Feb 28). */
fun addMonthsClamped(baseMs: Long, delta: Int, tz: TimeZone = TimeZone.getDefault()): Long {
    val cal = Calendar.getInstance(tz)
    cal.timeInMillis = baseMs
    val day = cal.get(Calendar.DAY_OF_MONTH)
    cal.set(Calendar.DAY_OF_MONTH, 1)
    cal.add(Calendar.MONTH, delta)
    val maxDay = cal.getActualMaximum(Calendar.DAY_OF_MONTH)
    cal.set(Calendar.DAY_OF_MONTH, minOf(day, maxDay))
    return cal.timeInMillis
}

// -------------------------------------------------------------------------- //
// Snapping + time math

/** Snap a millis instant to the nearest 15-min boundary (local). */
fun snapToQuarter(ms: Long): Long = Math.round(ms.toDouble() / QUARTER_MS) * QUARTER_MS

/** Local midnight at/on-or-before [ms]. */
fun startOfDay(ms: Long, tz: TimeZone = TimeZone.getDefault()): Long {
    val cal = Calendar.getInstance(tz)
    cal.timeInMillis = ms
    cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0)
    cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
    return cal.timeInMillis
}

/** Monday-anchored local week start at/on-or-before [ms]. */
fun startOfWeek(ms: Long, tz: TimeZone = TimeZone.getDefault()): Long {
    val cal = Calendar.getInstance(tz)
    cal.timeInMillis = ms
    cal.firstDayOfWeek = Calendar.MONDAY
    cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0)
    cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
    val dow = cal.get(Calendar.DAY_OF_WEEK)
    val backDays = ((dow - Calendar.MONDAY) + 7) % 7
    cal.add(Calendar.DAY_OF_YEAR, -backDays)
    return cal.timeInMillis
}

/** Which day-column (0-based) an instant falls in, relative to a week start. */
fun dayColumn(ms: Long, weekStartMs: Long): Int = ((ms - weekStartMs) / DAY_MS).toInt()

/** Same local calendar day? */
fun sameDay(a: Long, b: Long, tz: TimeZone = TimeZone.getDefault()): Boolean =
    startOfDay(a, tz) == startOfDay(b, tz)
