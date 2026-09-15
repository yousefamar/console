package io.amar.console.ui.cal

import io.amar.console.data.cal.startOfWeek
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

class CalFormatTest {

    private fun ms(y: Int, m0: Int, d: Int): Long {
        val c = Calendar.getInstance()
        c.clear(); c.set(y, m0, d, 0, 0, 0)
        return c.timeInMillis
    }

    private fun row(start: Long, end: Long, allDay: Boolean = false) = io.amar.console.data.db.CalEventRow(
        compoundKey = "k", accountEmail = "a", calendarId = "c", eventId = "e",
        summary = "s", location = null, startTime = start, endTime = end,
        isAllDay = allDay, status = "confirmed", rawJson = "{}",
    )
    private fun at(y: Int, m0: Int, d: Int, h: Int): Long {
        val c = Calendar.getInstance()
        c.clear(); c.set(y, m0, d, h, 0, 0)
        return c.timeInMillis
    }

    @Test
    fun `eventWhenLabel single-day timed event names the day once`() {
        val label = eventWhenLabel(row(at(2026, 8, 11, 16), at(2026, 8, 11, 18)))
        assertEquals("Friday 11 September · 16:00–18:00", label)
    }

    @Test
    fun `eventWhenLabel multi-day timed event names both days`() {
        val label = eventWhenLabel(row(at(2026, 8, 11, 16), at(2026, 8, 13, 15)))
        // Locale.UK renders September as "Sept" on JDK 17+ — assert the shape, not the month token.
        assertTrue(label, label.startsWith("Fri 11 Sep") && label.contains(" 16:00 – Sun 13 Sep") && label.endsWith(" 15:00"))
    }

    @Test
    fun `eventWhenLabel ending at midnight stays single-day`() {
        val label = eventWhenLabel(row(at(2026, 8, 11, 22), at(2026, 8, 12, 0)))
        assertEquals("Friday 11 September · 22:00–00:00", label)
    }

    @Test
    fun `eventWhenLabel all-day`() {
        assertEquals("Friday 11 September · all day", eventWhenLabel(row(at(2026, 8, 11, 0), at(2026, 8, 12, 0), allDay = true)))
    }

    @Test
    fun `weekRangeLabel same-month formats month and day range`() {
        // Monday 2026-07-13 → Sunday 2026-07-19.
        val label = weekRangeLabel(startOfWeek(ms(2026, 6, 15)))
        assertTrue(label, label.contains("July") && label.contains("13") && label.contains("19") && label.contains("2026"))
    }

    @Test
    fun `weekRangeLabel cross-month uses abbreviated months`() {
        // Week containing 2026-07-01 (Wed) → Mon Jun 29 .. Sun Jul 5.
        val label = weekRangeLabel(startOfWeek(ms(2026, 6, 1)))
        assertTrue(label, label.contains("Jun") && label.contains("Jul"))
    }

    @Test
    fun `parseCalColor falls back to blue on garbage`() {
        assertEquals(parseCalColor(null), parseCalColor("not-a-color"))
    }
}
