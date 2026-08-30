package io.amar.console.data.spaces

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port-parity tests for CardContent (src/kanban/board.ts cardUrls /
 *  cardImagePaths / splitTrailingTags). */
class CardContentTest {

    @Test
    fun `imagePaths extracts image-only detail lines, textDetail strips them`() {
        val detail = listOf(
            "Some context line",
            "![img](images/shot-1.png)",
            "  ![screenshot](images/deep/shot-2.jpg)",
            "See https://example.com for more",
        )
        assertEquals(listOf("images/shot-1.png", "images/deep/shot-2.jpg"), CardContent.imagePaths(detail))
        assertEquals(listOf("Some context line", "See https://example.com for more"), CardContent.textDetail(detail))
    }

    @Test
    fun `cardUrls markdown labels win, bare urls label by hostname`() {
        val urls = CardContent.cardUrls(
            "Check [the docs](https://docs.example.com/page) and https://www.github.com/amar/repo.",
            emptyList(),
        )
        assertEquals(2, urls.size)
        assertEquals("the docs", urls[0].label)
        assertEquals("https://docs.example.com/page", urls[0].url)
        assertEquals("github.com", urls[1].label)
        // Trailing punctuation stripped from the bare URL.
        assertEquals("https://www.github.com/amar/repo", urls[1].url)
    }

    @Test
    fun `cardUrls dedups and skips image lines`() {
        val urls = CardContent.cardUrls(
            "See https://x.com/a",
            listOf(
                "![img](https://x.com/image.png)",
                "again https://x.com/a, and [x](https://x.com/a)",
            ),
        )
        assertEquals(1, urls.size)
        assertEquals("https://x.com/a", urls[0].url)
    }

    @Test
    fun `splitTrailingTags splits only the trailing run`() {
        val s = CardContent.splitTrailingTags("Fix the thing #bi #urgent")
        assertEquals("Fix the thing", s.text)
        assertEquals(listOf("bi", "urgent"), s.tags)
        // Mid-text hashes don't split; nothing trailing → unchanged.
        val t = CardContent.splitTrailingTags("Issue #42 needs a look")
        assertEquals("Issue #42 needs a look", t.text)
        assertTrue(t.tags.isEmpty())
        // Tag with slash (e.g. model/haiku shape survives as generic tag).
        val u = CardContent.splitTrailingTags("Try it #model/haiku")
        assertEquals("Try it", u.text)
        assertEquals(listOf("model/haiku"), u.tags)
    }
}
