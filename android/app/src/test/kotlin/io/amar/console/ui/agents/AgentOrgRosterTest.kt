package io.amar.console.ui.agents

import io.amar.console.data.agents.AgentsRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentOrgRosterTest {

    private fun role(key: String, manager: String? = null, folder: Boolean = false, title: String = key) =
        AgentsRepository.AgentRole(key, title, manager, emptyList(), null, "", folder, false)

    @Test
    fun `al is root with nested reports`() {
        val roles = listOf(role("al"), role("worker", manager = "al"), role("deep", manager = "worker"))
        val roster = buildRoster(roles)
        assertEquals(listOf("al", "worker", "deep"), roster.map { it.role.key })
        assertEquals(listOf(0, 1, 2), roster.map { it.depth })
    }

    @Test
    fun `managerless role hangs under al`() {
        val roles = listOf(role("al"), role("orphan"))
        val roster = buildRoster(roles)
        assertEquals(listOf("al", "orphan"), roster.map { it.role.key })
        assertEquals(1, roster.first { it.role.key == "orphan" }.depth)
    }

    @Test
    fun `dangling manager is annotated and hung under al`() {
        val roles = listOf(role("al"), role("x", manager = "ghost"))
        val roster = buildRoster(roles)
        val x = roster.first { it.role.key == "x" }
        assertEquals("ghost", x.danglingManager)
        assertEquals(1, x.depth)
    }

    @Test
    fun `cycle is broken to top level`() {
        val roles = listOf(role("al"), role("a", manager = "b"), role("b", manager = "a"))
        val roster = buildRoster(roles)
        // Neither a nor b resolves a valid manager (cycle) → both under al.
        assertEquals(3, roster.size)
        assertTrue(roster.all { it.danglingManager == null })
    }

    @Test
    fun `folders sort before agents within a level`() {
        val roles = listOf(
            role("al"),
            role("zeta-agent", manager = "al", title = "Zeta"),
            role("proj", manager = "al", folder = true, title = "Proj"),
        )
        val roster = buildRoster(roles).filter { it.depth == 1 }
        assertEquals(listOf("proj", "zeta-agent"), roster.map { it.role.key })
    }

    @Test
    fun `empty roles yields empty roster`() {
        assertTrue(buildRoster(emptyList()).isEmpty())
    }
}
