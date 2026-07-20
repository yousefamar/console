package io.amar.console.ui.agents

import io.amar.console.data.db.AgentSessionRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionTreeTest {

    private fun s(
        id: String, cwd: String? = null, parent: String? = null, csid: String? = null, createdAt: Long = 0,
    ) = AgentSessionRow(
        id = id, name = id, status = "idle", hasUnread = false, needsAttention = false,
        attentionSnippet = null, agentKey = null, modelLabel = null, hibernated = false,
        cwd = cwd, lastCachedIndex = -1, messageLogLength = 0, claudeSessionId = csid,
        parentClaudeSessionId = parent, createdAt = createdAt,
    )

    @Test
    fun `sessions bucket by cwd`() {
        val roots = buildGroupTree(listOf(s("a", "/x"), s("b", "/y")), emptyList())
        assertEquals(setOf("/x", "/y"), roots.map { it.cwd }.toSet())
    }

    @Test
    fun `nested cwd nests under ancestor`() {
        val roots = buildGroupTree(listOf(s("a", "/x"), s("b", "/x/sub")), emptyList())
        assertEquals(1, roots.size)
        assertEquals("/x", roots[0].cwd)
        assertEquals(listOf("/x/sub"), roots[0].children.map { it.cwd })
        assertEquals("sub", roots[0].children[0].label)
    }

    @Test
    fun `peelUniversalRoot promotes single root sessions`() {
        val roots = buildGroupTree(listOf(s("a", "/x"), s("b", "/x/sub")), emptyList())
        val (rootSessions, promoted) = peelUniversalRoot(roots)
        assertEquals(listOf("a"), rootSessions.map { it.id })
        assertEquals(listOf("/x/sub"), promoted.map { it.cwd })
        assertEquals(0, promoted[0].depth)
    }

    @Test
    fun `arrangeLineage nests forks under parent`() {
        val parent = s("p", "/x", csid = "cp")
        val fork = s("f", "/x", parent = "cp", csid = "cf")
        val arranged = arrangeLineage(listOf(parent, fork))
        assertEquals(listOf("p" to 0, "f" to 1), arranged.map { it.first.id to it.second })
    }

    @Test
    fun `flattenSidebar skips collapsed group contents`() {
        val rows = flattenSidebar(listOf(s("a", "/x"), s("b", "/y")), emptyList(), setOf("/y"))
        val sessionIds = rows.filterIsInstance<SidebarRow.Session>().map { it.session.id }
        assertTrue(sessionIds.contains("a"))
        assertTrue(!sessionIds.contains("b")) // /y collapsed
        assertTrue(rows.any { it is SidebarRow.Group && it.node.cwd == "/y" }) // header still shown
    }

    @Test
    fun `sessionOrder controls ordering`() {
        val rows = flattenSidebar(listOf(s("a", "/x"), s("b", "/x")), listOf("b", "a"), emptySet())
        val sessionIds = rows.filterIsInstance<SidebarRow.Session>().map { it.session.id }
        assertEquals(listOf("b", "a"), sessionIds)
    }

    @Test
    fun `no-directory bucket labelled`() {
        val roots = buildGroupTree(listOf(s("a", null)), emptyList())
        assertEquals("(no directory)", roots[0].label)
    }
}
