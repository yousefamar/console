package io.amar.console.data.feeds

import io.amar.console.data.db.FeedItemRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FeedsLogicTest {

    private fun item(id: String, feedId: String) = FeedItemRow(
        id = id, feedId = feedId, title = "t", link = null, content = null,
        snippet = null, publishedAt = 0L, imageUrl = null,
    )

    // --- extractYoutubeId (port of src/utils/youtube.ts) --- //

    @Test
    fun `youtube watch url`() {
        assertEquals("dQw4w9WgXcQ", extractYoutubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
    }

    @Test
    fun `youtu_be short url`() {
        assertEquals("dQw4w9WgXcQ", extractYoutubeId("https://youtu.be/dQw4w9WgXcQ"))
    }

    @Test
    fun `shorts url`() {
        assertEquals("abc_-123XYZ", extractYoutubeId("https://youtube.com/shorts/abc_-123XYZ?feature=share"))
    }

    @Test
    fun `watch url with extra params keeps only the id`() {
        assertEquals("xyz", extractYoutubeId("https://www.youtube.com/watch?v=xyz&t=42s"))
    }

    @Test
    fun `non-youtube and null urls give null`() {
        assertNull(extractYoutubeId("https://example.com/watch?v=nope"))
        assertNull(extractYoutubeId(null))
    }

    @Test
    fun `thumb and watch urls`() {
        assertEquals("https://img.youtube.com/vi/abc/hqdefault.jpg", youtubeThumbUrl("abc"))
        assertEquals("https://www.youtube.com/watch?v=abc", youtubeWatchUrl("abc"))
    }

    // --- folderUnreadCounts --- //

    @Test
    fun `per-folder unread counts include an All bucket`() {
        val folders = mapOf("f1" to "Tech", "f2" to "Tech", "f3" to "News", "f4" to null)
        val items = listOf(
            item("a", "f1"), item("b", "f2"), item("c", "f3"),
            item("d", "f4"), item("e", "f1"),
        )
        val counts = folderUnreadCounts(items, folders, readIds = setOf("b"))
        assertEquals(4, counts[null])       // e read out of 5
        assertEquals(2, counts["Tech"])     // a + e (b read)
        assertEquals(1, counts["News"])
        assertNull(counts["f4"])            // unfoldered only counts toward All
    }

    @Test
    fun `items from unknown feeds count toward All only`() {
        val counts = folderUnreadCounts(listOf(item("a", "ghost")), emptyMap(), emptySet())
        assertEquals(1, counts[null])
        assertEquals(1, counts.size)
    }

    @Test
    fun `folderNames dedupes and drops nulls`() {
        val names = folderNames(linkedMapOf("f1" to "Tech", "f2" to null, "f3" to "News", "f4" to "Tech"))
        assertEquals(listOf("Tech", "News"), names)
    }

    // --- feedUnreadCounts --- //

    @Test
    fun `per-feed unread counts`() {
        val items = listOf(item("a", "f1"), item("b", "f1"), item("c", "f2"))
        val counts = feedUnreadCounts(items, readIds = setOf("b"))
        assertEquals(1, counts["f1"])
        assertEquals(1, counts["f2"])
    }

    // --- relativeTime (port of FeedItemListEntry) --- //

    @Test
    fun `relative time buckets`() {
        val now = 1_000_000_000_000L
        assertEquals("now", relativeTime(now - 30_000, now))            // <1m
        assertEquals("5m", relativeTime(now - 5 * 60_000, now))
        assertEquals("3h", relativeTime(now - 3 * 3600_000, now))
        assertEquals("2d", relativeTime(now - 2 * 86_400_000L, now))
        assertEquals("", relativeTime(0, now))                          // no date
        assertEquals("now", relativeTime(now + 5000, now))              // future clamps to now
    }

    // --- HN comment parsing --- //

    @Test
    fun `extract HN item id from content`() {
        assertEquals("12345", extractHnItemId("<a href=\"https://news.ycombinator.com/item?id=12345\">c</a>"))
        assertNull(extractHnItemId("no link here"))
        assertNull(extractHnItemId(null))
    }

    @Test
    fun `parse HN tree nests comments`() {
        val raw = """
        {"id": 1, "descendants": 2, "score": 42, "children": [
          {"id": 2, "by": "alice", "text": "hello", "time": 100, "children": [
            {"id": 3, "by": "bob", "text": "reply", "time": 200, "children": []}
          ]}
        ]}
        """.trimIndent()
        val tree = parseHnTree(raw)!!
        assertEquals(2, tree.descendants)
        assertEquals(42, tree.score)
        assertEquals(1, tree.children.size)
        val top = tree.children[0]
        assertEquals("alice", top.by)
        assertEquals("hello", top.text)
        assertEquals(1, top.children.size)
        assertEquals("bob", top.children[0].by)
    }

    @Test
    fun `parse HN tree tolerates garbage`() {
        assertNull(parseHnTree(null))
        assertNull(parseHnTree(""))
        assertNull(parseHnTree("not json"))
    }

    @Test
    fun `hn time ago buckets`() {
        val now = 1_000_000L
        assertEquals("just now", hnTimeAgo(now - 30, now))
        assertEquals("5m ago", hnTimeAgo(now - 300, now))
        assertEquals("2h ago", hnTimeAgo(now - 7200, now))
        assertEquals("3d ago", hnTimeAgo(now - 3 * 86400, now))
    }

    // --- stripDomain --- //

    @Test
    fun `stripDomain strips www`() {
        assertEquals("example.com", stripDomain("https://www.example.com/x"))
        assertEquals("", stripDomain(null))
    }
}
