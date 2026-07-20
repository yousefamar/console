package io.amar.console.ui.agents

/**
 * Pure, unit-testable logic behind the transcript renderer — the mobile port
 * of the string-munging in AgentMessageBlock.tsx / AgentSessionView.tsx. Kept
 * free of Compose so it can be exercised in plain JVM tests.
 */
object TranscriptHelpers {

    /** Strip the `@handoff(<key>)` control sentinel (drives the "Talk to X"
     *  banner, not message text), then collapse runs of 2+ spaces/tabs and trim
     *  trailing whitespace. Mirrors AgentMessageBlock.tsx:68. */
    fun stripHandoff(text: String): String =
        text.replace(Regex("""(?<![\w])@handoff\([a-z0-9-]+\)""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""[ \t]{2,}"""), " ")
            .trimEnd()

    /** Plain-text form for TTS: code fences → "(code block)", strip inline
     *  code/bold/italic/heading markers. Mirrors AgentMessageBlock.tsx:80-85. */
    fun plainForSpeech(text: String): String =
        text
            .replace(Regex("""```[\s\S]*?```"""), " (code block) ")
            .replace(Regex("""`([^`]+)`"""), "$1")
            .replace(Regex("""\*\*(.+?)\*\*"""), "$1")
            .replace(Regex("""\*(.+?)\*"""), "$1")
            .replace(Regex("""(?m)^#+\s+"""), "")
            .trim()

    /** Thinking char-count hint: exact for ≤100, else round up to nearest 100. */
    fun thinkingCharsLabel(len: Int): String =
        if (len > 100) "${(Math.ceil(len / 100.0) * 100).toInt()} chars" else "$len chars"

    data class DiffStat(val added: Int, val removed: Int)

    /** Count +/- lines across jsdiff hunks (lines carry their own prefix). */
    fun diffStat(lines: List<String>): DiffStat {
        var added = 0; var removed = 0
        for (l in lines) {
            if (l.startsWith("+")) added++ else if (l.startsWith("-")) removed++
        }
        return DiffStat(added, removed)
    }

    data class DiffRow(val kind: String, val lineNo: Int?, val glyph: String, val text: String)

    /** Build gutter-numbered diff rows from jsdiff hunks, mirroring DiffBlock's
     *  numbering (new-number on adds/ctx, old-number on dels) + '···' separators.
     *  [hunks] each = (oldStart, newStart, lines). */
    fun buildDiffRows(hunks: List<Triple<Int, Int, List<String>>>, cap: Int = 80, showAll: Boolean = false): List<DiffRow> {
        val rows = mutableListOf<DiffRow>()
        var budget = if (showAll) Int.MAX_VALUE else cap
        for ((hi, hunk) in hunks.withIndex()) {
            if (hi > 0) rows.add(DiffRow("sep", null, "···", "···"))
            var oldNo = hunk.first
            var newNo = hunk.second
            for (l in hunk.third) {
                if (budget-- <= 0) break
                val kind = when {
                    l.startsWith("+") -> "add"
                    l.startsWith("-") -> "del"
                    else -> "ctx"
                }
                val no = if (kind == "add") newNo else oldNo
                rows.add(DiffRow(kind, no, if (kind == "add") "+" else if (kind == "del") "-" else " ", l.drop(1)))
                if (kind != "add") oldNo++
                if (kind != "del") newNo++
            }
            if (budget <= 0) break
        }
        return rows
    }

    data class ToolInputPreview(val label: String?, val body: String?)

    /** Mine a live tool-input preview from partial JSON (tool_input_delta).
     *  Extracts file_path/path/url/pattern/query as label and the tail of
     *  content/new_string/command/prompt/old_string as body. Mirrors
     *  AgentSessionView.tsx:401-446 (regex heuristic over unfinished JSON). */
    fun mineToolInput(partialJson: String): ToolInputPreview {
        fun field(key: String): String? {
            val m = Regex(""""$key"\s*:\s*"((?:[^"\\]|\\.)*)""").find(partialJson) ?: return null
            return m.groupValues[1]
        }
        val label = field("file_path") ?: field("path") ?: field("url") ?: field("pattern") ?: field("query")
        var body = field("content") ?: field("new_string") ?: field("command") ?: field("prompt") ?: field("old_string")
        if (body != null) {
            body = unescapeJsonFragment(body)
            if (body.length > 2000) body = "…" + body.takeLast(2000)
        }
        return ToolInputPreview(label?.let { unescapeJsonFragment(it) }, body)
    }

    fun unescapeJsonFragment(s: String): String =
        s.replace("""\n""", "\n").replace("""\t""", "\t").replace("""\"""", "\"").replace("""\\""", "\\")

    /** True when a run of lines forms a markdown pipe table (header + separator).
     *  [lines] is the block's lines; returns the header row index if found. */
    fun isTableHeader(header: String, separator: String): Boolean {
        if (!header.contains("|")) return false
        val sep = separator.trim()
        // separator row: cells of ---, :--, --:, :-:
        if (!sep.contains("|") && !sep.contains("-")) return false
        val cells = sep.trim('|').split("|")
        if (cells.isEmpty()) return false
        return cells.all { Regex("""^\s*:?-{1,}:?\s*$""").matches(it) }
    }

    /** Split a markdown table row into trimmed cells. */
    fun tableCells(row: String): List<String> =
        row.trim().trim('|').split("|").map { it.trim() }

    /** Relative "in Xs/m/h/d" for the cron next-fire display (formatRelativeIn):
     *  <=0 → "now", <60s → s, <60m → m, <24h → h, else d. */
    fun formatRelativeIn(ms: Long): String {
        if (ms <= 0) return "now"
        val s = ms / 1000
        if (s < 60) return "${s}s"
        val m = s / 60
        if (m < 60) return "${m}m"
        val h = m / 60
        if (h < 24) return "${h}h"
        return "${h / 24}d"
    }

    /** Relative "Xs/m/h/d ago" for lastFiredAt. */
    fun formatRelativeAgo(ms: Long): String {
        if (ms < 0) return "now"
        val s = ms / 1000
        if (s < 60) return "${s}s ago"
        val m = s / 60
        if (m < 60) return "${m}m ago"
        val h = m / 60
        if (h < 24) return "${h}h ago"
        return "${h / 24}d ago"
    }

    /** Past-session relative date label: just now / Nm / Nh / Nd / Nw ago. */
    fun relativeDate(deltaMs: Long): String {
        if (deltaMs < 60_000) return "just now"
        val m = deltaMs / 60_000
        if (m < 60) return "${m}m ago"
        val h = m / 60
        if (h < 24) return "${h}h ago"
        val d = h / 24
        if (d < 7) return "${d}d ago"
        return "${d / 7}w ago"
    }

    /** Strip the " (fork)" suffix from a display name; returns (bareName, isFork). */
    fun stripForkSuffix(name: String): Pair<String, Boolean> {
        val m = Regex("""\s\(fork\)$""").find(name)
        return if (m != null) name.dropLast(m.value.length) to true else name to false
    }

    /** Short model id for the result-footer breakdown (drop bedrock ARN / prefix). */
    fun shortModel(id: String): String =
        id.replace(Regex("""^arn:aws:bedrock:.*/"""), "arn:…/").replace(Regex("""^us\.anthropic\."""), "")
}
