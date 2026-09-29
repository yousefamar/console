package io.amar.console.data.spaces

import org.junit.Assert.assertEquals
import org.junit.Test

/** Port-parity tests for BoardFilters (SpacesTab.tsx HideBlockedToggle + the
 *  board filter, ^gold-ant). */
class BoardFiltersTest {
    private fun card(text: String, column: String, blocked: Boolean = false) =
        SpacesRepository.CardView(
            text = text, column = column, agentKey = null, blockId = null,
            blocked = blocked, checked = false, detail = emptyList(),
        )

    private fun board(vararg columns: SpacesRepository.BoardColumnView) =
        SpacesRepository.BoardView(project = "console", path = "projects/console/board.md", columns = columns.toList())

    private val backlog = SpacesRepository.BoardColumnView("Backlog", listOf(card("a", "Backlog"), card("b", "Backlog", blocked = true)))
    private val inProgress = SpacesRepository.BoardColumnView("In Progress", listOf(card("c", "In Progress", blocked = true), card("d", "In Progress")))
    private val done = SpacesRepository.BoardColumnView("Done", listOf(card("e", "Done", blocked = true)))

    @Test
    fun `blockedCount spans non-Done columns and ignores Done`() {
        assertEquals(2, BoardFilters.blockedCount(board(backlog, inProgress, done)))
        assertEquals(0, BoardFilters.blockedCount(board(done)))
    }

    @Test
    fun `blockedCount is zero on a board with no blocked cards`() {
        val clean = SpacesRepository.BoardColumnView("Backlog", listOf(card("a", "Backlog")))
        assertEquals(0, BoardFilters.blockedCount(board(clean)))
    }

    @Test
    fun `visibleCards drops blocked cards only while the pref is on`() {
        assertEquals(listOf("c", "d"), BoardFilters.visibleCards(inProgress, hideBlocked = false).map { it.text })
        assertEquals(listOf("d"), BoardFilters.visibleCards(inProgress, hideBlocked = true).map { it.text })
    }

    @Test
    fun `visibleCards keeps order and is a no-op on an unblocked column`() {
        val col = SpacesRepository.BoardColumnView("Backlog", listOf(card("x", "Backlog"), card("y", "Backlog")))
        assertEquals(col.cards, BoardFilters.visibleCards(col, hideBlocked = true))
    }

    @Test
    fun `chipLabel mirrors the SPA wording`() {
        assertEquals("3 blocked", BoardFilters.chipLabel(3, hideBlocked = false))
        assertEquals("1 blocked hidden", BoardFilters.chipLabel(1, hideBlocked = true))
    }
}
