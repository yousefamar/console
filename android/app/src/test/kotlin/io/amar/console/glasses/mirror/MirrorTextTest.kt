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
    fun `assemble clips overlong bodies to 4 rows`() {
        val payload = MirrorText.assemble(
            MirrorText.Frame("S", listOf("1", "2", "3", "4", "5", "6"))
        )
        val lines = payload.split("\n")
        assertEquals(5, lines.size)
        assertEquals(listOf("1", "2", "3", "4"), lines.drop(1))
    }

    @Test
    fun `shortName strips matrix ids`() {
        assertEquals("alice", MirrorText.shortName("@alice:beeper.local"))
        assertEquals("Bob", MirrorText.shortName("Bob"))
    }
}
