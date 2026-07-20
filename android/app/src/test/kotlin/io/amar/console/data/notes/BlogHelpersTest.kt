package io.amar.console.data.notes

import org.junit.Assert.assertEquals
import org.junit.Test

class BlogHelpersTest {
    private val day = 86_400_000L

    @Test
    fun `formatAge buckets`() {
        assertEquals("just now", BlogHelpers.formatAge(1000))
        assertEquals("3h ago", BlogHelpers.formatAge(3 * 3600_000L))
        assertEquals("5d ago", BlogHelpers.formatAge(5 * day))
        assertEquals("2mo ago", BlogHelpers.formatAge(60 * day))
        assertEquals("1.5y ago", BlogHelpers.formatAge((547.5 * day).toLong()))
    }

    @Test
    fun `ageSeverity thresholds`() {
        assertEquals(BlogHelpers.AgeSeverity.FRESH, BlogHelpers.ageSeverity(2 * day))
        assertEquals(BlogHelpers.AgeSeverity.WARN, BlogHelpers.ageSeverity(10 * day))
        assertEquals(BlogHelpers.AgeSeverity.STALE, BlogHelpers.ageSeverity(40 * day))
    }

    @Test
    fun `postDateLabel takes first token`() {
        assertEquals("2026-07-20", BlogHelpers.postDateLabel("2026-07-20 12:00:00"))
        assertEquals("(no date)", BlogHelpers.postDateLabel(null))
        assertEquals("(no date)", BlogHelpers.postDateLabel("  "))
    }

    @Test
    fun `humaniseSlug title-cases words`() {
        assertEquals("Where To Move", BlogHelpers.humaniseSlug("where-to-move"))
        assertEquals("My Project", BlogHelpers.humaniseSlug("my_project"))
    }

    @Test
    fun `sortProjects active first then by recency`() {
        val projects = listOf(
            BlogRepository.Project("a", "A", "", "dormant", 100, null),
            BlogRepository.Project("b", "B", "", "active", 50, null),
            BlogRepository.Project("c", "C", "", "active", 200, null),
        )
        val sorted = BlogHelpers.sortProjects(projects).map { it.slug }
        assertEquals(listOf("c", "b", "a"), sorted)
    }
}
