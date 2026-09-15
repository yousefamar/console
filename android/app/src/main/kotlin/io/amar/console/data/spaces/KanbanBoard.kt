package io.amar.console.data.spaces

// Obsidian-Kanban board codec — verbatim port of server/src/kanban/board.ts
// (KEEP IN SYNC; the frontmatter.ts/board.ts client-port precedent). The board
// file IS the task store — humans (Obsidian/SPA), agents, and the hub all edit
// the same markdown, and the hub's BoardWatcher diffs parses to drive
// delegation. So parse→serialize MUST be lossless identity on any file the
// plugin writes: blank lines in the frontmatter fence, blank lines between
// cards, the trailing `%% kanban:settings` block, indented continuations.
//
// Card grammar (extensions are TRAILING tokens, any order, one each):
//   - [ ] Card text #blocked #nofork #inherit #model/<id> @agentkey ^blockid
// A bare `#haiku`/`#sonnet`/`#opus`/`#fable` is shorthand for `#model/<alias>`
// (MODEL_ALIASES). `^blockid` is stamped ONLY by the hub at dispatch — never
// client-side.

data class BoardCard(
    /** Card text with trailing @key/^id/#tag tokens stripped. */
    var text: String,
    var checked: Boolean,
    var agentKey: String?,
    var blockId: String?,
    /** #blocked tag — stuck as a PROPERTY; card keeps its column position. */
    var blocked: Boolean,
    /** Original lines, verbatim — first line + indented continuations. */
    val lines: MutableList<String>,
    /** #nofork — dispatch wakes the role directly, no per-ticket fork. */
    var nofork: Boolean = false,
    /** #inherit — the ticket-fork copies the parent's transcript (default:
     *  fresh context + digest). */
    var inherit: Boolean = false,
    /** #model/<alias-or-id> (or a bare alias tag) — ticket-fork model pin. */
    var model: String? = null,
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

    /** The CLI's model aliases (`ANTHROPIC_DEFAULT_<ALIAS>_MODEL`) — keep in
     *  sync with server/src/kanban/board.ts + src/kanban/board.ts. A bare
     *  `#<alias>` card tag is shorthand for `#model/<alias>`; other hashtags
     *  never pin a model. */
    val MODEL_ALIASES = listOf("opus", "fable", "sonnet", "haiku")
    fun isModelAlias(s: String): Boolean = s in MODEL_ALIASES
    private val MODEL_ALIAS_RE = Regex("""^(.*?)\s+#(${MODEL_ALIASES.joinToString("|")})$""")
    private val MODEL_RE = Regex("""^(.*?)\s+#model/([\w.:-]+)$""")
    private val BLOCK_RE = Regex("""^(.*?)\s+\^([A-Za-z0-9-]+)$""")
    private val AGENT_RE = Regex("""^(.*?)\s+@([a-z0-9][a-z0-9-]*)$""")
    private val BLOCKED_RE = Regex("""^(.*?)\s+#blocked$""")
    private val NOFORK_RE = Regex("""^(.*?)\s+#nofork$""")
    private val INHERIT_RE = Regex("""^(.*?)\s+#inherit$""")

    /** Serialized model pin: aliases as the bare shorthand, ids behind
     *  `#model/` (SPA `modelToken`, the hub serializer's spelling). */
    fun modelToken(model: String): String = if (isModelAlias(model)) "#$model" else "#model/$model"

    data class CardTokens(
        val text: String,
        val agentKey: String?,
        val blockId: String?,
        val blocked: Boolean,
        val nofork: Boolean = false,
        val inherit: Boolean = false,
        val model: String? = null,
    )

    /** Strip trailing `@key` / `^blockid` / `#blocked` / `#nofork` /
     *  `#inherit` / `#model/x` (or bare alias) off card text. Order-agnostic,
     *  up to one of each — a verbatim port of the TS parseCardTokens. */
    fun parseCardTokens(rawText: String): CardTokens {
        var text = rawText.trimEnd()
        var agentKey: String? = null
        var blockId: String? = null
        var blocked = false
        var nofork = false
        var inherit = false
        var model: String? = null
        repeat(6) {
            val block = BLOCK_RE.find(text)
            if (block != null && blockId == null) {
                text = block.groupValues[1].trimEnd(); blockId = block.groupValues[2]; return@repeat
            }
            val agent = AGENT_RE.find(text)
            if (agent != null && agentKey == null) {
                text = agent.groupValues[1].trimEnd(); agentKey = agent.groupValues[2]; return@repeat
            }
            val blk = BLOCKED_RE.find(text)
            if (blk != null && !blocked) {
                text = blk.groupValues[1].trimEnd(); blocked = true; return@repeat
            }
            val nf = NOFORK_RE.find(text)
            if (nf != null && !nofork) {
                text = nf.groupValues[1].trimEnd(); nofork = true; return@repeat
            }
            val inh = INHERIT_RE.find(text)
            if (inh != null && !inherit) {
                text = inh.groupValues[1].trimEnd(); inherit = true; return@repeat
            }
            val mdl = MODEL_RE.find(text) ?: MODEL_ALIAS_RE.find(text)
            if (mdl != null && model == null) {
                text = mdl.groupValues[1].trimEnd(); model = mdl.groupValues[2]; return@repeat
            }
            return CardTokens(text, agentKey, blockId, blocked, nofork, inherit, model)
        }
        return CardTokens(text, agentKey, blockId, blocked, nofork, inherit, model)
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
                c.cards.add(BoardCard(
                    t.text, card.groupValues[1] != " ", t.agentKey, t.blockId, t.blocked, mutableListOf(line),
                    nofork = t.nofork, inherit = t.inherit, model = t.model,
                ))
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

    /** Token order mirrors the hub serializer: model, nofork, inherit, blocked, @key, ^id. */
    private fun cardFirstLine(card: BoardCard): String {
        val tokens = mutableListOf(card.text)
        card.model?.let { tokens.add(modelToken(it)) }
        if (card.nofork) tokens.add("#nofork")
        if (card.inherit) tokens.add("#inherit")
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
