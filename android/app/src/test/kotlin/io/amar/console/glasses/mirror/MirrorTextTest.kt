package io.amar.console.glasses.mirror

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MirrorTextTest {

    @Test
    fun `clipRow flattens whitespace and clips to 40 with ellipsis`() {
        assertEquals("short", MirrorText.clipRow("short"))
        assertEquals("a b c", MirrorText.clipRow("a\n b\t\tc "))
        val long = "x".repeat(60)
        val clipped = MirrorText.clipRow(long)
        assertEquals(MirrorText.DISPLAY_COLS, clipped.length)
        assertTrue(clipped.endsWith("…"))
    }

    @Test
    fun `buildStatus joins non-empty parts with dots`() {
        assertEquals("Chat · Veronica · 3u", MirrorText.buildStatus(listOf("Chat", "Veronica", "3u")))
        assertEquals("Chat", MirrorText.buildStatus(listOf("Chat", null, "")))
    }

    @Test
    fun `composerRow shows the tail of a long draft with caret`() {
        assertEquals("> hello|", MirrorText.composerRow("hello"))
        val long = "a".repeat(50) + "END"
        val row = MirrorText.composerRow(long)
        assertTrue(row.startsWith("> …"))
        assertTrue(row.endsWith("END|"))
        assertTrue(row.length <= MirrorText.DISPLAY_COLS)
    }

    @Test
    fun `assemble emits exactly 5 lines, body bottom-aligned`() {
        val payload = MirrorText.assemble(
            MirrorText.Frame("Chat · Room", listOf("alice: hi", "> reply|"))
        )
        val lines = payload.split("\n")
        assertEquals(5, lines.size)
        assertEquals("Chat · Room", lines[0])
        assertEquals("", lines[1])   // padding rows first (bottom-align)
        assertEquals("", lines[2])
        assertEquals("alice: hi", lines[3])
        assertEquals("> reply|", lines[4])
    }

    @Test
    fun `assemble keeps the newest rows on overflow (bottom-biased)`() {
        val payload = MirrorText.assemble(
            MirrorText.Frame("S", listOf("1", "2", "3", "4", "5", "6"))
        )
        val lines = payload.split("\n")
        assertEquals(5, lines.size)
        // padBottom keeps the last BODY_ROWS rows (3..6), older rows drop off top.
        assertEquals(listOf("3", "4", "5", "6"), lines.drop(1))
    }

    @Test
    fun `padBottom unshifts blanks on top when underfilled`() {
        val padded = MirrorText.padBottom(listOf("only"))
        assertEquals(listOf("", "", "", "only"), padded)
    }

    @Test
    fun `wrapLine breaks on a word boundary in the right half`() {
        val rows = MirrorText.wrapLine("the quick brown fox jumps", cols = 12)
        // "the quick br" would hard-split "brown"; wrapLine prefers the space
        // after "quick" (index 9 > 12/2) so words stay whole.
        assertEquals("the quick", rows[0])
        assertTrue(rows.all { it.length <= 12 })
    }

    @Test
    fun `wrapLine hard-splits when no late space exists`() {
        val rows = MirrorText.wrapLine("supercalifragilistic", cols = 8)
        assertEquals("supercal", rows[0])
        assertTrue(rows.joinToString("").length >= "supercalifragilistic".length)
    }

    @Test
    fun `wrapLine applies distinct first and continuation prefixes`() {
        val rows = MirrorText.wrapLine("alpha beta gamma delta", "12 ", "   ", 10)
        assertTrue(rows[0].startsWith("12 "))
        assertTrue(rows.drop(1).all { it.startsWith("   ") })
    }

    @Test
    fun `wrapLine on empty text returns the first prefix only`() {
        assertEquals(listOf("7 "), MirrorText.wrapLine("", "7 "))
    }

    @Test
    fun `shortName strips matrix ids`() {
        assertEquals("alice", MirrorText.shortName("@alice:beeper.local"))
        assertEquals("Bob", MirrorText.shortName("Bob"))
    }
}
