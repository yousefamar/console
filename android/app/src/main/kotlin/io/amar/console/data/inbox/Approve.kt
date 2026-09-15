package io.amar.console.data.inbox

import io.amar.console.data.spaces.SpacesRepository.ReviewHandback

// Approving a review hand-back from the Inbox = moving the agent's Under
// Review card(s) to the board's Done column. Shared by the agent screen's
// "Approve → Done" strip and swipe-done on an agent row, so both surfaces
// mean the same thing (port of src/inbox/approve.ts).

data class ApproveOutcome(
    /** Hand-backs actually moved to Done. */
    val moved: List<ReviewHandback>,
    /** Hand-backs whose board has no Done column — nothing to move them to. */
    val skipped: List<ReviewHandback>,
    /** First failure, if a move failed; later hand-backs are left untouched. */
    val failed: ReviewHandback? = null,
)

/** Move every approvable hand-back to Done, in order, stopping at the first
 *  failure (a half-approved batch is visible on the board; a silently
 *  swallowed error is not). [move] returns false on failure. */
suspend fun approveHandbacks(
    handbacks: List<ReviewHandback>,
    move: suspend (project: String, query: String, toColumn: String) -> Boolean,
): ApproveOutcome {
    val moved = ArrayList<ReviewHandback>()
    val skipped = ArrayList<ReviewHandback>()
    for (h in handbacks) {
        val col = h.doneColumn
        if (col == null) { skipped += h; continue }
        if (move(h.project, h.query, col)) moved += h
        else return ApproveOutcome(moved, skipped, failed = h)
    }
    return ApproveOutcome(moved, skipped)
}
