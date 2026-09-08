package io.amar.console.glasses

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Byte-exact checks against the firmware handler's reads (docs/g1-protocol.md §20). */
class G1TeleprompterTest {

    private fun b(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }
    private val ts = 0x0102030405060708L
    private val tsLE = b(0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01)

    @Test
    fun `single-packet init carries countdown at byte 9, text from byte 12 and the timestamp last`() {
        val pkts = G1Protocol.encodeTeleprompterPage(0x2A, G1Protocol.Teleprompter.ACTION_INIT, "Hi", countdown = 3, timestampMs = ts)
        assertEquals(1, pkts.size)
        // len = 12 + 2 + 8 = 22; total 1, pkt 1; p9 = countdown, p10/p11 = 0
        assertArrayEquals(
            b(0x09, 22, 0x00, 0x2A, 0x01, 0x01, 0x00, 0x01, 0x00, 0x03, 0x00, 0x00, 'H'.code, 'i'.code) + tsLE,
            pkts[0],
        )
    }

    @Test
    fun `text pages put the u16 mark position in bytes 10-11 and use action 3`() {
        val pkt = G1Protocol.encodeTeleprompterPage(1, G1Protocol.Teleprompter.ACTION_TEXT, "x", markPos = 0x1234, timestampMs = ts).single()
        assertEquals(0x03, pkt[4].toInt())
        assertEquals(0x00, pkt[9].toInt())
        assertEquals(0x34, pkt[10].toInt() and 0xFF)
        assertEquals(0x12, pkt[11].toInt() and 0xFF)
        assertEquals(21, pkt.size)
    }

    @Test
    fun `long pages split into 1-based packets, only the last carrying the timestamp, whole-frame lengths`() {
        val text = "a".repeat(500)
        val pkts = G1Protocol.encodeTeleprompterPage(7, G1Protocol.Teleprompter.ACTION_TEXT, text, timestampMs = ts)
        assertEquals(3, pkts.size)
        for ((i, p) in pkts.withIndex()) {
            assertEquals(p.size, (p[1].toInt() and 0xFF) or ((p[2].toInt() and 0xFF) shl 8))
            assertEquals(3, p[5].toInt()); assertEquals(0, p[6].toInt())
            assertEquals(i + 1, p[7].toInt()); assertEquals(0, p[8].toInt())
        }
        assertEquals(12 + G1Protocol.Teleprompter.CHUNK_BODY, pkts[0].size)
        assertEquals(12 + G1Protocol.Teleprompter.CHUNK_BODY, pkts[1].size)
        val restText = 500 - 2 * G1Protocol.Teleprompter.CHUNK_BODY
        assertEquals(12 + restText + 8, pkts[2].size)
        assertArrayEquals(tsLE, pkts[2].copyOfRange(pkts[2].size - 8, pkts[2].size))
        // Reassembled text is intact.
        val joined = pkts.mapIndexed { i, p -> p.copyOfRange(12, if (i == 2) p.size - 8 else p.size) }.reduce { a, c -> a + c }
        assertEquals(text, String(joined, Charsets.UTF_8))
    }

    @Test
    fun `forceMultipart halves a short page on a UTF-8 boundary`() {
        val pkts = G1Protocol.encodeTeleprompterPage(1, G1Protocol.Teleprompter.ACTION_INIT, "héllo", timestampMs = ts, forceMultipart = true)
        assertEquals(2, pkts.size)
        val joined = pkts[0].copyOfRange(12, pkts[0].size) + pkts[1].copyOfRange(12, pkts[1].size - 8)
        assertEquals("héllo", String(joined, Charsets.UTF_8))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a page over 512 bytes is refused before any write`() {
        G1Protocol.encodeTeleprompterPage(1, G1Protocol.Teleprompter.ACTION_TEXT, "z".repeat(513))
    }

    @Test
    fun `mark and exit frames`() {
        assertArrayEquals(b(0x09, 16, 0x00, 0x05, 0x02, 0x00, 0x34, 0x12) + tsLE, G1Protocol.encodeTeleprompterMark(5, 0x1234, ts))
        assertArrayEquals(b(0x09, 0x06, 0x00, 0x09, 0x05, 0x00), G1Protocol.encodeTeleprompterExit(9))
    }

    @Test
    fun `acks - page acks read status at byte 9, mark and exit echoes are always ok, no 0xC9 involved`() {
        val okPage = b(0x09, 22, 0x00, 0x2A, 0x01, 0x01, 0x00, 0x01, 0x00, 0x00)
        val orderErr = b(0x09, 22, 0x00, 0x2A, 0x03, 0x02, 0x00, 0x02, 0x00, 0x01)
        assertTrue(G1Protocol.parseAck(G1Protocol.OP_TELEPROMPTER, okPage)!!.ok)
        assertFalse(G1Protocol.parseAck(G1Protocol.OP_TELEPROMPTER, orderErr)!!.ok)
        assertTrue(G1Protocol.parseAck(G1Protocol.OP_TELEPROMPTER, b(0x09, 0x06, 0x00, 0x09, 0x05, 0x00))!!.ok)
        assertTrue(G1Protocol.parseAck(G1Protocol.OP_TELEPROMPTER, b(0x09, 16, 0x00, 0x05, 0x02, 0x00))!!.ok)
        assertNull(G1Protocol.parseTeleprompterAck(b(0x0A, 0x06, 0x00, 0x01, 0x05, 0x01)))
    }
}
