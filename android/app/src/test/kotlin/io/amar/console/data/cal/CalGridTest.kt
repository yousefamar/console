package io.amar.console.data.cal

import io.amar.console.data.db.CalEventRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

class CalGridTest {

    private fun evt(id: String, start: Long, end: Long, summary: String = id, cal: String = "c", acct: String = "a") =
        CalEventRow(
            compoundKey = id, accountEmail = acct, calendarId = cal, eventId = id,
            summary = summary, location = null, startTime = start, endTime = end,
            isAllDay = false, status = "confirmed", rawJson = "{}",
        )

    // ---- packLanes ---------------------------------------------------- //

    @Test
    fun `non-overlapping events all get full width`() {
        val lanes = packLanes(listOf(evt("a", 0, HOUR_MS), evt("b", 2 * HOUR_MS, 3 * HOUR_MS)))
        assertEquals(LaneInfo(0, 1), lanes["a"])
        assertEquals(LaneInfo(0, 1), lanes["b"])
    }

    @Test
    fun `two overlapping events split into two columns`() {
        val lanes = packLanes(listOf(evt("a", 0, 2 * HOUR_MS), evt("b", HOUR_MS, 3 * HOUR_MS)))
        assertEquals(0, lanes["a"]!!.lane)
        assertEquals(1, lanes["b"]!!.lane)
        assertEquals(2, lanes["a"]!!.laneCount)
        assertEquals(2, lanes["b"]!!.laneCount)
    }

    @Test
    fun `a later non-overlapping event reuses column 0 at full width`() {
        // a[0..2h] and b[1h..3h] overlap (cluster of 2), c[4h..5h] is separate.
        val lanes = packLanes(listOf(
            evt("a", 0, 2 * HOUR_MS),
            evt("b", HOUR_MS, 3 * HOUR_MS),
            evt("c", 4 * HOUR_MS, 5 * HOUR_MS),
        ))
        assertEquals(2, lanes["a"]!!.laneCount)
        assertEquals(2, lanes["b"]!!.laneCount)
        assertEquals(LaneInfo(0, 1), lanes["c"]) // full width — not shrunk by the other cluster
    }

    @Test
    fun `three-way overlap yields three columns`() {
        val lanes = packLanes(listOf(
            evt("a", 0, 3 * HOUR_MS),
            evt("b", HOUR_MS, 3 * HOUR_MS),
            evt("c", 2 * HOUR_MS, 3 * HOUR_MS),
        ))
        assertEquals(3, lanes["a"]!!.laneCount)
        assertEquals(setOf(0, 1, 2), setOf(lanes["a"]!!.lane, lanes["b"]!!.lane, lanes["c"]!!.lane))
    }

    @Test
    fun `empty input yields empty map`() {
        assertTrue(packLanes(emptyList()).isEmpty())
    }

    // ---- mergeDuplicates ---------------------------------------------- //

    @Test
    fun `duplicate events across calendars merge into one block with two colors`() {
        val a = evt("a1", 0, HOUR_MS, summary = "Standup", cal = "work", acct = "work@x")
        val b = evt("b1", 0, HOUR_MS, summary = "Standup", cal = "me@x", acct = "me@x")
        val merged = mergeDuplicates(
            listOf(a, b),
            colorOf = { if (it.calendarId == "work") "#ff0000" else "#00ff00" },
            ownedBy = { it.calendarId == it.accountEmail }, // b is owned (me@x:me@x)
            acceptedOf = { false },
        )
        assertEquals(1, merged.size)
        assertEquals("me@x", merged[0].primary.calendarId) // prefers own copy
        assertEquals(listOf("#ff0000", "#00ff00"), merged[0].colors)
        assertFalse(merged[0].accepted)
    }

    @Test
    fun `accepted is union across copies`() {
        val a = evt("a1", 0, HOUR_MS, summary = "X", cal = "c1")
        val b = evt("b1", 0, HOUR_MS, summary = "X", cal = "c2")
        val merged = mergeDuplicates(listOf(a, b), { "#000" }, { false }, { it.calendarId == "c2" })
        assertTrue(merged[0].accepted)
    }

