package io.amar.console.ui.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptHelpersTest {

    @Test
    fun `stripHandoff removes sentinel and trims the end, keeping indentation`() {
        assertEquals("Talk to Bob.", TranscriptHelpers.stripHandoff("Talk to Bob. @handoff(bob-agent)"))
        // Runs of spaces survive here (the segmenter collapses prose only) —
        // list indentation and fenced code depend on them (^keen-boar).
        assertEquals("A    B", TranscriptHelpers.stripHandoff("A    B   "))
        assertEquals("- a\n  - b", TranscriptHelpers.stripHandoff("- a\n  - b\n"))
        // email addresses are not stripped (word-boundary before @)
        assertEquals("mail me at a@handoff.io", TranscriptHelpers.stripHandoff("mail me at a@handoff.io"))
    }

    @Test
    fun `plainForSpeech strips markdown`() {
        assertEquals("hi (code block) done", TranscriptHelpers.plainForSpeech("hi ```x\ncode\n``` done").replace(Regex("\\s+"), " ").trim())
        assertEquals("bold and italic", TranscriptHelpers.plainForSpeech("**bold** and *italic*"))
        assertEquals("Heading", TranscriptHelpers.plainForSpeech("## Heading"))
    }

    @Test
    fun `thinking char label rounds up past 100`() {
        assertEquals("50 chars", TranscriptHelpers.thinkingCharsLabel(50))
        assertEquals("100 chars", TranscriptHelpers.thinkingCharsLabel(100))
        assertEquals("200 chars", TranscriptHelpers.thinkingCharsLabel(101))
        assertEquals("300 chars", TranscriptHelpers.thinkingCharsLabel(250))
    }

    @Test
    fun `diffStat counts prefixed lines`() {
        val s = TranscriptHelpers.diffStat(listOf("+added", "-removed", " context", "+more"))
        assertEquals(2, s.added)
        assertEquals(1, s.removed)
    }

    @Test
    fun `buildDiffRows numbers gutters and inserts separators`() {
        val hunks = listOf(
            Triple(1, 1, listOf(" ctx", "-old", "+new")),
            Triple(10, 10, listOf(" more")),
        )
        val rows = TranscriptHelpers.buildDiffRows(hunks)
        // ctx@1 (old&new=1), del shows old-num (now 2 after ctx bumped it),
        // add shows new-num (2), then sep, then next hunk's ctx@10.
        assertEquals("ctx", rows[0].kind); assertEquals(1, rows[0].lineNo)
        assertEquals("del", rows[1].kind); assertEquals(2, rows[1].lineNo)
        assertEquals("add", rows[2].kind); assertEquals(2, rows[2].lineNo)
        assertEquals("sep", rows[3].kind)
        assertEquals("ctx", rows[4].kind); assertEquals(10, rows[4].lineNo)
    }

    @Test
    fun `buildDiffRows caps at limit`() {
        val hunk = Triple(1, 1, (1..200).map { "+l$it" })
        val rows = TranscriptHelpers.buildDiffRows(listOf(hunk), cap = 80, showAll = false)
        assertEquals(80, rows.count { it.kind != "sep" })
        val all = TranscriptHelpers.buildDiffRows(listOf(hunk), cap = 80, showAll = true)
        assertEquals(200, all.count { it.kind != "sep" })
    }

    @Test
    fun `mineToolInput extracts label and body`() {
        val partial = """{"file_path":"/tmp/x.kt","new_string":"line1\nline2"""
        val p = TranscriptHelpers.mineToolInput(partial)
        assertEquals("/tmp/x.kt", p.label)
        assertEquals("line1\nline2", p.body)
    }

    @Test
    fun `mineToolInput tails long body`() {
        val body = "x".repeat(3000)
        val partial = """{"command":"$body"""
        val p = TranscriptHelpers.mineToolInput(partial)
        assertTrue(p.body!!.startsWith("…"))
        assertEquals(2001, p.body!!.length)
    }

    @Test
    fun `isTableHeader detects pipe table`() {
        assertTrue(TranscriptHelpers.isTableHeader("| a | b |", "| --- | --- |"))
        assertTrue(TranscriptHelpers.isTableHeader("a | b", ":--|--:"))
        assertFalse(TranscriptHelpers.isTableHeader("just text", "more text"))
        assertFalse(TranscriptHelpers.isTableHeader("| a |", "| xy |"))
    }

    @Test
    fun `tableCells trims and splits`() {
        assertEquals(listOf("a", "b", "c"), TranscriptHelpers.tableCells("| a | b | c |"))
    }

    @Test
    fun `formatRelativeIn buckets`() {
        assertEquals("now", TranscriptHelpers.formatRelativeIn(0))
        assertEquals("30s", TranscriptHelpers.formatRelativeIn(30_000))
        assertEquals("5m", TranscriptHelpers.formatRelativeIn(5 * 60_000))
        assertEquals("2h", TranscriptHelpers.formatRelativeIn(2 * 3_600_000))
        assertEquals("3d", TranscriptHelpers.formatRelativeIn(3 * 86_400_000L))
    }

    @Test
    fun `formatRelativeAgo buckets`() {
        assertEquals("5m ago", TranscriptHelpers.formatRelativeAgo(5 * 60_000))
        assertEquals("2h ago", TranscriptHelpers.formatRelativeAgo(2 * 3_600_000))
    }

    @Test
    fun `relativeDate buckets`() {
        assertEquals("just now", TranscriptHelpers.relativeDate(10_000))
        assertEquals("5m ago", TranscriptHelpers.relativeDate(5 * 60_000))
        assertEquals("2d ago", TranscriptHelpers.relativeDate(2 * 86_400_000L))
        assertEquals("1w ago", TranscriptHelpers.relativeDate(8 * 86_400_000L))
    }

    @Test
    fun `stripForkSuffix detects and strips`() {
        assertEquals("Bob" to true, TranscriptHelpers.stripForkSuffix("Bob (fork)"))
        assertEquals("Bob" to false, TranscriptHelpers.stripForkSuffix("Bob"))
    }

    @Test
    fun `shortModel drops prefixes`() {
        assertEquals("claude-opus-4-8", TranscriptHelpers.shortModel("us.anthropic.claude-opus-4-8"))
        assertEquals("claude-fable-5", TranscriptHelpers.shortModel("claude-fable-5"))
    }

    @Test
    fun `isVideoPath matches bridge video extensions, ignoring query and case`() {
        assertTrue(isVideoPath("/tmp/demo.mp4"))
        assertTrue(isVideoPath("~/clips/Take2.MOV?t=3#x"))
        assertTrue(isVideoPath("https://x/y/z.webm"))
        assertFalse(isVideoPath("/tmp/shot.png"))
        assertFalse(isVideoPath("/tmp/noext"))
        assertFalse(isVideoPath("/tmp/dir.mp4/shot.png"))
    }

    @Test
    fun `gaps names the first present index after each hole with its size`() {
        // Tail-jumped cache [0,3) ∪ [800,802): one hole of 797 rows ending at 800.
        assertEquals(mapOf(800L to 797L), TranscriptHelpers.gaps(listOf(801L, 0L, 2L, 800L, 1L)))
        assertEquals(mapOf(5L to 2L, 9L to 3L), TranscriptHelpers.gaps(listOf(2L, 5L, 9L)))
        assertEquals(emptyMap<Long, Long>(), TranscriptHelpers.gaps(listOf(0L, 1L, 2L)))
        assertEquals(emptyMap<Long, Long>(), TranscriptHelpers.gaps(emptyList()))
        // A cache that simply starts late is not a gap — that is the top-of-list loader's job.
        assertEquals(emptyMap<Long, Long>(), TranscriptHelpers.gaps(listOf(800L, 801L)))
    }

    @Test
    fun `seamCarrier is the first rendered row at or after the boundary`() {
        // 800 is a tool_result folded into 799's tool_use (not rendered) — the
        // seam rides the next visible row, 801.
        assertEquals(801L, TranscriptHelpers.seamCarrier(800L, listOf(0L, 1L, 801L, 802L)))
        assertEquals(800L, TranscriptHelpers.seamCarrier(800L, listOf(800L, 801L)))
        assertNull(TranscriptHelpers.seamCarrier(800L, listOf(0L, 1L)))
    }
}
