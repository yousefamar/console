package io.amar.console.data.spaces

import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.NoteFileRow
import io.amar.console.data.spaces.SpacesSwitcher.Kind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure port of SPA SpacesQuickSwitcher.tsx: entry build, recency, fuzzyScore. */
class SpacesSwitcherTest {
    private fun session(
        id: String, name: String, project: String? = null, areas: String? = null,
        status: String = "idle", createdAt: Long = 0, lastActivityAt: Long = 0, parent: String? = null,
    ) = AgentSessionRow(
        id = id, name = name, status = status, hasUnread = false, needsAttention = false,
        attentionSnippet = null, agentKey = null, modelLabel = null, hibernated = false, cwd = null,
        lastCachedIndex = 0, messageLogLength = 0, parentClaudeSessionId = parent,
        createdAt = createdAt, lastActivityAt = lastActivityAt, project = project, areasCsv = areas,
    )

    private fun file(path: String, mtime: Long) = NoteFileRow(
        path = path, name = path.substringAfterLast('/'), dir = path.substringBeforeLast('/', ""),
        mtime = mtime, size = 0, cachedContent = null, contentMtime = null,
    )

    private fun space(kind: String, slug: String, title: String = slug) = SpacesRepository.SpaceSummary(
        kind = kind, slug = slug, title = title, notePath = null, boardPath = null, status = null, fileCount = 0,
    )

    // --- fuzzyScore (SPA semantics: lower = better, -1 = miss) ---

    @Test fun `contiguous substring scores its index`() {
        assertEquals(0, SpacesSwitcher.fuzzyScore("console board", "con"))
        assertEquals(8, SpacesSwitcher.fuzzyScore("console board", "board"))
    }

    @Test fun `scattered subsequence scores 1000 plus first hit and always loses to a substring`() {
        val sub = SpacesSwitcher.fuzzyScore("console board", "cb") // c…b
        assertEquals(1000, sub)
        assertTrue(SpacesSwitcher.fuzzyScore("zzzz console", "console") < sub)
    }

    @Test fun `no subsequence is a miss`() {
        assertEquals(-1, SpacesSwitcher.fuzzyScore("console", "xyz"))
        assertEquals(-1, SpacesSwitcher.fuzzyScore("ab", "ba"))
    }

    // --- build ---

    @Test fun `ended sessions are excluded and forks flagged`() {
        val entries = SpacesSwitcher.build(
            spaces = emptyList(),
            sessions = listOf(
                session("a", "Live one", status = "idle"),
                session("b", "Dead one", status = "ended"),
                session("c", "Child (fork)", parent = "csid-a"),
            ),
            files = emptyList(),
        )
        assertEquals(listOf("s:a", "s:c"), entries.map { it.key })
        assertEquals("Child", entries[1].title)
        assertTrue(entries[1].isFork)
        assertFalse(entries[0].isFork)
    }

    @Test fun `a space inherits the recency of its most recent session or file`() {
        val entries = SpacesSwitcher.build(
            spaces = listOf(space("project", "console"), space("area", "health"), space("project", "quiet")),
            sessions = listOf(
                session("a", "Console general", project = "console", createdAt = 10, lastActivityAt = 50),
                session("b", "Yoga", areas = "health,fitness", createdAt = 70),
            ),
            files = listOf(file("projects/console/board.md", 90), file("projects/quiet.md", 5)),
        )
        val bySlug = entries.filter { it.kind != Kind.SESSION && it.kind != Kind.FILE }.associateBy { it.target }
        assertEquals(90L, bySlug["project/console"]!!.recency) // file mtime beats session activity
        assertEquals(70L, bySlug["area/health"]!!.recency)     // first area of the session's list
        assertEquals(5L, bySlug["project/quiet"]!!.recency)    // flat project note
        assertEquals("console", entries.first { it.key == "s:a" }.hint)
        assertEquals("health", entries.first { it.key == "s:b" }.hint)
    }

    @Test fun `session recency is the later of activity and creation`() {
        val e = SpacesSwitcher.build(emptyList(), listOf(session("a", "x", createdAt = 40, lastActivityAt = 20)), emptyList())
        assertEquals(40L, e.single().recency)
    }

    @Test fun `running set marks entries`() {
        val e = SpacesSwitcher.build(emptyList(), listOf(session("a", "x"), session("b", "y")), emptyList(), running = setOf("b"))
        assertFalse(e[0].running)
        assertTrue(e[1].running)
    }

    @Test fun `projectSlugOf reads folder and flat shapes only`() {
        assertEquals("console", SpacesSwitcher.projectSlugOf("projects/console/board.md"))
        assertEquals("quiet", SpacesSwitcher.projectSlugOf("projects/quiet.md"))
        assertEquals(null, SpacesSwitcher.projectSlugOf("scratch/lists/movies.md"))
    }

    // --- rank ---

    @Test fun `empty query is pure recency order capped at 40`() {
        val files = (1..60).map { file("scratch/n$it.md", it.toLong()) }
        val ranked = SpacesSwitcher.rank(SpacesSwitcher.build(emptyList(), emptyList(), files), "")
        assertEquals(SpacesSwitcher.RESULT_CAP, ranked.size)
        assertEquals("scratch/n60.md", ranked.first().target)
        assertEquals("scratch/n21.md", ranked.last().target)
    }

    @Test fun `query ranks by score then recency and matches the hint too`() {
        val entries = SpacesSwitcher.build(
            spaces = listOf(space("project", "console", "Console")),
            sessions = listOf(
                session("old", "Console general", project = "console", lastActivityAt = 10),
                session("new", "Console mobile", project = "console", lastActivityAt = 20),
                session("hint", "Mobile app", project = "console", lastActivityAt = 99),
            ),
            files = listOf(file("scratch/unrelated.md", 500)),
        )
        val ranked = SpacesSwitcher.rank(entries, "console")
        // Title matches at index 0 tie on score → recency decides (the space
        // inherited 99 from its newest session); the hint-only match ("Mobile
        // app console", score 11) sits behind them; the unrelated file is dropped.
        assertEquals(listOf("sp:console", "s:new", "s:old", "s:hint"), ranked.map { it.key })
    }

    @Test fun `query is case-insensitive and trimmed`() {
        val entries = SpacesSwitcher.build(listOf(space("project", "demovid", "DemoVid")), emptyList(), emptyList())
        assertEquals(1, SpacesSwitcher.rank(entries, "  DEMO ").size)
    }
}
