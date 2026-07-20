package io.amar.console.data.notes

import io.amar.console.data.db.NoteFileRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CirclesLayoutTest {

    private fun file(path: String, size: Long = 100, mtime: Long = 0) = NoteFileRow(
        path = path, name = path.substringAfterLast('/'), dir = path.substringBeforeLast('/', ""),
        mtime = mtime, size = size, cachedContent = null, contentMtime = null,
    )

    @Test
    fun `empty vault yields null`() {
        assertNull(CirclesLayout.build(emptyList()))
    }

    @Test
    fun `builds root with synthesized folders`() {
        val root = CirclesLayout.build(
            listOf(file("a.md"), file("dir/b.md"), file("dir/sub/c.md"))
        )!!
        assertEquals(CirclesLayout.ROOT_PATH, root.path)
        assertNotNull(CirclesLayout.findNode(root, "dir"))
        assertNotNull(CirclesLayout.findNode(root, "dir/sub"))
        val c = CirclesLayout.findNode(root, "dir/sub/c.md")!!
        assertTrue(c.isFile)
        assertEquals(3, c.depth) // root(0) dir(1) sub(2) c(3)
    }

    @Test
    fun `all circles fit within the canvas and don't overlap siblings`() {
        val files = (1..12).map { file("f$it.md", size = (it * 50).toLong()) }
        val root = CirclesLayout.build(files)!!
        // root fills the canvas
        assertEquals(CirclesLayout.CANVAS / 2, root.r, 1.0)
        // every packed file circle is inside the root circle
        CirclesLayout.forEach(root) { n ->
            if (n === root) return@forEach
            val d = Math.hypot(n.x - root.x, n.y - root.y)
            assertTrue("node ${n.path} escapes root", d + n.r <= root.r + 1.0)
        }
        // siblings of the root do not overlap
        val top = root.children
        for (i in top.indices) for (j in i + 1 until top.size) {
            val a = top[i]; val b = top[j]
            val dist = Math.hypot(a.x - b.x, a.y - b.y)
            assertTrue("overlap ${a.path}/${b.path}", dist + 1e-3 >= a.r + b.r - 1.0)
        }
    }

    @Test
    fun `parentPathOf and cover threshold`() {
        assertEquals(CirclesLayout.ROOT_PATH, CirclesLayout.parentPathOf("a.md"))
        assertEquals("dir", CirclesLayout.parentPathOf("dir/b.md"))
        assertEquals(400.0, CirclesLayout.coverFadeThreshold(1000.0, 2000.0), 1e-6)
    }

    @Test
    fun `hitTest returns deepest file at a point when zoomed in`() {
        val root = CirclesLayout.build(listOf(file("a.md"), file("b.md")))!!
        val target = CirclesLayout.findNode(root, "a.md")!!
        // at k=1 the file may be sub-pixel; zoom so it's clickable
        val k = 2.0
        val hit = CirclesLayout.hitTest(root, target.x, target.y, k, CirclesLayout.coverFadeThreshold(1000.0, 1000.0))
        assertNotNull(hit)
        assertEquals("a.md", hit!!.path)
    }

    @Test
    fun `truncateLabel binary-search fits`() {
        val measure: (String) -> Double = { it.length.toDouble() }
        assertEquals("hello", CirclesLayout.truncateLabel("hello", 10.0, measure))
        assertEquals("hel…", CirclesLayout.truncateLabel("hello world", 4.0, measure))
        assertNull(CirclesLayout.truncateLabel("hello", 1.0, measure))
    }
}
