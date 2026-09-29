package io.amar.console.data.spaces

/** Board display filters — the pure half of the SPA's `HideBlockedToggle`
 *  (src/components/SpacesTab.tsx, ^gold-ant). One hub pref governs every board. */
object BoardFilters {
    /** Hub pref key (boolean, default false) — the SPA's `HIDE_BLOCKED_PREF`. */
    const val HIDE_BLOCKED_PREF = "spaces.hideBlocked"

    /** `#blocked` cards over the columns the board actually shows (Done is
     *  drawn nowhere, so its blocked cards count for nothing). */
    fun blockedCount(board: SpacesRepository.BoardView): Int =
        board.columns
            .filter { !KanbanCodec.DONE_COLUMN_RE.matches(it.title) }
            .sumOf { col -> col.cards.count { it.blocked } }

    /** A column's cards with the blocked ones dropped while the pref is on. */
    fun visibleCards(column: SpacesRepository.BoardColumnView, hideBlocked: Boolean): List<SpacesRepository.CardView> =
        if (hideBlocked) column.cards.filter { !it.blocked } else column.cards

    /** Chip label — `N blocked` / `N blocked hidden`, the SPA's wording. */
    fun chipLabel(count: Int, hideBlocked: Boolean): String =
        "$count blocked" + if (hideBlocked) " hidden" else ""
}
