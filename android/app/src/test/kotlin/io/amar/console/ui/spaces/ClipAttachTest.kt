package io.amar.console.ui.spaces

import io.amar.console.ui.notes.MAX_ATTACH_BYTES
import io.amar.console.ui.notes.clipExtFor
import io.amar.console.ui.notes.clipTooLarge
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The phone-side gate in front of the hub's `attach` for clips (^hazy-swan):
 *  only webm/mp4, only ≤20 MB — mirrors ATTACH_VIDEO_EXTS / MAX_ATTACH_BYTES in
 *  server/src/kanban/board-ops.ts so a refused clip never uploads first. */
class ClipAttachTest {

    @Test
    fun `ext comes from the MIME, hub-accepted types only`() {
        assertEquals("mp4", clipExtFor("video/mp4"))
        assertEquals("webm", clipExtFor("video/webm"))
        assertEquals("webm", clipExtFor("Video/WEBM; codecs=vp9"))
        assertNull(clipExtFor("video/quicktime"))
        assertNull(clipExtFor("video/x-matroska"))
        assertNull(clipExtFor("image/png"))
    }

    @Test
    fun `size cap is the hub's 20 MB, inclusive`() {
        assertEquals(20L * 1024 * 1024, MAX_ATTACH_BYTES)
        assertFalse(clipTooLarge(MAX_ATTACH_BYTES))
        assertTrue(clipTooLarge(MAX_ATTACH_BYTES + 1))
        assertFalse(clipTooLarge(0))
    }
}
