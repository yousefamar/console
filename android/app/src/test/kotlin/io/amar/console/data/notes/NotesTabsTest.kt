package io.amar.console.data.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotesTabsTest {

    @Test
    fun `open activates existing tab instead of duplicating`() {
        val t = NotesTabs()
        t.open("a.md", "A")
        t.open("b.md", "B")
        t.open("a.md", "ignored")
        assertEquals(2, t.state.value.open.size)
        assertEquals("a.md", t.state.value.activePath)
    }

    @Test
    fun `dirty tab refuses close without force`() {
        val t = NotesTabs()
        t.open("a.md", "A")
        t.setContent("a.md", "A edited")
        assertTrue(t.state.value.tab("a.md")!!.dirty)
        assertFalse(t.close("a.md"))
        assertEquals(1, t.state.value.open.size)
        assertTrue(t.close("a.md", force = true))
        assertTrue(t.state.value.open.isEmpty())
    }

    @Test
    fun `markSaved clears dirty`() {
        val t = NotesTabs()
        t.open("a.md", "A")
        t.setContent("a.md", "A2")
        t.markSaved("a.md", "A2")
        assertFalse(t.state.value.tab("a.md")!!.dirty)
    }

    @Test
    fun `close picks next active by index then previous`() {
        val t = NotesTabs()
        t.open("a.md", ""); t.open("b.md", ""); t.open("c.md", "")
        t.setActive("b.md")
        t.close("b.md")
        assertEquals("c.md", t.state.value.activePath) // same index (was 1 → c)
        t.setActive("c.md")
        t.close("c.md")
        assertEquals("a.md", t.state.value.activePath) // previous
    }

    @Test
    fun `recently closed reopen up to most recent`() {
        val t = NotesTabs()
        t.open("a.md", ""); t.open("b.md", "")
        t.close("a.md", true)
        t.close("b.md", true)
        assertEquals("b.md", t.reopenLastClosed())
    }

    @Test
    fun `closeAll remembers all closed`() {
        val t = NotesTabs()
        t.open("a.md", ""); t.open("b.md", "")
        t.closeAll()
        assertTrue(t.state.value.open.isEmpty())
        assertEquals(setOf("a.md", "b.md"), t.state.value.recentlyClosed.toSet())
    }

    @Test
    fun `rename migrates open tab and active`() {
        val t = NotesTabs()
        t.open("a.md", "A")
        t.setContent("a.md", "edited")
        t.renamed("a.md", "b.md")
        assertNull(t.state.value.tab("a.md"))
        assertEquals("edited", t.state.value.tab("b.md")!!.content)
        assertEquals("b.md", t.state.value.activePath)
    }

    @Test
    fun `tabs logic cycle wraps and no-ops on single`() {
        assertNull(TabsLogic.cycle(listOf("a"), "a", 1))
        assertEquals("a", TabsLogic.cycle(listOf("a", "b"), "b", 1))
        assertEquals("b", TabsLogic.cycle(listOf("a", "b"), "a", 1))
        assertEquals("b", TabsLogic.cycle(listOf("a", "b"), "a", -1))
    }

    @Test
    fun `nextActive helper`() {
        assertEquals("c", TabsLogic.nextActive(listOf("a", "b", "c"), 1)) // idx+1
        assertEquals("a", TabsLogic.nextActive(listOf("a", "b"), 1)) // idx+1 oob → idx-1
        assertNull(TabsLogic.nextActive(listOf("a"), 0)) // only tab → none
    }
}
