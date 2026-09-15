package io.amar.console.ui.agents

import io.amar.console.ui.agents.MarkdownBlocks.ListItem
import io.amar.console.ui.agents.MarkdownBlocks.Segment
import io.amar.console.ui.agents.MarkdownBlocks.isQuoteLine
import io.amar.console.ui.agents.MarkdownBlocks.segmentBlocks
import io.amar.console.ui.agents.MarkdownBlocks.unquoteLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port-parity tests — mirrors src/__tests__/markdown-blocks.test.ts case for case. */
class MarkdownBlocksTest {

    // ---- blockquotes (^ripe-crab) ----

    @Test
    fun `a run of quote lines becomes ONE quote segment with the marker stripped`() {
        assertEquals(
            listOf(
                Segment.Text(listOf("before")),
                Segment.Quote(listOf("first line", "second line")),
                Segment.Text(listOf("after")),
            ),
            segmentBlocks("before\n> first line\n> second line\nafter"),
        )
    }

    @Test
    fun `strips exactly one level so nested quotes recurse`() {
        assertEquals("> inner", unquoteLine("> > inner"))
        assertEquals("no space", unquoteLine(">no space"))
        assertEquals("", unquoteLine(">"))
        assertEquals("indented up to 3", unquoteLine("   > indented up to 3"))
        val seg = segmentBlocks("> outer\n> > inner")[0] as Segment.Quote
        assertEquals(Segment.Quote(listOf("outer", "> inner")), seg)
        assertEquals(
            listOf(Segment.Text(listOf("outer")), Segment.Quote(listOf("inner"))),
            segmentBlocks(seg.lines.joinToString("\n")),
        )
    }

    @Test
    fun `a blank quote line stays inside the quote as a paragraph break`() {
        assertEquals(listOf(Segment.Quote(listOf("a", "", "b"))), segmentBlocks("> a\n>\n> b"))
    }

    @Test
    fun `a mid-line marker is not a quote and 4+ leading spaces is not a quote`() {
        assertFalse(isQuoteLine("x > y"))
        assertFalse(isQuoteLine("    > code-ish"))
        assertEquals(listOf(Segment.Text(listOf("a > b"))), segmentBlocks("a > b"))
    }

    @Test
    fun `tables still segment and a quote can directly follow a table`() {
        assertEquals(
            listOf(Segment.Table("| h |", listOf("| c |")), Segment.Quote(listOf("q"))),
            segmentBlocks("| h |\n|---|\n| c |\n> q"),
        )
    }

    @Test
    fun `a table inside a quote survives one unquote pass`() {
        val seg = segmentBlocks("> | h |\n> |---|\n> | c |")[0] as Segment.Quote
        assertEquals(listOf(Segment.Table("| h |", listOf("| c |"))), segmentBlocks(seg.lines.joinToString("\n")))
    }

    // ---- headings + lists (^gray-bat) ----

    @Test
    fun `headings are their own segment with level and text, closing hashes stripped`() {
        assertEquals(Segment.Heading(2, "Backlog"), segmentBlocks("## Backlog ##\nbody")[0])
        assertEquals(listOf(Segment.Text(listOf("#nothash"))), segmentBlocks("#nothash"))
    }

    @Test
    fun `a run of list lines is one list with bullets, ordered numbers, task boxes, depth`() {
        assertEquals(
            Segment.ListBlock(
                listOf(
                    ListItem(depth = 0, ordered = false, text = "a"),
                    ListItem(depth = 1, ordered = false, text = "b"),
                    ListItem(depth = 0, ordered = false, checked = false, text = "todo"),
                    ListItem(depth = 0, ordered = false, checked = true, text = "done"),
                    ListItem(depth = 0, ordered = true, num = 3, text = "third"),
                ),
            ),
            segmentBlocks("- a\n  - b\n- [ ] todo\n- [x] done\n3. third")[0],
        )
    }

    @Test
    fun `an indented continuation line folds into the item and a blank line ends the list`() {
        val segs = segmentBlocks("- first line\n  continues here\n\nplain")
        assertEquals(Segment.ListBlock(listOf(ListItem(depth = 0, ordered = false, text = "first line continues here"))), segs[0])
        assertEquals(Segment.Text(listOf("", "plain")), segs[1])
    }

    @Test
    fun `dashes without a following space are not lists`() {
        assertTrue(segmentBlocks("---\n-x\n2026 - a year").all { it is Segment.Text })
    }

    @Test
    fun `tab indentation counts as one depth level and a tab-indented continuation folds`() {
        val seg = segmentBlocks("1. one\n\t2. two\n\tmore two")[0] as Segment.ListBlock
        assertEquals(2, seg.items.size)
        assertEquals(ListItem(depth = 1, ordered = true, num = 2, text = "two more two"), seg.items[1])
    }
}
