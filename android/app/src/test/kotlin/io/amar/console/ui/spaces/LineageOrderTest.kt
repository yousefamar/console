package io.amar.console.ui.spaces

import io.amar.console.data.db.AgentSessionRow
import org.junit.Assert.assertEquals
import org.junit.Test

class LineageOrderTest {

    private fun row(
        id: String,
        agentKey: String? = null,
        csid: String? = null,
        parent: String? = null,
        createdAt: Long = 0,
    ) = AgentSessionRow(
        id = id, name = id, status = "idle",
        hasUnread = false, needsAttention = false, attentionSnippet = null,
        agentKey = agentKey, modelLabel = null, hibernated = false, cwd = null,
        lastCachedIndex = 0, messageLogLength = 0,
        parentClaudeSessionId = parent, claudeSessionId = csid, createdAt = createdAt,
    )

    @Test
    fun `root then forks in creation order, depth-indented`() {
        val root = row("s1", agentKey = "console-general", csid = "c1", createdAt = 1)
        val forkB = row("s3", agentKey = "console-general-b-fork", csid = "c3", parent = "c1", createdAt = 3)
        val forkA = row("s2", agentKey = "console-general-a-fork", csid = "c2", parent = "c1", createdAt = 2)
        val out = lineageOrder(listOf(forkB, root, forkA))
        assertEquals(listOf("s1" to 0, "s2" to 1, "s3" to 1), out.map { it.first.id to it.second })
    }

    @Test
    fun `null-agentKey fork does not recurse into the roots bucket`() {
        // The ^tall-bear crash: children were grouped by the PARENT's agentKey
        // and walked via childrenOf[s.agentKey] — a chat fork with agentKey
        // null looked up the roots bucket and recursed forever (StackOverflow).
        val root = row("s1", agentKey = "console-general", csid = "c1", createdAt = 1)
        val chatFork = row("s2", agentKey = null, csid = "c2", parent = "c1", createdAt = 2)
        val out = lineageOrder(listOf(root, chatFork))
        assertEquals(listOf("s1" to 0, "s2" to 1), out.map { it.first.id to it.second })
    }

    @Test
    fun `duplicate agentKeys stay under their own parents`() {
        val rootA = row("s1", agentKey = "dup", csid = "c1", createdAt = 1)
        val rootB = row("s2", agentKey = "dup", csid = "c2", createdAt = 2)
        val forkOfA = row("s3", agentKey = "dup-fork", csid = "c3", parent = "c1", createdAt = 3)
        val out = lineageOrder(listOf(rootA, rootB, forkOfA))
        assertEquals(listOf("s1" to 0, "s3" to 1, "s2" to 0), out.map { it.first.id to it.second })
    }

    @Test
    fun `orphan and cycle rows still render flat`() {
        // Parent outside the bound set → root; a two-node cycle must not hang.
        val orphan = row("s1", csid = "c1", parent = "elsewhere", createdAt = 1)
        val cycleA = row("s2", csid = "c2", parent = "c3", createdAt = 2)
        val cycleB = row("s3", csid = "c3", parent = "c2", createdAt = 3)
        val out = lineageOrder(listOf(orphan, cycleA, cycleB))
        assertEquals(setOf("s1", "s2", "s3"), out.map { it.first.id }.toSet())
        assertEquals(0, out.first { it.first.id == "s1" }.second)
    }

    @Test
    fun `deep chain indents by depth`() {
        val a = row("s1", csid = "c1", createdAt = 1)
        val b = row("s2", csid = "c2", parent = "c1", createdAt = 2)
        val c = row("s3", csid = "c3", parent = "c2", createdAt = 3)
        val out = lineageOrder(listOf(c, b, a))
        assertEquals(listOf("s1" to 0, "s2" to 1, "s3" to 2), out.map { it.first.id to it.second })
    }
}
