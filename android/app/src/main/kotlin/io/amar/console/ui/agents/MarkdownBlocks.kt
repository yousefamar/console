package io.amar.console.ui.agents

// Line-level block segmentation for the transcript's markdown-lite renderer —
// a verbatim port of src/agents/markdown-blocks.ts (KEEP IN SYNC). Pure (no
// Compose) so it is plain-JUnit testable; TranscriptBlocks.kt renders the
// segments. Adding a block construct = a new segment kind HERE, not another
// startsWith in the renderer (the SPA rule).

object MarkdownBlocks {
    data class ListItem(
        /** Nesting depth from leading indentation (2 spaces or a tab per level). */
        val depth: Int,
        val ordered: Boolean,
        /** The written number of an ordered item (`3.` → 3). */
        val num: Int? = null,
        /** `- [ ]` / `- [x]` task boxes; null for plain bullets. */
        val checked: Boolean? = null,
        val text: String,
    )

    sealed interface Segment {
        data class Text(val lines: List<String>) : Segment
        data class Table(val header: String, val body: List<String>) : Segment
        /** `lines` come back with ONE `>` level removed — recurse for nesting. */
        data class Quote(val lines: List<String>) : Segment
        data class Heading(val level: Int, val text: String) : Segment
        data class ListBlock(val items: List<ListItem>) : Segment
    }

    private val TABLE_SEP_RE = Regex("""^\s*\|?\s*[-:]+[-| :]*$""")
    private val QUOTE_RE = Regex("""^ {0,3}>(?: ?(.*))?$""")
    private val HEADING_RE = Regex("""^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$""")
    // `- item`, `* item`, `+ item`, `1. item`, `1) item`, optional `[ ]`/`[x]` task box.
    private val LIST_RE = Regex("""^([ \t]*)(?:([-*+])|(\d{1,3})[.)])\s+(?:\[([ xX])]\s+)?(.*)$""")
    private val CONTINUATION_RE = Regex("""^(?: {2,}|\t)\S""")

    fun parseListItem(line: String): ListItem? {
        val m = LIST_RE.find(line) ?: return null
        val indent = m.groupValues[1].replace("\t", "  ").length
        val num = m.groupValues[3].takeIf { it.isNotEmpty() }?.toInt()
        // groups() is null for an unmatched optional group; groupValues gives "".
        val box = m.groups[4]?.value
        return ListItem(
            depth = indent / 2,
            ordered = num != null,
            num = num,
            checked = if (box == null) null else box != " ",
            text = m.groupValues[5],
        )
    }

    fun parseHeading(line: String): Segment.Heading? {
        val m = HEADING_RE.find(line) ?: return null
        return Segment.Heading(m.groupValues[1].length, m.groupValues[2])
    }

    private fun tableStartsAt(lines: List<String>, i: Int): Boolean =
        lines[i].contains('|') && i + 1 < lines.size && TABLE_SEP_RE.matches(lines[i + 1])

    /** Strip ONE `>` level from a quoted line; nested quotes keep their inner `>`. */
    fun unquoteLine(line: String): String {
        val m = QUOTE_RE.find(line) ?: return line
        return m.groups[1]?.value ?: ""
    }

    fun isQuoteLine(line: String): Boolean = QUOTE_RE.matches(line)

    /** Split non-code-fence text into table / blockquote / heading / list /
     *  plain-text runs. A blockquote is a maximal run of `>`-prefixed lines
     *  with one `>` level removed (recurse for nesting). A list is a maximal
     *  run of list-item lines; a continuation line indented under an item is
     *  folded into that item's text. */
    fun segmentBlocks(text: String): List<Segment> {
        val lines = text.split("\n")
        val out = ArrayList<Segment>()
        var i = 0
        fun startsBlock(k: Int): Boolean =
            tableStartsAt(lines, k) || isQuoteLine(lines[k]) || parseHeading(lines[k]) != null || parseListItem(lines[k]) != null
        while (i < lines.size) {
            val heading = parseHeading(lines[i])
            val item = parseListItem(lines[i])
            when {
                heading != null -> { out += heading; i++ }
                item != null -> {
                    val items = arrayListOf(item)
                    i++
                    while (i < lines.size) {
                        val next = parseListItem(lines[i])
                        if (next != null) { items += next; i++; continue }
                        // Indented continuation of the previous item (not blank, not a new block).
                        if (CONTINUATION_RE.containsMatchIn(lines[i]) && !startsBlock(i)) {
                            val last = items.removeAt(items.size - 1)
                            items += last.copy(text = last.text + " " + lines[i].trim())
                            i++; continue
                        }
                        break
                    }
                    out += Segment.ListBlock(items)
                }
                tableStartsAt(lines, i) -> {
                    val header = lines[i]
                    i += 2
                    val body = ArrayList<String>()
                    while (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) body += lines[i++]
                    out += Segment.Table(header, body)
                }
                isQuoteLine(lines[i]) -> {
                    val quoted = ArrayList<String>()
                    while (i < lines.size && isQuoteLine(lines[i])) quoted += unquoteLine(lines[i++])
                    out += Segment.Quote(quoted)
                }
                else -> {
                    val start = i
                    while (i < lines.size && !startsBlock(i)) i++
                    out += Segment.Text(lines.subList(start, i).toList())
                }
            }
        }
        return out
    }
}
