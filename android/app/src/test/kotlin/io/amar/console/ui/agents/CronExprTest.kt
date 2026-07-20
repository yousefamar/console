package io.amar.console.ui.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

class CronExprTest {

    private val utc = TimeZone.getTimeZone("UTC")

    private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int): Long {
        val c = Calendar.getInstance(utc)
        c.clear(); c.set(y, mo - 1, d, h, mi, 0)
        return c.timeInMillis
    }

    @Test
    fun `every 5 minutes`() {
        val runs = CronExpr.nextRuns("*/5 * * * *", at(2026, 7, 20, 10, 2), 3, utc)
        assertEquals(3, runs.size)
        assertEquals(at(2026, 7, 20, 10, 5), runs[0])
        assertEquals(at(2026, 7, 20, 10, 10), runs[1])
    }

    @Test
    fun `daily at fixed time`() {
        val runs = CronExpr.nextRuns("17 7 * * *", at(2026, 7, 20, 10, 0), 2, utc)
        assertEquals(at(2026, 7, 21, 7, 17), runs[0])
        assertEquals(at(2026, 7, 22, 7, 17), runs[1])
    }

    @Test
    fun `weekly monday 9am`() {
        // 2026-07-20 is a Monday; next Monday 09:00 after 10:00 is 2026-07-27.
        val runs = CronExpr.nextRuns("0 9 * * 1", at(2026, 7, 20, 10, 0), 1, utc)
        assertEquals(at(2026, 7, 27, 9, 0), runs[0])
    }

    @Test
    fun `list of hours`() {
        val runs = CronExpr.nextRuns("0 9,17 * * *", at(2026, 7, 20, 10, 0), 2, utc)
        assertEquals(at(2026, 7, 20, 17, 0), runs[0])
        assertEquals(at(2026, 7, 21, 9, 0), runs[1])
    }

    @Test
    fun `validity`() {
        assertTrue(CronExpr.isValid("*/5 * * * *"))
        assertTrue(CronExpr.isValid("0 9 * * 1-5"))
        assertFalse(CronExpr.isValid("* * *"))
        assertFalse(CronExpr.isValid("99 * * * *"))
        assertFalse(CronExpr.isValid("not a cron"))
    }
}
