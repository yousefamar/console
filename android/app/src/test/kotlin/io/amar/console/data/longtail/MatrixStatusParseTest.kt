package io.amar.console.data.longtail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** parseMatrixStatus parity with GET /matrix/hub/status (server/src/routes/matrix.ts). */
class MatrixStatusParseTest {

    @Test
    fun `connected status carries the mxid and homeserver`() {
        val s = parseMatrixStatus(
            """{"cryptoReady":true,"hasCredentials":true,"userId":"@me:beeper.com","deviceId":"ABC","homeserver":"https://matrix.beeper.com"}"""
        )!!
        assertTrue(s.connected)
        assertEquals("@me:beeper.com", s.userId)
        assertEquals("ABC", s.deviceId)
        assertEquals("https://matrix.beeper.com", s.homeserver)
    }

    @Test
    fun `no credentials reads as disconnected`() {
        val s = parseMatrixStatus("""{"cryptoReady":false,"hasCredentials":false}""")!!
        assertFalse(s.connected)
        assertNull(s.userId)
    }

    @Test
    fun `garbage yields null`() {
        assertNull(parseMatrixStatus("not json"))
    }
}
