package io.amar.console.data.spaces

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Board display filters — the pure half of the SPA's `ColumnBlockedToggle`
 *  (src/components/SpacesTab.tsx, ^cool-crow). One hub pref, a column-title →
 *  bool map, governs every board: a column name behaves the same wherever it
 *  appears, and each column's chip shows only while that column has a blocked
 *  card (with none there is nothing to hide; a key left on stays effective
 *  silently until the next card blocks). */
object BoardFilters {
    /** Hub pref key — `Record<columnTitle, boolean>`, the SPA's `HIDE_BLOCKED_PREF`. */
    const val HIDE_BLOCKED_PREF = "spaces.hideBlockedColumns"

    /** The retired board-wide boolean (^gold-ant). Read once for the migration
     *  below, never written as `true` again. */
    const val LEGACY_HIDE_BLOCKED_PREF = "spaces.hideBlocked"

    /** Column titles whose blocked cards are hidden — the `true` keys of the map. */
    fun hiddenColumns(prefs: JsonObject): Set<String> =
        (prefs[HIDE_BLOCKED_PREF] as? JsonObject)
            ?.filterValues { (it as? JsonPrimitive)?.booleanOrNull == true }
            ?.keys ?: emptySet()

    /** `#blocked` cards in one column — what its chip counts. */
    fun blockedCount(column: SpacesRepository.BoardColumnView): Int =
        column.cards.count { it.blocked }

    /** `#blocked` cards over the columns the board actually shows (Done is
     *  drawn nowhere, so its blocked cards count for nothing). */
    fun blockedCount(board: SpacesRepository.BoardView): Int =
        board.columns
            .filter { !KanbanCodec.DONE_COLUMN_RE.matches(it.title) }
            .sumOf { blockedCount(it) }

    /** A column's cards with the blocked ones dropped while its title is hidden. */
    fun visibleCards(column: SpacesRepository.BoardColumnView, hidden: Set<String>): List<SpacesRepository.CardView> =
        if (column.title in hidden) column.cards.filter { !it.blocked } else column.cards

    /** Chip label — `N blocked`, the SPA's wording (the eye glyph + tint say
     *  whether they are shown). */
    fun chipLabel(count: Int): String = "$count blocked"

    /** The map with one column flipped — what `setHideBlocked` PUTs (the hub's
     *  `/config` merge is shallow, so the whole map travels). */
    fun withColumn(prefs: JsonObject, column: String, hide: Boolean): JsonObject {
        val current = (prefs[HIDE_BLOCKED_PREF] as? JsonObject) ?: JsonObject(emptyMap())
        return JsonObject(current + (column to JsonPrimitive(hide)))
    }

    /** One-shot migration off the retired boolean: a leftover `true` with no
     *  map yet seeds every current column title, and the old key is set to
     *  `false` in the same PUT so this never fires again (`/config` cannot
     *  delete a key). Null = nothing to migrate. */
    fun legacyMigration(prefs: JsonObject, columnTitles: List<String>): JsonObject? {
        val legacy = (prefs[LEGACY_HIDE_BLOCKED_PREF] as? JsonPrimitive)?.booleanOrNull ?: false
        if (!legacy || prefs.containsKey(HIDE_BLOCKED_PREF) || columnTitles.isEmpty()) return null
        return buildJsonObject {
            put(HIDE_BLOCKED_PREF, JsonObject(columnTitles.associateWith { JsonPrimitive(true) }))
            put(LEGACY_HIDE_BLOCKED_PREF, false)
        }
    }
}
