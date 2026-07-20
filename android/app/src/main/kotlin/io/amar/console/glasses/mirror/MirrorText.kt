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

    /**
     * Hard-wrap [text] into rows of at most [cols] chars, preferring a word
     * boundary in the right half of the window (`spaceIdx > width/2`) so words
     * aren't split mid-character; else hard-splits. First row optionally gets
     * [firstPrefix]; continuation rows get [contPrefix] (usually equal-width
     * spaces for gutter alignment). Port of src/glasses/mirror.ts wrapLine.
     * Operates on raw text (no whitespace-flatten) so the notes cursor-follow
     * window keeps its column math.
     */
    fun wrapLine(
        text: String,
        firstPrefix: String = "",
        contPrefix: String = "",
        cols: Int = DISPLAY_COLS,
    ): List<String> {
        val widthFirst = maxOf(1, cols - firstPrefix.length)
        val widthCont = maxOf(1, cols - contPrefix.length)
        if (text.isEmpty()) return listOf(firstPrefix)
        val rows = ArrayList<String>()
        var remaining = text
        var first = true
        while (remaining.isNotEmpty()) {
            val prefix = if (first) firstPrefix else contPrefix
            val width = if (first) widthFirst else widthCont
            if (remaining.length <= width) {
                rows.add(prefix + remaining)
                break
            }
            // lastIndexOf(' ', width) — last space at or before index `width`.
            val spaceIdx = remaining.lastIndexOf(' ', width)
            val breakIdx = if (spaceIdx > width / 2) spaceIdx else width
            rows.add(prefix + remaining.substring(0, breakIdx))
            remaining = remaining.substring(if (spaceIdx > width / 2) breakIdx + 1 else breakIdx)
            first = false
        }
        return rows
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

    /**
     * Pad/clip a body to exactly [BODY_ROWS]. Bottom-biased: on overflow the
     * NEWEST rows (the tail) survive, older rows drop off the top; on underflow
     * blanks are unshifted on top. Mirrors src/glasses/mirror.ts padBottom.
     */
    fun padBottom(rows: List<String>): List<String> {
        val out = rows.takeLast(BODY_ROWS).map { clipRow(it) }.toMutableList()
        while (out.size < BODY_ROWS) out.add(0, "")
        return out
    }

    /** Assemble the 5-line payload: status + body padded/clipped to 4 rows. */
    fun assemble(frame: Frame): String =
        (listOf(clipRow(frame.status)) + padBottom(frame.body)).joinToString("\n")

    /** Strip a matrix userId to its local part for readability. */
    fun shortName(name: String): String =
        if (name.startsWith("@")) name.removePrefix("@").substringBefore(':') else name
}
