package io.amar.console.glasses

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Native countdown timer (0x07, `BLE_REQ_PUT_COUNTDOWN_TIMER`) — layout from the
 * firmware's `ble_put_op07`: `[op, seconds u32 LE, enable]`, no length header.
 * docs/g1-protocol.md §21.
 */
class G1CountdownTimerTest {

    @Test
    fun `ten minutes is 600 seconds little-endian with enable set`() {
        assertArrayEquals(
            byteArrayOf(0x07, 0x58, 0x02, 0x00, 0x00, 0x01),
            G1Protocol.encodeCountdownTimer(600),
        )
    }

    @Test
    fun `the seconds field is a full 32-bit little-endian word`() {
        // 99:59:59 = 359999 = 0x00057E3F
        assertArrayEquals(
            byteArrayOf(0x07, 0x3F, 0x7E, 0x05, 0x00, 0x01),
            G1Protocol.encodeCountdownTimer(G1Protocol.COUNTDOWN_MAX_SECONDS),
        )
    }

    @Test
    fun `cancel clears enable and the duration`() {
        assertArrayEquals(
            byteArrayOf(0x07, 0x00, 0x00, 0x00, 0x00, 0x00),
            G1Protocol.encodeCountdownCancel(),
        )
    }

    @Test
    fun `durations the lens cannot format are refused`() {
        assertThrows(IllegalArgumentException::class.java) { G1Protocol.encodeCountdownTimer(-1) }
        assertThrows(IllegalArgumentException::class.java) {
            G1Protocol.encodeCountdownTimer(G1Protocol.COUNTDOWN_MAX_SECONDS + 1)
        }
    }
}
