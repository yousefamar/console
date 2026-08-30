package io.amar.console.data.spaces

// Pure card-content helpers — verbatim ports of src/kanban/board.ts
// cardUrls / cardImagePaths / splitTrailingTags (KEEP IN SYNC, the
// frontmatter.ts precedent). All operate on the hub CardView shape
// (text + detail lines); rendering decides thumbs/chips/badges.

object CardContent {
    data class UrlChip(val url: String, val label: String)
    data class TagSplit(val text: String, val tags: List<String>)

    private val IMAGE_LINE = Regex("""!\[[^\]]*]\(""")
    private val IMAGE_ONLY = Regex("""^!\[[^\]]*]\(([^)]+)\)$""")
    private val MD_LINK = Regex("""\[([^\]]+)]\((https?://[^\s)]+)\)""")
    private val BARE_URL = Regex("""https?://[^\s)\]}>"']+""")
    private val TRAILING_PUNCT = Regex("""[.,;:!?)\]}>'"]+$""")
    private val TRAILING_TAG = Regex("""^(.*?)\s+#([A-Za-z0-9][\w/-]*)$""")

    /** Image paths from detail lines that are EXACTLY `![alt](path)` —
     *  vault-relative, served at GET /notes/asset/<path>. */
    fun imagePaths(detail: List<String>): List<String> =
        detail.mapNotNull { IMAGE_ONLY.find(it.trim())?.groupValues?.get(1) }

    /** Detail lines minus image lines — the visible text preview. */
    fun textDetail(detail: List<String>): List<String> =
        detail.filter { !IMAGE_LINE.containsMatchIn(it) }

    /** Tappable URL chips from text + detail: markdown links keep their
     *  label, bare URLs label as hostname (www.-stripped); image lines
     *  skipped; dedup on punctuation-cleaned URL. */
    fun cardUrls(text: String, detail: List<String>): List<UrlChip> {
        val out = mutableListOf<UrlChip>()
        val seen = mutableSetOf<String>()
        fun push(url: String, label: String) {
            val clean = url.replace(TRAILING_PUNCT, "")
            if (!seen.add(clean)) return
            out.add(UrlChip(clean, label))
        }
        for (line in listOf(text) + detail) {
            if (IMAGE_LINE.containsMatchIn(line)) continue
            var consumed = line
            for (m in MD_LINK.findAll(line)) {
                push(m.groupValues[2], m.groupValues[1])
                consumed = consumed.replace(m.value, " ")
            }
            for (m in BARE_URL.findAll(consumed)) {
                val label = runCatching {
                    java.net.URI(m.value.replace(TRAILING_PUNCT, "")).host?.removePrefix("www.")
                }.getOrNull() ?: m.value
                push(m.value, label)
            }
        }
        return out
    }

    /** Split a trailing run of `#tag` tokens off the display text (display-
     *  only — the tags stay in the file). #blocked, #nofork and the model
     *  tags are parsed to card fields hub-side and never reach here via
     *  CardView.text, but hand-typed extras like `#bi` do. */
    fun splitTrailingTags(text: String): TagSplit {
        val tags = ArrayDeque<String>()
        var t = text.trimEnd()
        while (true) {
            val m = TRAILING_TAG.find(t) ?: break
            t = m.groupValues[1].trimEnd()
            tags.addFirst(m.groupValues[2])
        }
        return TagSplit(t, tags.toList())
    }
}
