package io.amar.console.ui.spaces

import io.amar.console.data.notes.BlogRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DevlogLogicTest {
    private fun draft(path: String, project: String? = null, tags: List<String> = emptyList()) =
        BlogRepository.Draft(path = path, title = path, mtime = 0L, project = project, tags = tags)
    private fun post(path: String) =
        BlogRepository.Post(path = path, title = path, date = null, mtime = 0L, project = null, tags = emptyList())

    private val drafts = listOf(
        draft("projects/console/log/drafts/a.md", project = "console"),
        draft("scratch/blog-drafts/b.md", project = "console", tags = listOf("ai")), // frontmatter-claimed
        draft("log/drafts/c.md", tags = listOf("ai", "health")),
        draft("log/drafts/d.md", tags = listOf("health")),
        draft("projects/ai/log/drafts/e.md", project = "ai", tags = listOf("ai")), // project slug == area slug
    )

    @Test
    fun `project drafts match on project, path- or frontmatter-claimed`() {
        assertEquals(
            listOf("projects/console/log/drafts/a.md", "scratch/blog-drafts/b.md"),
            DevlogLogic.draftsFor(drafts, "console", "project").map { it.path },
        )
    }

    @Test
    fun `area drafts match on tag and exclude the same-named project's own drafts`() {
        assertEquals(
            listOf("scratch/blog-drafts/b.md", "log/drafts/c.md"),
            DevlogLogic.draftsFor(drafts, "ai", "area").map { it.path },
        )
        assertEquals(listOf("log/drafts/c.md", "log/drafts/d.md"), DevlogLogic.draftsFor(drafts, "health", "area").map { it.path })
    }

    @Test
    fun `shortDate keeps the calendar day only`() {
        assertEquals("2026-09-05", DevlogLogic.shortDate("2026-09-05 10:00:00"))
        assertEquals("2026-09-05", DevlogLogic.shortDate("2026-09-05T10:00:00.000Z"))
        assertEquals("2026-09-05", DevlogLogic.shortDate("2026-09-05"))
        assertNull(DevlogLogic.shortDate(""))
        assertNull(DevlogLogic.shortDate(null))
        assertNull(DevlogLogic.shortDate("2026"))
    }

    @Test
    fun `count is null until posts are known and nothing is drafted`() {
        assertNull(DevlogLogic.count(emptyList(), null))
        assertEquals(1, DevlogLogic.count(listOf(draft("x.md")), null))
        assertEquals(0, DevlogLogic.count(emptyList(), emptyList()))
        assertEquals(3, DevlogLogic.count(listOf(draft("x.md")), listOf(post("p1"), post("p2"))))
    }
}
