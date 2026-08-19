package io.amar.console.data.spaces

// Obsidian-Kanban board codec — verbatim port of server/src/kanban/board.ts
// (KEEP IN SYNC; the frontmatter.ts/board.ts client-port precedent). The board
// file IS the task store — humans (Obsidian/SPA), agents, and the hub all edit
// the same markdown, and the hub's BoardWatcher diffs parses to drive
// delegation. So parse→serialize MUST be lossless identity on any file the
// plugin writes: blank lines in the frontmatter fence, blank lines between
// cards, the trailing `%% kanban:settings` block, indented continuations.
//
// Card grammar (extensions are TRAILING tokens):
//   - [ ] Card text #blocked @agentkey ^blockid
// `^blockid` is stamped ONLY by the hub at dispatch — never client-side.

data class BoardCard(
    /** Card text with trailing @key/^id/#blocked tokens stripped. */
    var text: String,
    var checked: Boolean,
    var agentKey: String?,
    var blockId: String?,
    /** #blocked tag — stuck as a PROPERTY; card keeps its column position. */
    var blocked: Boolean,
    /** Original lines, verbatim — first line + indented continuations. */
    val lines: MutableList<String>,
)

data class Interstitial(var afterCard: Int, val line: String)

data class BoardColumn(
    val title: String,
    val cards: MutableList<BoardCard>,
    /** Verbatim heading line (`## Title`). */
    val headingLine: String,
    val interstitials: MutableList<Interstitial>,
)

data class KanbanBoard(
    val header: MutableList<String>,
    val columns: MutableList<BoardColumn>,
    val footer: MutableList<String>,
)

data class CardRef(val column: String, val index: Int)

object KanbanCodec {
    private val CARD_RE = Regex("""^- \[( |x|X)] (.*)$""")
    private val HEADING_RE = Regex("""^## (.+?)\s*$""")
    private const val FOOTER_START = "%% kanban:settings"
    private val CONTINUATION_RE = Regex("""^(?: {2,}|\t)\S""")
    val DONE_COLUMN_RE = Regex("""^(done|complete|completed|shipped)$""", RegexOption.IGNORE_CASE)
    val DISPATCH_COLUMN_RE = Regex("""^(in.?progress|doing|active|now)$""", RegexOption.IGNORE_CASE)
    val REVIEW_COLUMN_RE = Regex("""^(under.?review|review|needs.?review)$""", RegexOption.IGNORE_CASE)

    fun isKanbanBoard(content: String): Boolean {
        val fence = Regex("""^---\n([\s\S]*?)\n---""").find(content)?.groupValues?.get(1) ?: ""
        return Regex("""^kanban-plugin:""", RegexOption.MULTILINE).containsMatchIn(fence)
    }

    data class CardTokens(val text: String, val agentKey: String?, val blockId: String?, val blocked: Boolean)

    /** Strip trailing `@key` / `^blockid` / `#blocked` off card text. Order-agnostic, one each. */
    fun parseCardTokens(rawText: String): CardTokens {
        var text = rawText.trimEnd()
        var agentKey: String? = null
        var blockId: String? = null
        var blocked = false
        repeat(3) {
            val block = Regex("""^(.*?)\s+\^([A-Za-z0-9-]+)$""").find(text)
            if (block != null && blockId == null) {
                text = block.groupValues[1].trimEnd(); blockId = block.groupValues[2]; return@repeat
            }
            val agent = Regex("""^(.*?)\s+@([a-z0-9][a-z0-9-]*)$""").find(text)
            if (agent != null && agentKey == null) {
                text = agent.groupValues[1].trimEnd(); agentKey = agent.groupValues[2]; return@repeat
            }
            val blk = Regex("""^(.*?)\s+#blocked$""").find(text)
            if (blk != null && !blocked) {
                text = blk.groupValues[1].trimEnd(); blocked = true; return@repeat
            }
            return CardTokens(text, agentKey, blockId, blocked)
        }
        return CardTokens(text, agentKey, blockId, blocked)
    }

