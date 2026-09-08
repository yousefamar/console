package io.amar.console.glasses

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 0x2C GET_DEVICE_INFO parsing against the captured frames in docs/g1-protocol.md §12. */
class G1DeviceInfoTest {

    private fun hex(s: String) = s.trim().split(Regex("\\s+")).map { it.toInt(16).toByte() }.toByteArray()

    // Captured 2026-09-07 from the v1.6.6 pair (20-byte replies).
    private val right = hex("2c 66 45 3f cd 83 1b 01 06 06 01 06 06 00 00 00 00 00 00 00")
    private val left = hex("2c 66 3f 00 c7 88 1c 00 00 00 01 06 06 00 00 00 00 00 00 00")

    @Test
    fun `right arm reports battery plus master and slave versions`() {
        val info = G1Protocol.parseDeviceInfo(right)!!
        assertEquals(0x45, info.batteryPct)
        assertEquals("1.6.6", info.masterFirmware)
        assertEquals("1.6.6", info.slaveFirmware)
        assertEquals("1.6.6", info.firmwareFor(G1Protocol.Arm.RIGHT))
    }

    @Test
    fun `left arm leaves the master slot zero and reports itself as slave`() {
        val info = G1Protocol.parseDeviceInfo(left)!!
        assertEquals(0x3f, info.batteryPct)
        assertNull(info.masterFirmware)
        assertEquals("1.6.6", info.slaveFirmware)
        assertEquals("1.6.6", info.firmwareFor(G1Protocol.Arm.LEFT))
    }

    @Test
    fun `firmwareFor falls back to the other slot when its own is zero`() {
        // A slave-shaped reply asked for the RIGHT arm's version still yields one.
        assertEquals("1.6.6", G1Protocol.parseDeviceInfo(left)!!.firmwareFor(G1Protocol.Arm.RIGHT))
    }

    @Test
    fun `short MentraOS-shaped reply still yields battery and no firmware`() {
        val info = G1Protocol.parseDeviceInfo(hex("2c 66 50"))!!
        assertEquals(80, info.batteryPct)
        assertNull(info.masterFirmware)
        assertNull(info.slaveFirmware)
        assertEquals(80, G1Protocol.parseBatteryReply(hex("2c 66 50")))
    }

    @Test
    fun `battery path is unchanged - magic and range still gate it`() {
        assertNull(G1Protocol.parseBatteryReply(hex("2c 65 50")))
        assertNull(G1Protocol.parseBatteryReply(hex("2c 66 c8")))
        assertNull(G1Protocol.parseDeviceInfo(hex("2d 66 50")))
        // Out-of-range percent no longer discards the firmware bytes.
        val info = G1Protocol.parseDeviceInfo(hex("2c 66 c8 00 00 00 00 01 06 06 00 00 00"))!!
        assertNull(info.batteryPct)
        assertEquals("1.6.6", info.masterFirmware)
    }
}
