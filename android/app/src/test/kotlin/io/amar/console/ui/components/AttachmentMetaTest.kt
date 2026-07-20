package io.amar.console.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

class AttachmentMetaTest {
    @Test fun `bytes below KB`() {
        assertEquals("0 B", formatBytes(0))
        assertEquals("512 B", formatBytes(512))
        assertEquals("1023 B", formatBytes(1023))
    }

    @Test fun `kilobytes are integer`() {
        assertEquals("1 KB", formatBytes(1024))
        assertEquals("2 KB", formatBytes(2048))
        assertEquals("1023 KB", formatBytes(1024 * 1023))
    }

    @Test fun `megabytes are one decimal`() {
        assertEquals("1.0 MB", formatBytes(1024L * 1024))
        assertEquals("1.5 MB", formatBytes((1.5 * 1024 * 1024).toLong()))
        assertEquals("10.0 MB", formatBytes(10L * 1024 * 1024))
    }

    @Test fun `negative size is blank`() {
        assertEquals("", formatBytes(-1))
    }
}
