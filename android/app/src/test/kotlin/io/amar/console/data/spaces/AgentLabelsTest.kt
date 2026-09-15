package io.amar.console.data.spaces

import io.amar.console.data.db.AgentSessionRow
import org.junit.Assert.assertEquals
import org.junit.Test

/** agentLabel / rootAgentKey against the fork naming conventions: ticket-forks
 *  `<name> (fork)` and `con agent chat` forks `<target> ↔ <asker>` (eeb04c82) —
 *  names are display only; lineage resolves through agentKey + parent csid. */
class AgentLabelsTest {

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
    fun `a chat fork named target ↔ asker keeps its name and roots to the target`() {
        val target = row("s1", agentKey = "astera-general", csid = "c1", name = "Astera general")
        val chat = row("s2", agentKey = "astera-general-chat", csid = "c2", parent = "c1", name = "Astera general ↔ Console mobile")
        val all = listOf(target, chat)
        assertEquals("Astera general ↔ Console mobile", agentLabel("astera-general-chat", all))
        assertEquals("astera-general", rootAgentKey("astera-general-chat", all))
        // A dead ticket-fork key still peels back to the live target's name.
        assertEquals("Astera general", agentLabel("astera-general-zany-toad-fork", all))
    }

    @Test
    fun `the legacy fork suffix is stripped for display only`() {
        val root = row("s1", agentKey = "console-general", csid = "c1", name = "Console general")
        val fork = row("s2", agentKey = "console-general-abc-fork", csid = "c2", parent = "c1", name = "Console general (fork)")
        assertEquals("Console general", agentLabel("console-general-abc-fork", listOf(root, fork)))
        assertEquals("console-general", rootAgentKey("console-general-abc-fork", listOf(root, fork)))
    }
}
