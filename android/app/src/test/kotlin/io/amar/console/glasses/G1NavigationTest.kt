package io.amar.console.glasses

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Byte-exact against the firmware handler (docs/g1-protocol.md §18). */
class G1NavigationTest {

    private fun b(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

    @Test
    fun `start, sync and exit are five or six byte frames with the whole-frame length`() {
        assertArrayEquals(b(0x0A, 0x05, 0x00, 0x07, 0x00), G1Protocol.encodeNavStart(7))
        assertArrayEquals(b(0x0A, 0x06, 0x00, 0x08, 0x04, 0x01), G1Protocol.encodeNavSync(8))
        assertArrayEquals(b(0x0A, 0x05, 0x00, 0x09, 0x05), G1Protocol.encodeNavExit(9))
    }

    @Test
    fun `step lays out dir, x, y then five NUL-terminated strings in firmware order`() {
        val pkt = G1Protocol.encodeNavStep(
            seq = 0x21, direction = 5, roadName = "High St", distanceToTurn = "200 m",
            timeRemaining = "12 min", routeDistance = "3.4 km", currentSpeed = "30", x = 0x1e8, y = 0x88,
        )
        val expectedBody = b(0x05, 0xE8, 0x01, 0x88, 0x00) +
            "12 min".toByteArray() + b(0) + "3.4 km".toByteArray() + b(0) +
            "High St".toByteArray() + b(0) + "200 m".toByteArray() + b(0) + "30".toByteArray() + b(0)
        assertArrayEquals(b(0x0A, 5 + expectedBody.size, 0x00, 0x21, 0x01) + expectedBody, pkt)
        // Empty optional fields still occupy a NUL each — the scanner needs all five terminators.
        val minimal = G1Protocol.encodeNavStep(1, 1, "A", "B")
        assertEquals(5 + 5 + 2 + 2 + 1 + 1 + 1, minimal.size)
    }

    @Test
    fun `step refuses what the firmware would refuse, before any write`() {
        assertThrows(IllegalArgumentException::class.java) { G1Protocol.encodeNavStep(1, 0, "A", "B") }
        assertThrows(IllegalArgumentException::class.java) { G1Protocol.encodeNavStep(1, 36, "A", "B") }
        assertThrows(IllegalArgumentException::class.java) { G1Protocol.encodeNavStep(1, 1, "x".repeat(64), "B") }
        assertThrows(IllegalArgumentException::class.java) { G1Protocol.encodeNavStep(1, 1, "A", "x".repeat(24)) }
        assertThrows(IllegalArgumentException::class.java) { G1Protocol.encodeNavStep(1, 1, "A", "B", x = 489) }
        // Exactly at the limit is fine (buffer holds len + NUL).
        G1Protocol.encodeNavStep(1, 35, "x".repeat(63), "y".repeat(23), x = 488, y = 136)
    }

    @Test
    fun `arrived carries status then the raw prompt, no NUL`() {
        val prompt = "Arrivé".toByteArray() // 7 UTF-8 bytes → frame 13
        assertArrayEquals(b(0x0A, 0x0D, 0x00, 0x03, 0x06, 0x02) + prompt, G1Protocol.encodeNavArrived(3, 2, "Arrivé"))
        assertThrows(IllegalArgumentException::class.java) { G1Protocol.encodeNavArrived(1, 3, "x") }
        assertThrows(IllegalArgumentException::class.java) { G1Protocol.encodeNavArrived(1, 1, "x".repeat(64)) }
    }

    @Test
    fun `rle is count-value pairs capped at 255`() {
        assertArrayEquals(b(3, 0x00, 1, 0xFF, 2, 0x0F), G1Protocol.rleEncode(b(0, 0, 0, 0xFF, 0x0F, 0x0F)))
        val long = ByteArray(300)
        assertArrayEquals(b(255, 0, 45, 0), G1Protocol.rleEncode(long))
    }

    @Test
    fun `overview map chunks carry total and 1-based index, data from byte 9, and raw payload when RLE would not shrink`() {
        val planes = ByteArray(G1Protocol.Nav.OVERVIEW_RAW_BYTES) // all zero → RLE = 19 pairs
        val chunks = G1Protocol.encodeNavMapChunks(0x11, panoramic = false, planes = planes)
        assertEquals(1, chunks.size)
        val c = chunks[0]
        assertArrayEquals(b(0x0A, c.size and 0xFF, c.size shr 8, 0x11, 0x02, 0x01, 0x00, 0x01, 0x00), c.copyOfRange(0, 9))
        assertEquals(G1Protocol.rleEncode(planes).size, c.size - 9)

        val noisy = ByteArray(G1Protocol.Nav.OVERVIEW_RAW_BYTES) { (it * 7 + 3).toByte() } // RLE would grow → raw
        val raw = G1Protocol.encodeNavMapChunks(0x12, panoramic = false, planes = noisy)
        val total = (G1Protocol.Nav.OVERVIEW_RAW_BYTES + G1Protocol.Nav.MAP_CHUNK_BODY - 1) / G1Protocol.Nav.MAP_CHUNK_BODY
        assertEquals(total, raw.size)
        assertEquals(G1Protocol.Nav.OVERVIEW_RAW_BYTES, raw.sumOf { it.size - 9 })
        assertArrayEquals(b(total and 0xFF, total shr 8, total and 0xFF, total shr 8), raw.last().copyOfRange(5, 9))
        assertThrows(IllegalArgumentException::class.java) { G1Protocol.encodeNavMapChunks(1, false, ByteArray(10)) }
    }

    @Test
    fun `panoramic map chunks insert the flag byte so data starts at byte 10`() {
        val planes = ByteArray(G1Protocol.Nav.PANORAMIC_RAW_BYTES)
        val c = G1Protocol.encodeNavMapChunks(0x13, panoramic = true, planes = planes).single()
        assertEquals(0x03, c[4].toInt())
        assertEquals(0x00, c[9].toInt())
        assertEquals(G1Protocol.rleEncode(planes).size, c.size - 10)
    }

    @Test
    fun `nav acks decode per subcommand and never look for 0xC9`() {
        assertTrue(G1Protocol.parseAck(G1Protocol.OP_NAVIGATION, b(0x0A, 0x06, 0x00, 0xC9, 0x01, 0x00))!!.ok)   // seq happens to be 0xC9
        assertFalse(G1Protocol.parseAck(G1Protocol.OP_NAVIGATION, b(0x0A, 0x06, 0x00, 0x01, 0x01, 0x01))!!.ok)  // step refused
        assertTrue(G1Protocol.parseAck(G1Protocol.OP_NAVIGATION, b(0x0A, 0x06, 0x00, 0x01, 0x04, 0x01))!!.ok)   // sync: running
        assertFalse(G1Protocol.parseAck(G1Protocol.OP_NAVIGATION, b(0x0A, 0x06, 0x00, 0x01, 0x04, 0x00))!!.ok)  // sync: not started
        assertTrue(G1Protocol.parseAck(G1Protocol.OP_NAVIGATION, b(0x0A, 0x06, 0x00, 0x01, 0x05, 0x01))!!.ok)   // exit
        assertTrue(G1Protocol.parseAck(G1Protocol.OP_NAVIGATION, b(0x0A, 0x0A, 0x00, 0x01, 0x02, 1, 0, 1, 0, 0x00))!!.ok)   // overview chunk
        assertFalse(G1Protocol.parseAck(G1Protocol.OP_NAVIGATION, b(0x0A, 0x0B, 0x00, 0x01, 0x03, 1, 0, 1, 0, 0, 0x01))!!.ok) // panoramic chunk refused
        assertNull(G1Protocol.parseAck(G1Protocol.OP_NAVIGATION, b(0x0A, 0x05)))
    }
}
