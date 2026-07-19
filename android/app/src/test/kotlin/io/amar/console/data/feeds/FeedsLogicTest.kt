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
}
