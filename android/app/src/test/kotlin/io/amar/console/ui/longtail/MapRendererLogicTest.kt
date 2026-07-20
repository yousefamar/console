package io.amar.console.ui.longtail

import io.amar.console.data.longtail.MapCache
import io.amar.console.data.longtail.MeetupEvent
import io.amar.console.data.longtail.OtFix
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MapRendererLogicTest {

    private fun cache(code: String, lat: Double?, lon: Double?, found: Boolean = false, dnf: Boolean = false) =
        MapCache(code, code, lat, lon, "Traditional", "", 1.0, 1.0, found, dnf, false, "", "", 0, "enabled")

    private fun event(id: String, lat: Double?, lon: Double?) =
        MeetupEvent(id, id, "", "", "", "PHYSICAL", false, 0, "", "", "", "", "", lat, lon)

    // --- feature collections --- //

    @Test
    fun `pinsFc emits only coord'd caches with found or dnf props`() {
        val fc = pinsFc(listOf(cache("GC1", 51.4, -0.9, found = true), cache("GC2", null, null)))
        assertTrue(fc.contains("GC1"))
        assertFalse(fc.contains("GC2")) // no coords → skipped
        assertTrue(fc.contains("\"found\":1"))
        assertTrue(fc.contains("\"dnf\":0"))
        // coordinates are [lon, lat]
        assertTrue(fc.contains("[-0.9,51.4]"))
    }

    @Test
    fun `eventsFc skips coordless events`() {
        val fc = eventsFc(listOf(event("e1", 51.4, -0.9), event("e2", null, null)))
        assertTrue(fc.contains("e1"))
        assertFalse(fc.contains("e2"))
    }

    @Test
    fun `trackFc needs at least two points`() {
        assertFalse(trackFc(listOf(OtFix(1.0, 2.0, 0, null))).contains("LineString"))
        val two = trackFc(listOf(OtFix(1.0, 2.0, 0, null), OtFix(3.0, 4.0, 1, null)))
        assertTrue(two.contains("LineString"))
        assertTrue(two.contains("[2.0,1.0]")) // [lon,lat]
    }

    @Test
    fun `currentFc carries device`() {
        val fc = currentFc(listOf(OtFix(1.0, 2.0, 0, "phone")))
        assertTrue(fc.contains("phone"))
        assertTrue(fc.contains("[2.0,1.0]"))
    }

    // --- json escaping --- //

    @Test
    fun `jsonStr escapes quotes and backslashes`() {
        assertEquals("\"a\\\"b\"", jsonStr("a\"b"))
        assertEquals("\"a\\\\b\"", jsonStr("a\\b"))
    }

    // --- emoji extraction from _icon --- //

    @Test
    fun `emoji extraction pulls distinct _icon values`() {
        val gj = """{"features":[{"properties":{"_icon":"✈️"}},{"properties":{"_icon":"📍"}},{"properties":{"_icon":"✈️"}}]}"""
        assertEquals(setOf("✈️", "📍"), emojiInGeojson(gj))
    }

    @Test
    fun `emoji extraction empty when no icons`() {
        assertTrue(emojiInGeojson("""{"features":[]}""").isEmpty())
    }

    // --- stripHtml --- //

    @Test
    fun `stripHtml removes tags and decodes entities`() {
        assertEquals("TFTC", stripHtml("<p>TFTC</p>"))
        assertEquals("a & b", stripHtml("a &amp; b"))
        assertEquals("line1\nline2", stripHtml("line1<br>line2"))
    }

    // --- formatEventTime --- //

    @Test
    fun `formatEventTime formats a valid iso and passes garbage through`() {
        val out = formatEventTime("2026-07-07T19:00:00+01:00")
        assertTrue(out.isNotBlank())
        assertFalse(out.contains("+01:00")) // reformatted, not the raw ISO string
        assertTrue(out.contains(":")) // has a HH:mm time
        assertEquals("", formatEventTime(""))
        assertEquals("nope", formatEventTime("nope"))
    }
}
