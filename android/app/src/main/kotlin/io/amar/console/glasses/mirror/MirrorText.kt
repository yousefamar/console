package io.amar.console.glasses.mirror

/**
 * Pure text-layout core of the glasses mirror — port of the layout helpers
 * in the SPA's src/glasses/mirror.ts. 5 rows × 40 cols: row 1 status,
 * rows 2–5 body. Kept free of Android deps so it unit-tests on the JVM.
 */
object MirrorText {
    /** Pessimistic-but-safe chars per row (G1 proportional font clips, not
     *  wraps, past its pixel budget; 40 matches EvenDemoApp's even-web). */
    const val DISPLAY_COLS = 40
    const val BODY_ROWS = 4

    data class Frame(val status: String, val body: List<String>)

    fun clipRow(s: String): String {
        val flat = s.replace(Regex("\\s+"), " ").trim()
        return if (flat.length <= DISPLAY_COLS) flat else flat.take(DISPLAY_COLS - 1) + "…"
    }

    /** `Pane · focus · meta` status row from non-null parts. */
    fun buildStatus(parts: List<String?>): String =
        clipRow(parts.filterNotNull().filter { it.isNotEmpty() }.joinToString(" · "))

    /** Composer echo row: `> …tail-of-draft|` (shows the END of the draft —
     *  that's where the user is typing). */
    fun composerRow(text: String): String {
        val flat = text.replace(Regex("\\s+"), " ")
        val budget = DISPLAY_COLS - 3 // "> " prefix + trailing caret
        val tail = if (flat.length > budget) "…" + flat.takeLast(budget - 1) else flat
        return "> $tail|"
    }

    /** Assemble the 5-line payload: status + body padded/clipped to 4 rows. */
    fun assemble(frame: Frame): String {
        val body = frame.body.take(BODY_ROWS).map { clipRow(it) }
        val padded = List(BODY_ROWS - body.size) { "" } + body // bottom-align like the G1 text opcode
        return (listOf(clipRow(frame.status)) + padded).joinToString("\n")
    }

    /** Strip a matrix userId to its local part for readability. */
    fun shortName(name: String): String =
        if (name.startsWith("@")) name.removePrefix("@").substringBefore(':') else name
}
