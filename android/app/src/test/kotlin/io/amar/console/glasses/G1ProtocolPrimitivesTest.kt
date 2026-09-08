package io.amar.console.glasses

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The three firmware-derived primitives from card ^glad-vole — dismiss (0x4C),
 * system status (0x39), un-pair (0x47). Layouts documented in
 * docs/g1-protocol.md §18.
 */
class G1ProtocolPrimitivesTest {

    @Test
    fun `dismiss carries just the msgId byte`() {
        assertArrayEquals(
            byteArrayOf(0x4C, 0x07),
            G1Protocol.encodeDeleteNotification(7),
        )
    }

    @Test
    fun `dismiss wraps the msgId into one byte`() {
        // 0x4B pushes the same low byte, so dismissal must agree on the wrap.
        assertArrayEquals(
            byteArrayOf(0x4C, 0x01),
            G1Protocol.encodeDeleteNotification(257),
        )
        assertArrayEquals(
            byteArrayOf(0x4C, 0xFF.toByte()),
            G1Protocol.encodeDeleteNotification(255),
        )
    }

    @Test
    fun `status query echoes its own length little-endian`() {
        val q = G1Protocol.encodeSystemStatusQuery()
        // The handler compares bytes[1..2] against the received length and
        // answers 0xFF on a mismatch, so the echo must equal q.size.
        assertEquals(5, q.size)
        assertEquals(G1Protocol.OP_SYSTEM_STATUS, q[0])
        assertEquals(q.size, (q[1].toInt() and 0xFF) or ((q[2].toInt() and 0xFF) shl 8))
    }

    @Test
    fun `status reply reads the app id from byte 5`() {
        val reply = byteArrayOf(0x39, 0x05, 0x00, 0x00, 0x00, 0x03)
        assertEquals(3, G1Protocol.parseSystemStatus(reply))
    }

    @Test
    fun `status reply distinguishes idle from none`() {
        val idle = byteArrayOf(0x39, 0x05, 0x00, 0x00, 0x00, 0x00)
        val none = byteArrayOf(0x39, 0x05, 0x00, 0x00, 0x00, 0xFF.toByte())
        assertEquals(G1Protocol.SYSTEM_APP_IDLE, G1Protocol.parseSystemStatus(idle))
        assertEquals(G1Protocol.SYSTEM_APP_NONE, G1Protocol.parseSystemStatus(none))
    }

    @Test
    fun `status parser rejects short frames and other opcodes`() {
        assertNull(G1Protocol.parseSystemStatus(byteArrayOf(0x39, 0x05, 0x00, 0x00, 0x00)))
        assertNull(G1Protocol.parseSystemStatus(byteArrayOf(0x2C, 0x66, 0x50, 0x00, 0x00, 0x00)))
        assertNull(G1Protocol.parseSystemStatus(ByteArray(0)))
    }

    @Test
    fun `unpair is the bare opcode`() {
        assertArrayEquals(byteArrayOf(0x47), G1Protocol.encodeBtUnpair())
    }
}
