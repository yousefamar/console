package io.amar.console.data.mail

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CidResolverTest {

    @Test
    fun `finds cid refs in html`() {
        val html = """<img src="cid:img1@mail"><img src='cid:img2'><p>cid:not-in-attr</p>"""
        val refs = CidResolver.findCidRefs(html)
        assertTrue("img1@mail" in refs)
        assertTrue("img2" in refs)
    }

    @Test
    fun `parses contentId attachments only`() {
        val json = """[
            {"messageId":"m1","attachmentId":"a1","filename":"logo.png","mimeType":"image/png","size":10,"contentId":"img1@mail"},
            {"messageId":"m1","attachmentId":"a2","filename":"doc.pdf","mimeType":"application/pdf","size":99}
        ]"""
        val atts = CidResolver.parseCidAttachments(json)
        assertEquals(1, atts.size)
        assertEquals("img1@mail", atts[0].contentId)
    }

    @Test
    fun `inlines resolvable cids and blanks unresolvable ones`() = runTest {
        val html = """<img src="cid:known"><img src="cid:unknown">"""
        val atts = listOf(CidResolver.CidAttachment("known", "m1", "a1", "image/png"))
        val out = CidResolver.inline(html, atts) { "QUJD" } // "ABC"
        assertTrue(out.contains("data:image/png;base64,QUJD"))
        assertTrue(!out.contains("cid:known"))
        assertTrue(out.contains("data:image/gif;base64")) // transparent pixel for unknown
        assertTrue(!out.contains("cid:unknown"))
    }

    @Test
    fun `fetch failure degrades to transparent pixel`() = runTest {
        val html = """<img src="cid:x">"""
        val atts = listOf(CidResolver.CidAttachment("x", "m1", "a1", "image/png"))
        val out = CidResolver.inline(html, atts) { null }
        assertTrue(out.contains("data:image/gif;base64"))
    }
}
