package io.amar.console.data.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorActionsTest {

    @Test
    fun `wrap wraps a selection`() {
        val e = EditorActions.wrap("hello world", 0, 5, "**")
        assertEquals("**hello** world", e.text)
        assertEquals(0, e.selStart)
        assertEquals(9, e.selEnd) // ** + hello + **
    }

    @Test
    fun `wrap unwraps a wrapped selection`() {
        val e = EditorActions.wrap("**hello** world", 0, 9, "**")
        assertEquals("hello world", e.text)
        assertEquals(0, e.selStart)
        assertEquals(5, e.selEnd)
    }

    @Test
    fun `wrap strips markers just outside selection`() {
        val e = EditorActions.wrap("**hello** world", 2, 7, "**")
        assertEquals("hello world", e.text)
        assertEquals(0, e.selStart)
        assertEquals(5, e.selEnd)
    }

    @Test
    fun `wrap empty selection inserts pair with caret between`() {
        val e = EditorActions.wrap("ab", 1, 1, "*")
        assertEquals("a**b", e.text)
        assertEquals(2, e.selStart)
        assertEquals(2, e.selEnd)
    }

    @Test
    fun `insertFootnote adds ref and definition, incrementing N`() {
        val e = EditorActions.insertFootnote("body [^1] more", 4)
        assertTrue(e.text.contains("[^2]"))
        // definition appended at end
        assertTrue(e.text.trimEnd().endsWith("[^2]:"))
        assertEquals(e.text.length, e.selStart) // caret at end after "[^2]: "
    }

    @Test
    fun `insertFootnote on empty doc uses N=1 with no leading separator`() {
        val e = EditorActions.insertFootnote("", 0)
        assertEquals("[^1][^1]: ", e.text)
    }

    @Test
    fun `linkify wraps selection as markdown link`() {
        val e = EditorActions.linkify("see docs here", 4, 8, "https://x.com")
        assertEquals("see [docs](https://x.com) here", e.text)
    }

    @Test
    fun `wiki link uses selection as alias`() {
        assertEquals(
            "[[Target|sel]]",
            EditorActions.insertWikiLink("sel", 0, 3, "Target.md").text,
        )
        assertEquals("[[Target]]", EditorActions.insertWikiLink("", 0, 0, "Target").text)
    }

    @Test
    fun `url link falls back to url as display`() {
        assertEquals("[https://x.com](https://x.com)", EditorActions.insertUrlLink("", 0, 0, "https://x.com", "").text)
        assertEquals("[label](https://x.com)", EditorActions.insertUrlLink("", 0, 0, "https://x.com", "label").text)
    }

    @Test
    fun `dictation glues word chars with a space`() {
        assertEquals("foo bar", EditorActions.insertDictation("foo", 3, "bar").text)
        // punctuation neighbour → no glue space
        assertEquals("foo.bar", EditorActions.insertDictation("foo.", 4, "bar").text)
    }

    @Test
    fun `isBareUrl and justTypedWikiOpen`() {
        assertTrue(EditorActions.isBareUrl("https://example.com/a"))
        assertFalse(EditorActions.isBareUrl("see https://x.com now"))
        assertFalse(EditorActions.isBareUrl("nota url"))
        assertTrue(EditorActions.justTypedWikiOpen("a[[", 3))
        assertFalse(EditorActions.justTypedWikiOpen("a[b", 3))
    }
}
