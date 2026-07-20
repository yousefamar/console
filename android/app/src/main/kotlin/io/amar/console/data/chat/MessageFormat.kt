package io.amar.console.data.chat

/**
 * Pure message-body rendering helpers — port of the SPA's
 * ChatMessageBubble markdownToHtml + display heuristics. The rendered
 * message body picks the richest available representation:
 *   1. Matrix `formatted_body` HTML (already on the row) →
 *      AnnotatedString.fromHtml
 *   2. lightweight-markdown → HTML (this file's [markdownToHtml])
 *   3. plain text, linkified
 */
object MessageFormat {

    private val MARKDOWN_HINT = Regex("""[*_`~#>\-\[]|^\d+\.\s""", RegexOption.MULTILINE)

    /**
     * Lightweight markdown → HTML (fenced/inline code, bold/italic/strike,
     * h1-h3, blockquote, `[text](url)` links). Returns null when the text has
     * no markdown syntax (render as plain linkified text instead). Mirrors
     * markdownToHtml() including its "no change → not markdown" bail.
     */
    fun markdownToHtml(text: String): String? {
        if (!MARKDOWN_HINT.containsMatchIn(text)) return null
        var html = text

        // Fenced code blocks (``` ... ```)
        html = Regex("""```(\w*)\n([\s\S]*?)```""").replace(html) { m ->
            val code = m.groupValues[2].replace("<", "&lt;").replace(">", "&gt;").trimEnd()
            "<pre><code>$code</code></pre>"
        }
        // Inline code (`...`)
        html = Regex("""`([^`\n]+)`""").replace(html) { m ->
            "<code>${m.groupValues[1].replace("<", "&lt;").replace(">", "&gt;")}</code>"
        }
        // Bold+italic, bold, italic, strike.
        html = Regex("""\*{3}(.+?)\*{3}""").replace(html) { "<strong><em>${it.groupValues[1]}</em></strong>" }
        html = Regex("""_{3}(.+?)_{3}""").replace(html) { "<strong><em>${it.groupValues[1]}</em></strong>" }
        html = Regex("""\*{2}(.+?)\*{2}""").replace(html) { "<strong>${it.groupValues[1]}</strong>" }
        html = Regex("""_{2}(.+?)_{2}""").replace(html) { "<strong>${it.groupValues[1]}</strong>" }
        html = Regex("""\*(.+?)\*""").replace(html) { "<em>${it.groupValues[1]}</em>" }
        html = Regex("""(?<!\w)_(.+?)_(?!\w)""").replace(html) { "<em>${it.groupValues[1]}</em>" }
        html = Regex("""~~(.+?)~~""").replace(html) { "<del>${it.groupValues[1]}</del>" }
        // Headings h1-h3.
        html = Regex("""^### (.+)$""", RegexOption.MULTILINE).replace(html) { "<h3>${it.groupValues[1]}</h3>" }
        html = Regex("""^## (.+)$""", RegexOption.MULTILINE).replace(html) { "<h2>${it.groupValues[1]}</h2>" }
        html = Regex("""^# (.+)$""", RegexOption.MULTILINE).replace(html) { "<h1>${it.groupValues[1]}</h1>" }
        // Blockquotes.
        html = Regex("""^&gt; ?(.+)$""", RegexOption.MULTILINE).replace(html) { "<blockquote>${it.groupValues[1]}</blockquote>" }
        html = Regex("""^> ?(.+)$""", RegexOption.MULTILINE).replace(html) { "<blockquote>${it.groupValues[1]}</blockquote>" }
        // Links [text](url).
        html = Regex("""\[([^\]]+)\]\((https?://[^)]+)\)""").replace(html) {
            "<a href=\"${it.groupValues[2]}\">${it.groupValues[1]}</a>"
        }
        // No change → the text had no actual markdown.
        return if (html == text) null else html
    }
}
