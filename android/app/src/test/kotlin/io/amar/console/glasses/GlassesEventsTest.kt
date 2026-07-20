package io.amar.console.glasses

import org.junit.Assert.assertEquals
import org.junit.Test

/** Classifier parity with src/glasses/events.ts. */
class GlassesEventsTest {

    @Test
    fun `classify maps the verified subcmds`() {
        assertEquals(GlassesEvents.Kind.TAP_DOUBLE, GlassesEvents.classify(0x00))
        assertEquals(GlassesEvents.Kind.TAP_SINGLE, GlassesEvents.classify(0x01))
        assertEquals(GlassesEvents.Kind.HEAD_UP, GlassesEvents.classify(0x02))
        assertEquals(GlassesEvents.Kind.HEAD_DOWN, GlassesEvents.classify(0x03))
        assertEquals(GlassesEvents.Kind.TAP_TRIPLE, GlassesEvents.classify(0x04))
        assertEquals(GlassesEvents.Kind.TAP_TRIPLE, GlassesEvents.classify(0x05))
        assertEquals(GlassesEvents.Kind.CASE_REMOVED, GlassesEvents.classify(0x06))
        assertEquals(GlassesEvents.Kind.CASE_REMOVED, GlassesEvents.classify(0x07))
        assertEquals(GlassesEvents.Kind.CASE_OPENED, GlassesEvents.classify(0x08))
        assertEquals(GlassesEvents.Kind.CASE_CLOSED, GlassesEvents.classify(0x0b))
        assertEquals(GlassesEvents.Kind.CASE_CHARGING, GlassesEvents.classify(0x0e))
        assertEquals(GlassesEvents.Kind.CASE_BATTERY, GlassesEvents.classify(0x0f))
        assertEquals(GlassesEvents.Kind.CONNECTED, GlassesEvents.classify(0x11))
        assertEquals(GlassesEvents.Kind.LONGPRESS_START, GlassesEvents.classify(0x17))
        assertEquals(GlassesEvents.Kind.LONGPRESS_END, GlassesEvents.classify(0x18))
        assertEquals(GlassesEvents.Kind.DASHBOARD_SHOW, GlassesEvents.classify(0x1e))
        assertEquals(GlassesEvents.Kind.DASHBOARD_HIDE, GlassesEvents.classify(0x1f))
        assertEquals(GlassesEvents.Kind.TAP_DOUBLE, GlassesEvents.classify(0x20))
    }

    @Test
    fun `classify falls back to UNKNOWN for undocumented subcmds`() {
        assertEquals(GlassesEvents.Kind.UNKNOWN, GlassesEvents.classify(0x0a))
        assertEquals(GlassesEvents.Kind.UNKNOWN, GlassesEvents.classify(0x99))
    }

    @Test
    fun `label is kebab-cased for the debug panel`() {
        assertEquals("head-down", GlassesEvents.Kind.HEAD_DOWN.label())
        assertEquals("longpress-start", GlassesEvents.Kind.LONGPRESS_START.label())
        assertEquals("tap-double", GlassesEvents.Kind.TAP_DOUBLE.label())
    }

    @Test
    fun `record keeps at most 20 events, newest last`() {
        // DebugAgent.log is a no-op without a started scope; record still rings.
        for (i in 0 until 25) GlassesEvents.record(G1Protocol.Arm.LEFT, (i and 0xFF).toByte())
        val recent = GlassesEvents.recent()
        assertEquals(20, recent.size)
        // Oldest kept is event #5 (subcmd 5); newest is #24 (subcmd 24).
        assertEquals(5, recent.first().subcmd)
        assertEquals(24, recent.last().subcmd)
    }
}
