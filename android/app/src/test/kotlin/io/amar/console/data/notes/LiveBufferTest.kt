package io.amar.console.data.notes

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LiveBufferTest {

    // ---- pure logic ----

    @Test
    fun `cursorLine is 1-based and counts newlines before the caret`() {
        val text = "one\ntwo\nthree"
        assertEquals(1, LiveBufferLogic.cursorLine(text, 0))
        assertEquals(1, LiveBufferLogic.cursorLine(text, 3))
        assertEquals(2, LiveBufferLogic.cursorLine(text, 4))
        assertEquals(3, LiveBufferLogic.cursorLine(text, text.length))
        // Out-of-range carets clamp instead of throwing.
        assertEquals(3, LiveBufferLogic.cursorLine(text, 999))
        assertEquals(1, LiveBufferLogic.cursorLine(text, -5))
    }

    @Test
    fun `selectionText is null when empty and order-insensitive otherwise`() {
        assertNull(LiveBufferLogic.selectionText("abc", 1, 1))
        assertEquals("bc", LiveBufferLogic.selectionText("abc", 1, 3))
        assertEquals("bc", LiveBufferLogic.selectionText("abc", 3, 1))
        assertEquals(LiveBufferLogic.SELECTION_MAX, LiveBufferLogic.selectionText("x".repeat(5000), 0, 5000)!!.length)
    }

    @Test
    fun `payload carries path and content, optional cursorLine and selection`() {
        val full = Json.parseToJsonElement(LiveBufferLogic.payload("a.md", "hi\nthere", 2, "there")).jsonObject
        assertEquals("a.md", full["path"]!!.jsonPrimitive.content)
        assertEquals("hi\nthere", full["content"]!!.jsonPrimitive.content)
        assertEquals("2", full["cursorLine"]!!.jsonPrimitive.content)
        assertEquals("there", full["selection"]!!.jsonPrimitive.content)

        val bare = Json.parseToJsonElement(LiveBufferLogic.payload("a.md", "", null, null)).jsonObject
        assertNull(bare["cursorLine"])
        assertNull(bare["selection"])
        // An empty selection string is dropped, not sent as "".
        assertNull(Json.parseToJsonElement(LiveBufferLogic.payload("a.md", "x", 1, "")).jsonObject["selection"])
    }

    // ---- mirror behaviour ----

    @Test
    fun `a burst of updates posts once, with the last state`() = runTest {
        val posts = mutableListOf<String>()
        val m = LiveBufferMirror(this, { posts += it }, debounceMs = 100)
        m.update("a.md", "h", 1, null)
        m.update("a.md", "he", 1, null)
        m.update("a.md", "hel", 1, null)
        advanceTimeBy(50)
        assertTrue(posts.isEmpty())
        advanceTimeBy(100)
        assertEquals(1, posts.size)
        assertEquals("hel", Json.parseToJsonElement(posts[0]).jsonObject["content"]!!.jsonPrimitive.content)
    }

    @Test
    fun `clear posts the empty payload only after something was mirrored`() = runTest {
        val posts = mutableListOf<String>()
        val m = LiveBufferMirror(this, { posts += it }, debounceMs = 100)
        m.clear()
        advanceUntilIdle()
        assertTrue(posts.isEmpty()) // never mirrored → nothing to clear (another client may own the slot)

        m.update("a.md", "x", 1, null)
        advanceUntilIdle()
        m.clear()
        advanceUntilIdle()
        assertEquals(listOf("{}"), posts.drop(1))
        // A second clear is a no-op.
        m.clear()
        advanceUntilIdle()
        assertEquals(2, posts.size)
    }

    @Test
    fun `clear cancels a pending debounced update`() = runTest {
        val posts = mutableListOf<String>()
        val m = LiveBufferMirror(this, { posts += it }, debounceMs = 100)
        m.update("a.md", "x", 1, null)
        m.clear()
        advanceUntilIdle()
        assertTrue(posts.isEmpty())
    }

    @Test
    fun `a failing post does not break later mirrors`() = runTest {
        val posts = mutableListOf<String>()
        var fail = true
        val m = LiveBufferMirror(this, { if (fail) error("hub down") else posts += it }, debounceMs = 10)
        m.update("a.md", "x", 1, null)
        advanceUntilIdle()
        fail = false
        m.update("a.md", "xy", 1, null)
        advanceUntilIdle()
        assertEquals(1, posts.size)
    }
}