    fun parse(content: String): KanbanBoard {
        val lines = content.split("\n")
        val header = mutableListOf<String>()
        val columns = mutableListOf<BoardColumn>()
        val footer = mutableListOf<String>()

        var i = 0
        while (i < lines.size && !HEADING_RE.matches(lines[i]) && !lines[i].startsWith(FOOTER_START)) {
            header.add(lines[i]); i++
        }

        var col: BoardColumn? = null
        while (i < lines.size) {
            val line = lines[i]
            if (line.startsWith(FOOTER_START)) { footer.addAll(lines.subList(i, lines.size)); break }
            val heading = HEADING_RE.find(line)
            if (heading != null) {
                col = BoardColumn(heading.groupValues[1], mutableListOf(), line, mutableListOf())
                columns.add(col); i++; continue
            }
            val c = col
            if (c == null) { header.add(line); i++; continue }
            val card = CARD_RE.find(line)
            if (card != null) {
                val t = parseCardTokens(card.groupValues[2])
                c.cards.add(BoardCard(t.text, card.groupValues[1] != " ", t.agentKey, t.blockId, t.blocked, mutableListOf(line)))
                i++; continue
            }
            val last = c.cards.lastOrNull()
            if (last != null && CONTINUATION_RE.containsMatchIn(line)) {
                last.lines.add(line); i++; continue
            }
            c.interstitials.add(Interstitial(c.cards.size - 1, line)); i++
        }
        return KanbanBoard(header, columns, footer)
    }

    fun serialize(board: KanbanBoard): String {
        val out = mutableListOf<String>()
        out.addAll(board.header)
        for (col in board.columns) {
            out.add(col.headingLine)
            out.addAll(col.interstitials.filter { it.afterCard == -1 }.map { it.line })
            col.cards.forEachIndexed { idx, card ->
                out.addAll(card.lines)
                out.addAll(col.interstitials.filter { it.afterCard == idx }.map { it.line })
            }
        }
        out.addAll(board.footer)
        return out.joinToString("\n")
    }

    private fun cardFirstLine(card: BoardCard): String {
        val tokens = mutableListOf(card.text)
        if (card.blocked) tokens.add("#blocked")
        card.agentKey?.let { tokens.add("@$it") }
        card.blockId?.let { tokens.add("^$it") }
        return "- [${if (card.checked) "x" else " "}] ${tokens.joinToString(" ")}"
    }

    /** Re-render a card's first line after mutating fields. Continuations untouched. */
    fun refreshCardLine(card: BoardCard) { card.lines[0] = cardFirstLine(card) }

    fun getCard(board: KanbanBoard, ref: CardRef): BoardCard? =
        board.columns.firstOrNull { it.title == ref.column }?.cards?.getOrNull(ref.index)

    /** Move to end of [toColumn]; checked follows done-column naming. */
    fun moveCard(board: KanbanBoard, ref: CardRef, toColumn: String): Boolean {
        val from = board.columns.firstOrNull { it.title == ref.column } ?: return false
        val to = board.columns.firstOrNull { it.title == toColumn } ?: return false
        val card = from.cards.getOrNull(ref.index) ?: return false
        from.cards.removeAt(ref.index)
        for (x in from.interstitials) {
            if (x.afterCard >= ref.index) x.afterCard = maxOf(-1, x.afterCard - 1)
        }
        to.cards.add(card)
        val isDone = DONE_COLUMN_RE.matches(toColumn)
        if (card.checked != isDone) { card.checked = isDone; refreshCardLine(card) }
        return true
    }

    fun addCard(board: KanbanBoard, columnTitle: String, text: String, agentKey: String? = null): BoardCard? {
        val col = board.columns.firstOrNull { it.title == columnTitle } ?: return null
        val card = BoardCard(text, checked = false, agentKey = agentKey, blockId = null, blocked = false, lines = mutableListOf(""))
        refreshCardLine(card)
        col.cards.add(card)
        return card
    }

    fun deleteCard(board: KanbanBoard, ref: CardRef): Boolean {
        val col = board.columns.firstOrNull { it.title == ref.column } ?: return false
        if (ref.index !in col.cards.indices) return false
        col.cards.removeAt(ref.index)
        for (x in col.interstitials) {
            if (x.afterCard >= ref.index) x.afterCard = maxOf(-1, x.afterCard - 1)
        }
        return true
    }
}
