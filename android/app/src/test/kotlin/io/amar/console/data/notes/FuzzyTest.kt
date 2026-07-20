package io.amar.console.data.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FuzzyTest {

    @Test
    fun `subsequence matches in order, case-insensitive`() {
        assertTrue(Fuzzy.matches("mtg", "meeting-notes.md"))
        assertTrue(Fuzzy.matches("MTG", "meeting-notes.md"))
        assertTrue(Fuzzy.matches("notes", "meeting-notes.md"))
        assertTrue(Fuzzy.matches("", "anything"))
    }

    @Test
    fun `out-of-order or missing chars do not match`() {
        assertFalse(Fuzzy.matches("dm", "meeting-notes.md")) // d only appears after the last m
        assertFalse(Fuzzy.matches("xyz", "meeting-notes.md"))
        assertFalse(Fuzzy.matches("meeting", "meet"))
    }

    @Test
    fun `filter preserves order and applies key`() {
        val items = listOf("log/2026.md", "scratch/idea.md", "projects/console.md")
        assertEquals(
            listOf("log/2026.md", "projects/console.md"),
            Fuzzy.filter(items, "o26") { it } + Fuzzy.filter(items, "pjcon") { it },
        )
        assertEquals(items, Fuzzy.filter(items, "  ") { it }) // blank = all
    }

    @Test
    fun `score returns null for non-subsequence, positions for a match`() {
        assertEquals(null, Fuzzy.score("xyz", "meeting.md"))
        val s = Fuzzy.score("mtg", "meeting.md")!!
        assertEquals(listOf(0, 3, 6), s.positions) // m(0) t(3) g(6)
    }

    @Test
    fun `rank prefers a consecutive run over a scattered subsequence`() {
        val items = listOf("m-e-e-t.md", "meet.md")
        val ranked = Fuzzy.rank(items, "meet") { it }
        assertEquals("meet.md", ranked.first().item) // consecutive run scores higher
        assertTrue(Fuzzy.rank(emptyList<String>(), "x") { it }.isEmpty())
        assertTrue(Fuzzy.rank(items, "  ") { it }.isEmpty()) // blank → none
    }

    @Test
    fun `slugify produces filename-safe slugs`() {
        assertEquals("my-note-draft", slugify("My Note: Draft!"))
        assertEquals("hello-world", slugify("  Hello,   World  "))
        assertEquals("a1-b2", slugify("A1 & B2"))
        assertEquals("", slugify("!!!"))
    }
}
