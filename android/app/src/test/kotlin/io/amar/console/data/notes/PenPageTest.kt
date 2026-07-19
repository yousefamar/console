package io.amar.console.data.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PenPageTest {

    private fun svgWith(penpage: String) = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="5.5 4.5 39 60" width="480" height="740">
          <metadata><penpage>$penpage</penpage></metadata>
          <path d="M1 1L2 2" fill="#111"/>
        </svg>
    """.trimIndent()

    @Test
    fun `parses strokes with dots x-y-force`() {
        val doc = PenPage.parse(
            svgWith(
                """{"v":1,"section":3,"owner":1013,"note":727,"page":4,"unit":"ncode",
                   "bbox":{"minX":10,"minY":10,"maxX":20,"maxY":20},
                   "strokes":[{"dots":[{"x":10.5,"y":11.25,"force":200,"t":0},{"x":12,"y":13,"force":300,"t":10}]},
                              {"dots":[{"x":20,"y":20,"force":100,"t":50}]}],
                   "updatedAt":123}"""
            )
        )
        assertNotNull(doc)
        assertEquals(2, doc!!.strokes.size)
        assertEquals(2, doc.strokes[0].dots.size)
        assertEquals(10.5f, doc.strokes[0].dots[0].x, 1e-4f)
        assertEquals(11.25f, doc.strokes[0].dots[0].y, 1e-4f)
        assertEquals(200f, doc.strokes[0].dots[0].force, 1e-4f)
    }

    @Test
    fun `accepts points and f aliases`() {
        val doc = PenPage.parse(
            svgWith("""{"strokes":[{"points":[{"x":1,"y":2,"f":5}]}]}""")
        )
        assertNotNull(doc)
        assertEquals(5f, doc!!.strokes[0].dots[0].force, 1e-4f)
    }

    @Test
    fun `view box is the fixed page rect, expanding only past the page edge`() {
        val inside = PenPage.parse(svgWith("""{"strokes":[{"dots":[{"x":10,"y":10,"force":1}]}]}"""))!!
        assertEquals(PenPage.NCODE_PAGE_X0, inside.viewX, 1e-3f)
        assertEquals(PenPage.NCODE_PAGE_W, inside.viewW, 1e-3f)

        val outside = PenPage.parse(svgWith("""{"strokes":[{"dots":[{"x":60,"y":10,"force":1}]}]}"""))!!
        assertTrue(outside.viewX + outside.viewW >= 60f)
    }

    @Test
    fun `foreign svg (no penpage metadata) and garbage return null`() {
        assertNull(PenPage.parse("<svg><path d=\"M0 0\"/></svg>"))
        assertNull(PenPage.parse(svgWith("not json")))
    }

    @Test
    fun `path helpers`() {
        assertTrue(PenPage.isPenPagePath("scratch/pen/727/page-4.svg"))
        assertTrue(!PenPage.isPenPagePath("scratch/other/page-4.svg"))
        assertTrue(!PenPage.isPenPagePath("scratch/pen/727/notes.md"))
        assertEquals(4, PenPage.pageNumber("scratch/pen/727/page-4.svg"))
        assertNull(PenPage.pageNumber("scratch/pen/727/cover.svg"))
    }

    @Test
    fun `sibling pages sorted numerically within the same notebook`() {
        val all = listOf(
            "scratch/pen/727/page-10.svg",
            "scratch/pen/727/page-2.svg",
            "scratch/pen/999/page-1.svg",
            "scratch/pen/727/page-1.svg",
            "scratch/pen/727/readme.md",
        )
        assertEquals(
            listOf("scratch/pen/727/page-1.svg", "scratch/pen/727/page-2.svg", "scratch/pen/727/page-10.svg"),
            PenPage.siblingPages("scratch/pen/727/page-2.svg", all),
        )
    }
}
