package io.amar.console.ui.spaces

import io.amar.console.data.db.AgentSessionRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** rootOf (assignee-filter grouping) + defaultAgent (space open preselect) —
 *  SPA parity: SpacesTab.tsx rootOf / store/spaces.ts selectDefaultAgent. */
class RootOfTest {

    private fun row(
        id: String,
        agentKey: String? = null,
        csid: String? = null,
        parent: String? = null,
        name: String = id,
        status: String = "idle",
    ) = AgentSessionRow(
        id = id, name = name, status = status,
        hasUnread = false, needsAttention = false, attentionSnippet = null,
        agentKey = agentKey, modelLabel = null, hibernated = false, cwd = null,
        lastCachedIndex = 0, messageLogLength = 0,
        parentClaudeSessionId = parent, claudeSessionId = csid,
    )

    @Test
    fun `live fork resolves through parent lineage to its root`() {
        val root = row("s1", agentKey = "console-general", csid = "c1")
        val fork = row("s2", agentKey = "console-general-abc123-fork", csid = "c2", parent = "c1")
        val deep = row("s3", agentKey = "console-general-abc123-fork-2", csid = "c3", parent = "c2")
        val all = listOf(root, fork, deep)
        assertEquals("console-general", rootOf("console-general-abc123-fork", all))
        assertEquals("console-general", rootOf("console-general-abc123-fork-2", all))
        assertEquals("console-general", rootOf("console-general", all))
    }

    @Test
    fun `dead fork key peels back to the live source key`() {
        val root = row("s1", agentKey = "new-mobile-app", csid = "c1")
        // No live session for the fork key — strip -fork then trailing segments.
        assertEquals("new-mobile-app", rootOf("new-mobile-app-ripe-heron-fork", listOf(root)))
        assertEquals("new-mobile-app", rootOf("new-mobile-app-x1-fork-3", listOf(root)))
    }

    @Test
    fun `unresolvable key groups under itself, null stays null`() {
        assertEquals("ghost-key", rootOf("ghost-key", emptyList()))
        assertNull(rootOf(null, emptyList()))
    }

    @Test
    fun `defaultAgent resolution order`() {
        val general = row("s1", agentKey = "console-general", csid = "c1", name = "Console general")
        val other = row("s2", agentKey = "console-maps", csid = "c2", name = "Maps")
        val fork = row("s3", agentKey = "console-general-z9-fork", csid = "c3", parent = "c1")
        // default_owner wins.
        assertEquals("s2", defaultAgent(listOf(general, other, fork), "console-maps")?.id)
        // No owner → 'general' suffix wins over first-by-key.
        assertEquals("s1", defaultAgent(listOf(general, other, fork), null)?.id)
        // Single non-fork → it.
        assertEquals("s2", defaultAgent(listOf(other, fork), null)?.id)
        // Forks only → first fork rather than nothing.
        assertEquals("s3", defaultAgent(listOf(fork), null)?.id)
    }
}