    @Test
    fun `distinct events are not merged`() {
        val merged = mergeDuplicates(
            listOf(evt("a", 0, HOUR_MS, "A"), evt("b", 0, HOUR_MS, "B")),
            { "#000" }, { true }, { true },
        )
        assertEquals(2, merged.size)
    }

    // ---- packAllDayBars ----------------------------------------------- //

    @Test
    fun `single-day all-day event spans one column`() {
        val week = utcMidnight(2026, 6, 20) // arbitrary Monday-ish
        val e = evt("a", week, week + DAY_MS) // Google exclusive end
        val bars = packAllDayBars(listOf(e), week, 7)
        assertEquals(1, bars.size)
        assertEquals(0, bars[0].startCol)
        assertEquals(0, bars[0].endCol)
        assertEquals(0, bars[0].row)
    }

    @Test
    fun `multi-day event spans multiple columns`() {
        val week = utcMidnight(2026, 6, 20)
        val e = evt("a", week, week + 3 * DAY_MS) // 3-day span (cols 0..2)
        val bars = packAllDayBars(listOf(e), week, 7)
        assertEquals(0, bars[0].startCol)
        assertEquals(2, bars[0].endCol)
    }

    @Test
    fun `overlapping all-day bars go on separate rows`() {
        val week = utcMidnight(2026, 6, 20)
        val a = evt("a", week, week + 3 * DAY_MS)             // cols 0..2
        val b = evt("b", week + DAY_MS, week + 2 * DAY_MS)    // col 1
        val bars = packAllDayBars(listOf(a, b), week, 7).associateBy { it.event.eventId }
        assertEquals(0, bars["a"]!!.row)
        assertEquals(1, bars["b"]!!.row) // collides with a on col 1 → row 1
    }

    // ---- monthGridDays / addMonthsClamped ----------------------------- //

    @Test
    fun `month grid is always 42 cells Monday-anchored`() {
        val tz = TimeZone.getTimeZone("UTC")
        val days = monthGridDays(2026, 6, tz) // July 2026 (month0=6)
        assertEquals(42, days.size)
        // First cell is a Monday.
        val c = Calendar.getInstance(tz).apply { timeInMillis = days.first() }
        assertEquals(Calendar.MONDAY, c.get(Calendar.DAY_OF_WEEK))
        // July 1 2026 is a Wednesday → grid starts Mon Jun 29.
        assertEquals(Calendar.JUNE, c.get(Calendar.MONTH))
        assertEquals(29, c.get(Calendar.DAY_OF_MONTH))
    }

    @Test
    fun `addMonthsClamped clamps Jan 31 to Feb 28`() {
        val tz = TimeZone.getTimeZone("UTC")
        val jan31 = utcMidnight(2026, 0, 31)
        val feb = addMonthsClamped(jan31, 1, tz)
        val c = Calendar.getInstance(tz).apply { timeInMillis = feb }
        assertEquals(Calendar.FEBRUARY, c.get(Calendar.MONTH))
        assertEquals(28, c.get(Calendar.DAY_OF_MONTH)) // 2026 not a leap year
    }

    // ---- snapToQuarter ------------------------------------------------ //

    @Test
    fun `snapToQuarter rounds to nearest 15 minutes`() {
        assertEquals(0L, snapToQuarter(7 * 60 * 1000L))            // 7min → 0
        assertEquals(QUARTER_MS, snapToQuarter(8 * 60 * 1000L))    // 8min → 15
        assertEquals(QUARTER_MS, snapToQuarter(QUARTER_MS + 1000)) // just past 15 → 15
    }

    @Test
    fun `dayColumn maps instants to their week column`() {
        val week = utcMidnight(2026, 6, 20)
        assertEquals(0, dayColumn(week + HOUR_MS, week))
        assertEquals(2, dayColumn(week + 2 * DAY_MS + HOUR_MS, week))
    }

    private fun utcMidnight(y: Int, m0: Int, d: Int): Long {
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        c.clear(); c.set(y, m0, d, 0, 0, 0)
        return c.timeInMillis
    }
}
