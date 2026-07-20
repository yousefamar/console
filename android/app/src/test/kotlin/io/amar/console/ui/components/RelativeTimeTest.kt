package io.amar.console.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.text.SimpleDateFormat
import java.util.Locale

class RelativeTimeTest {
    private val now = 1_700_000_000_000L // fixed reference instant
    private val min = 60_000L
    private val hour = 60 * min
    private val day = 24 * hour

    @Test fun `within a minute is now`() {
        assertEquals("now", RelativeTime.format(now, now))
        assertEquals("now", RelativeTime.format(now - 30_000, now))
        assertEquals("now", RelativeTime.format(now + 30_000, now))
    }

    @Test fun `past minutes hours days`() {
        assertEquals("5m", RelativeTime.format(now - 5 * min, now))
        assertEquals("3h", RelativeTime.format(now - 3 * hour, now))
        assertEquals("2d", RelativeTime.format(now - 2 * day, now))
    }

    @Test fun `future gets in-prefix`() {
        assertEquals("in 5m", RelativeTime.format(now + 5 * min, now))
        assertEquals("in 3h", RelativeTime.format(now + 3 * hour, now))
        assertEquals("in 2d", RelativeTime.format(now + 2 * day, now))
    }

    @Test fun `beyond a week falls back to short date`() {
        val future = now + 10 * day
        val expected = RelativeTime.shortDate(future, now)
        assertEquals(expected, RelativeTime.format(future, now))
        // No 'in' prefix on the date form.
        assertTrue(!RelativeTime.format(future, now).startsWith("in "))
    }

    @Test fun `off-year date includes the year`() {
        // ~400 days in the future crosses a year boundary.
        val far = now + 400 * day
        val label = RelativeTime.shortDate(far, now)
        val year = SimpleDateFormat("yyyy", Locale.UK).format(java.util.Date(far))
        assertTrue("expected year in '$label'", label.contains(year))
    }
}
