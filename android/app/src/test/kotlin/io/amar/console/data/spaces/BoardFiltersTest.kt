package io.amar.console.data.spaces

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port-parity tests for BoardFilters (SpacesTab.tsx ColumnBlockedToggle + the
 *  per-column board filter, ^cool-crow). */
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

    /** A prefs object holding the map, as the hub serves it. */
    private fun prefsWith(vararg hidden: Pair<String, Boolean>) = buildJsonObject {
        put(BoardFilters.HIDE_BLOCKED_PREF, JsonObject(hidden.toMap().mapValues { JsonPrimitive(it.value) }))
    }

    @Test
    fun `blockedCount per column counts that column alone`() {
        assertEquals(1, BoardFilters.blockedCount(backlog))
        assertEquals(1, BoardFilters.blockedCount(inProgress))
        assertEquals(0, BoardFilters.blockedCount(SpacesRepository.BoardColumnView("Clean", listOf(card("x", "Clean")))))
    }

    @Test
    fun `board-wide blockedCount spans non-Done columns and ignores Done`() {
        assertEquals(2, BoardFilters.blockedCount(board(backlog, inProgress, done)))
        assertEquals(0, BoardFilters.blockedCount(board(done)))
    }

    @Test
    fun `hiddenColumns takes the true keys only`() {
        val prefs = prefsWith("Backlog" to true, "In Progress" to false, "Review" to true)
        assertEquals(setOf("Backlog", "Review"), BoardFilters.hiddenColumns(prefs))
    }

    @Test
    fun `hiddenColumns is empty when the pref is absent or malformed`() {
        assertEquals(emptySet<String>(), BoardFilters.hiddenColumns(JsonObject(emptyMap())))
        // a leftover boolean on the NEW key (hand-edited /config) must not throw
        val bogus = buildJsonObject { put(BoardFilters.HIDE_BLOCKED_PREF, true) }
        assertEquals(emptySet<String>(), BoardFilters.hiddenColumns(bogus))
    }

    @Test
    fun `visibleCards drops blocked cards in hidden columns only`() {
        val hidden = setOf("In Progress")
        assertEquals(listOf("d"), BoardFilters.visibleCards(inProgress, hidden).map { it.text })
        // same board, a column NOT in the set keeps its blocked card
        assertEquals(listOf("a", "b"), BoardFilters.visibleCards(backlog, hidden).map { it.text })
    }

    @Test
    fun `visibleCards keeps order and is a no-op on an unblocked column`() {
        val col = SpacesRepository.BoardColumnView("Backlog", listOf(card("x", "Backlog"), card("y", "Backlog")))
        assertEquals(col.cards, BoardFilters.visibleCards(col, setOf("Backlog")))
    }

    @Test
    fun `visibleCards with nothing hidden shows everything`() {
        assertEquals(listOf("c", "d"), BoardFilters.visibleCards(inProgress, emptySet()).map { it.text })
    }

    @Test
    fun `chipLabel mirrors the SPA wording`() {
        assertEquals("3 blocked", BoardFilters.chipLabel(3))
        assertEquals("1 blocked", BoardFilters.chipLabel(1))
    }

    @Test
    fun `withColumn flips one key and leaves the rest of the map alone`() {
        val prefs = prefsWith("Backlog" to true, "In Progress" to false)
        val next = BoardFilters.withColumn(prefs, "In Progress", true)
        assertEquals(true, (next["Backlog"] as JsonPrimitive).booleanOrNull)
        assertEquals(true, (next["In Progress"] as JsonPrimitive).booleanOrNull)
        // and un-hiding writes false rather than dropping the key
        val off = BoardFilters.withColumn(prefsWith("Backlog" to true), "Backlog", false)
        assertEquals(false, (off["Backlog"] as JsonPrimitive).booleanOrNull)
        assertEquals(emptySet<String>(), BoardFilters.hiddenColumns(buildJsonObject { put(BoardFilters.HIDE_BLOCKED_PREF, off) }))
    }

    @Test
    fun `withColumn starts a map when the pref is absent`() {
        val next = BoardFilters.withColumn(JsonObject(emptyMap()), "Backlog", true)
        assertEquals(setOf("Backlog"), next.keys)
    }

    @Test
    fun `legacyMigration seeds every current column from a leftover true, once`() {
        val legacy = buildJsonObject { put(BoardFilters.LEGACY_HIDE_BLOCKED_PREF, true) }
        val patch = BoardFilters.legacyMigration(legacy, listOf("Backlog", "In Progress"))!!
        val map = patch[BoardFilters.HIDE_BLOCKED_PREF]!!.jsonObject
        assertEquals(setOf("Backlog", "In Progress"), map.keys)
        assertTrue(map.values.all { (it as JsonPrimitive).booleanOrNull == true })
        // the old key is retired in the same PUT, so this can never fire twice
        assertEquals(false, (patch[BoardFilters.LEGACY_HIDE_BLOCKED_PREF] as JsonPrimitive).booleanOrNull)
        assertNull(BoardFilters.legacyMigration(JsonObject(legacy + patch), listOf("Backlog")))
    }

    @Test
    fun `legacyMigration is a no-op without a leftover true, or once the map exists`() {
        assertNull(BoardFilters.legacyMigration(JsonObject(emptyMap()), listOf("Backlog")))
        assertNull(BoardFilters.legacyMigration(buildJsonObject { put(BoardFilters.LEGACY_HIDE_BLOCKED_PREF, false) }, listOf("Backlog")))
        val both = buildJsonObject {
            put(BoardFilters.LEGACY_HIDE_BLOCKED_PREF, true)
            put(BoardFilters.HIDE_BLOCKED_PREF, JsonObject(mapOf("Backlog" to JsonPrimitive(false))))
        }
        assertNull(BoardFilters.legacyMigration(both, listOf("Backlog")))
        // no columns yet (board still loading) — wait rather than seed nothing
        assertNull(BoardFilters.legacyMigration(buildJsonObject { put(BoardFilters.LEGACY_HIDE_BLOCKED_PREF, true) }, emptyList()))
    }
}
