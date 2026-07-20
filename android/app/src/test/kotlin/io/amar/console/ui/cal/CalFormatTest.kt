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
