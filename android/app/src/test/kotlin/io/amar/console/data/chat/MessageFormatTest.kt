package io.amar.console.data.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure markdown→HTML + emoji-shortcode + mention-format parity tests. */
class MessageFormatTest {

    // ------------------------------------------------------------------ //
    // Markdown fallback (SPA markdownToHtml)

    @Test
    fun `plain text is not markdown`() {
        assertNull(MessageFormat.markdownToHtml("just a normal sentence"))
    }

    @Test
    fun `bold and italic convert`() {
        assertEquals("<strong>hi</strong>", MessageFormat.markdownToHtml("**hi**"))
        assertEquals("<em>hi</em>", MessageFormat.markdownToHtml("*hi*"))
    }

    @Test
    fun `inline and fenced code convert with escaping`() {
        assertEquals("<code>a &lt; b</code>", MessageFormat.markdownToHtml("`a < b`"))
        assertTrue(MessageFormat.markdownToHtml("```\ncode\n```")!!.contains("<pre><code>code</code></pre>"))
    }

    @Test
    fun `link converts`() {
        assertEquals(
            """<a href="https://x.com">text</a>""",
            MessageFormat.markdownToHtml("[text](https://x.com)"),
        )
    }

    @Test
    fun `heading and blockquote and strike convert`() {
        assertEquals("<h2>Title</h2>", MessageFormat.markdownToHtml("## Title"))
        assertEquals("<blockquote>quote</blockquote>", MessageFormat.markdownToHtml("> quote"))
        assertEquals("<del>gone</del>", MessageFormat.markdownToHtml("~~gone~~"))
    }

    @Test
    fun `hyphen bullet text with no other markdown is left plain`() {
        // A leading '-' hint triggers processing but produces no tags → null.
        assertNull(MessageFormat.markdownToHtml("- a plain dash line"))
    }

    // ------------------------------------------------------------------ //
    // Emoji shortcodes (SPA searchEmoji)

    @Test
    fun `emoji prefix search returns thumbsup for plus one alias`() {
        val hits = EmojiShortcodes.search("thumbsup")
        assertTrue(hits.any { it.emoji == "👍" })
    }

    @Test
    fun `emoji search caps results and prefers prefix`() {
        val hits = EmojiShortcodes.search("sm", limit = 5)
        assertTrue(hits.size <= 5)
        // "smile" is a prefix match → should appear.
        assertTrue(hits.any { it.shortcode.startsWith("sm") })
    }

    @Test
    fun `empty query returns nothing`() {
        assertTrue(EmojiShortcodes.search("").isEmpty())
    }

    @Test
    fun `table has thousands of entries`() {
        assertTrue(EmojiShortcodes.TABLE.size > 2000)
        assertEquals("💯", EmojiShortcodes.TABLE["100"])
    }

    // ------------------------------------------------------------------ //
    // MSC3952 intentional-mention formatting (SPA buildMentionsFormatted)

    @Test
    fun `mention present in body becomes matrix-to anchor with userId`() {
        val m = Mentions.buildMentionsFormatted(
            "hey @Alice how are you",
            listOf(Mentions.Mention("Alice", "@alice:x")),
        )!!
        assertTrue(m.formattedBody.contains("""<a href="https://matrix.to/#/%40alice%3Ax">@Alice</a>"""))
        assertEquals(listOf("@alice:x"), m.userIds)
    }

    @Test
    fun `deleted mention token does not ping`() {
        // "@Alice" no longer present in the body → no mention survives.
        assertNull(
            Mentions.buildMentionsFormatted(
                "hey how are you",
                listOf(Mentions.Mention("Alice", "@alice:x")),
            ),
        )
    }

    @Test
    fun `longer name replaced first captures the full-name mention`() {
        val m = Mentions.buildMentionsFormatted(
            "ping @Alice Smith please",
            listOf(Mentions.Mention("Alice Smith", "@asmith:x")),
        )!!
        assertEquals(listOf("@asmith:x"), m.userIds)
        // userId is URL-encoded in the matrix.to href (%40asmith%3Ax).
        assertTrue(m.formattedBody.contains("asmith"))
        assertTrue(m.formattedBody.contains(">@Alice Smith</a>"))
    }

    @Test
    fun `html in body is escaped`() {
        val m = Mentions.buildMentionsFormatted(
            "@Bob <script>",
            listOf(Mentions.Mention("Bob", "@bob:x")),
        )!!
        assertTrue(m.formattedBody.contains("&lt;script&gt;"))
    }
}
