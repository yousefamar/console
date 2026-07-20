package io.amar.console.data.longtail

import io.amar.console.data.db.BookmarkRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BookmarksLogicTest {

    private fun bm(file: String, title: String = file, url: String? = null, desc: String? = null) =
        BookmarkRow(file = file, title = title, url = url, tagsJson = null, addedAt = 0, description = desc)

    // --- bookmarkDomain --- //

    @Test
    fun `domain strips www and path`() {
        assertEquals("example.com", bookmarkDomain("https://www.example.com/foo/bar?x=1"))
        assertEquals("news.ycombinator.com", bookmarkDomain("https://news.ycombinator.com/item?id=1"))
        assertEquals("", bookmarkDomain(null))
        assertEquals("", bookmarkDomain(""))
    }

    // --- filterBookmarks --- //

    @Test
    fun `tag filter matches exact and descendant`() {
        val list = listOf(bm("a.md"), bm("b.md"), bm("c.md"))
        val tags = mapOf(
            "a.md" to listOf("dev"),
            "b.md" to listOf("dev/tools"),
            "c.md" to listOf("life"),
        )
        val hits = filterBookmarks(list, tags, "", "dev").map { it.file }.toSet()
        assertEquals(setOf("a.md", "b.md"), hits) // dev + dev/tools, not life
    }

    @Test
    fun `search matches title url description and tags`() {
        val list = listOf(
            bm("a.md", title = "Kotlin guide"),
            bm("b.md", url = "https://kotlinlang.org"),
            bm("c.md", desc = "all about kotlin"),
            bm("d.md", title = "Rust"),
        )
        val tags = mapOf("d.md" to listOf("kotlin/misc"))
        val hits = filterBookmarks(list, tags, "kotlin", null).map { it.file }.toSet()
        assertEquals(setOf("a.md", "b.md", "c.md", "d.md"), hits)
    }

    @Test
    fun `tag then search compose`() {
        val list = listOf(bm("a.md", title = "hello"), bm("b.md", title = "world"))
        val tags = mapOf("a.md" to listOf("t"), "b.md" to listOf("t"))
        val hits = filterBookmarks(list, tags, "hello", "t").map { it.file }
        assertEquals(listOf("a.md"), hits)
    }

    // --- buildTagTree --- //

    @Test
    fun `tag tree nests and counts ancestors`() {
        val tags = mapOf(
            "1" to listOf("dev/tools"),
            "2" to listOf("dev/lang"),
            "3" to listOf("dev"),
            "4" to listOf("life"),
        )
        val tree = buildTagTree(tags)
        val dev = tree.first { it.name == "dev" }
        // dev appears in 1,2,3 (ancestor of dev/tools + dev/lang + self) = 3
        assertEquals(3, dev.count)
        assertEquals(setOf("tools", "lang"), dev.children.map { it.name }.toSet())
        assertEquals(1, dev.children.first { it.name == "tools" }.count)
        val life = tree.first { it.name == "life" }
        assertEquals(1, life.count)
        assertTrue(life.children.isEmpty())
    }

    @Test
    fun `empty tags give empty tree`() {
        assertTrue(buildTagTree(emptyMap()).isEmpty())
    }

    // --- tagSuggestions --- //

    @Test
    fun `suggestions substring match exclude selected and cap`() {
        val all = listOf("kotlin", "kotlin/flows", "rust", "kubernetes")
        val s = tagSuggestions(all, "k", setOf("kotlin"), 2)
        assertEquals(2, s.size)
        assertTrue("kotlin" !in s) // already selected excluded
    }

    @Test
    fun `blank query gives no suggestions`() {
        assertTrue(tagSuggestions(listOf("a"), "", emptySet(), 5).isEmpty())
    }

    // --- normalizeUrl --- //

    @Test
    fun `normalizeUrl prepends https when protocol missing`() {
        assertEquals("https://example.com", normalizeUrl("example.com"))
        assertEquals("https://example.com", normalizeUrl("https://example.com"))
        assertEquals("http://x.dev", normalizeUrl("http://x.dev"))
    }

    // --- formatAddedDate --- //

    @Test
    fun `added date formats en-GB, falls back on garbage`() {
        assertEquals("4 May 2026", formatAddedDate("2026-05-04T07:17:00Z"))
        assertEquals("4 May 2026", formatAddedDate("2026-05-04"))
        assertNull(formatAddedDate(null))
        assertEquals("not-a-date", formatAddedDate("not-a-date"))
    }

    // --- allBookmarkTags --- //

    @Test
    fun `all tags distinct sorted with exclusions`() {
        val tags = mapOf("1" to listOf("b", "a"), "2" to listOf("a", "c"))
        assertEquals(listOf("a", "b", "c"), allBookmarkTags(tags))
        assertEquals(listOf("b", "c"), allBookmarkTags(tags, setOf("a")))
    }
}
