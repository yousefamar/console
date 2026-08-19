package io.amar.console.data.spaces

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Port-parity tests for the board codec. The lossless round-trip is the
 * CONTRACT: the same file is edited by Obsidian, agents, the hub's dispatch
 * stamper, and now the APK — any normalization corrupts the hub's diffing.
 * Mirrors server/src/__tests__/kanban.test.ts cases.
 */
class KanbanBoardTest {

    private val sample = """---

kanban-plugin: board

---

## Backlog

- [ ] Write the launch post
- [ ] Fix the flaky test #blocked @new-mobile-app
  Some indented detail line
  and a second one

## In Progress

- [ ] Ship the thing @al ^abc123

## Under Review

## Done

- [x] Old completed card ^zz9

%% kanban:settings

```
{"kanban-plugin":"board","list-collapse":[false,false]}
```
%%"""

    @Test
    fun `parse then serialize is byte-identical`() {
        assertEquals(sample, KanbanCodec.serialize(KanbanCodec.parse(sample)))
    }

    @Test
    fun `card tokens parse trailing markers in any order`() {
        val t1 = KanbanCodec.parseCardTokens("Fix the flaky test #blocked @new-mobile-app")
        assertEquals("Fix the flaky test", t1.text)
        assertEquals("new-mobile-app", t1.agentKey)
        assertTrue(t1.blocked)
        assertNull(t1.blockId)

        val t2 = KanbanCodec.parseCardTokens("Ship the thing @al ^abc123")
        assertEquals("Ship the thing", t2.text)
        assertEquals("al", t2.agentKey)
        assertEquals("abc123", t2.blockId)
        assertFalse(t2.blocked)

        // Mid-text @ / ^ never match (alice@example.com, 2^10).
        val t3 = KanbanCodec.parseCardTokens("Email alice@example.com about 2^10 things")
        assertEquals("Email alice@example.com about 2^10 things", t3.text)
        assertNull(t3.agentKey)
        assertNull(t3.blockId)
    }

    @Test
    fun `continuations attach to the previous card and survive round-trip`() {
        val board = KanbanCodec.parse(sample)
        val backlog = board.columns.first { it.title == "Backlog" }
        assertEquals(3, backlog.cards[1].lines.size)
        assertEquals(sample, KanbanCodec.serialize(board))
    }

    @Test
    fun `moveCard to Done checks the box and keeps interstitial indices sane`() {
        val board = KanbanCodec.parse(sample)
        assertTrue(KanbanCodec.moveCard(board, CardRef("In Progress", 0), "Done"))
        val done = board.columns.first { it.title == "Done" }
        assertEquals(2, done.cards.size)
        assertTrue(done.cards[1].checked)
        assertEquals("Ship the thing", done.cards[1].text)
        // Tokens survived the move (blockId kept — identity is the hub's).
        assertEquals("abc123", done.cards[1].blockId)
        // Re-serializes without corruption (idempotent on its own output).
        val out = KanbanCodec.serialize(board)
        assertEquals(out, KanbanCodec.serialize(KanbanCodec.parse(out)))
    }

    @Test
    fun `mutating assignment rewrites only line 0, continuations untouched`() {
        val board = KanbanCodec.parse(sample)
        val ref = CardRef("Backlog", 1)
        val card = KanbanCodec.getCard(board, ref)!!
        card.agentKey = "al"
        KanbanCodec.refreshCardLine(card)
        assertEquals("- [ ] Fix the flaky test #blocked @al", card.lines[0])
        assertEquals("  Some indented detail line", card.lines[1])
    }

    @Test
    fun `addCard appends and deleteCard shifts interstitials`() {
        val board = KanbanCodec.parse(sample)
        KanbanCodec.addCard(board, "Backlog", "Brand new card", agentKey = "al")
        val backlog = board.columns.first { it.title == "Backlog" }
        assertEquals("- [ ] Brand new card @al", backlog.cards.last().lines[0])
        assertTrue(KanbanCodec.deleteCard(board, CardRef("Backlog", 0)))
        assertEquals("Fix the flaky test", backlog.cards[0].text)
        // Round-trip still clean after structural edits.
        val out = KanbanCodec.serialize(board)
        assertEquals(out, KanbanCodec.serialize(KanbanCodec.parse(out)))
    }

    @Test
    fun `isKanbanBoard keys off the frontmatter flag`() {
        assertTrue(KanbanCodec.isKanbanBoard(sample))
        assertFalse(KanbanCodec.isKanbanBoard("---\ntitle: note\n---\n# hi"))
    }
}
