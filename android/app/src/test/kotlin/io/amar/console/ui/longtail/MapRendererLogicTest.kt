package io.amar.console.ui.longtail

import io.amar.console.data.longtail.FenceState
import io.amar.console.data.longtail.GPlace
import io.amar.console.data.longtail.GRoute
import io.amar.console.data.longtail.LocationFeed
import io.amar.console.data.longtail.MapCache
import io.amar.console.data.longtail.MapFence
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
    fun `placesFc keys pins by place id`() {
        val fc = placesFc(listOf(GPlace("places/A", "A", null, 51.4, -0.9), GPlace("places/B", "B", null, 51.5, -0.8)))
        assertTrue(fc.contains("\"id\":\"places/A\""))
        assertTrue(fc.contains("[-0.8,51.5]"))
        assertEquals(MapRenderer.emptyFc(), placesFc(emptyList()))
    }

    @Test
    fun `routesFc flags exactly the selected route and routeBbox spans all coords`() {
        val r1 = GRoute("M4", 100, 1000, listOf(-0.9 to 51.4, -0.8 to 51.5))
        val r2 = GRoute(null, 200, 2000, listOf(-0.9 to 51.4, -1.0 to 51.3))
        val fc = routesFc(listOf(r1, r2), 1)
        assertTrue(fc.contains("\"idx\":0,\"selected\":0"))
        assertTrue(fc.contains("\"idx\":1,\"selected\":1"))
        assertEquals(listOf(-0.9, 51.4, -0.8, 51.5), routeBbox(r1))
        assertEquals(null, routeBbox(GRoute(null, 0, 0, emptyList())))
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

    // --- geofences (MapTab.tsx circleRing / fencesToFC / fenceLabelsToFC) --- //

    private fun fence(
        id: String, lat: Double = 51.45, lon: Double = -0.97, radius: Double = 150.0,
        state: FenceState? = null, private: Boolean = false, wake: List<String> = emptyList(),
        note: String? = null, expiresAt: Long? = null,
    ) = MapFence(id, id, lat, lon, radius, private, note, wake, expiresAt, state)

    @Test
    fun `circleRing is a closed ring of steps+1 lon-lat points at the requested radius`() {
        val ring = circleRing(51.45, -0.97, 150.0)
        assertEquals(65, ring.size)
        assertEquals(ring.first(), ring.last()) // GeoJSON closure
        // angle 0 → due east of the centre by 150 m; angle π/2 (index 16) → due north
        val (e, eLat) = ring[0]
        assertEquals(51.45, eLat, 1e-9)
        assertEquals(150.0 / (METRES_PER_DEG_LAT * Math.cos(Math.toRadians(51.45))), e - (-0.97), 1e-9)
        val (nLon, nLat) = ring[16]
        assertEquals(-0.97, nLon, 1e-9)
        assertEquals(51.45 + 150.0 / METRES_PER_DEG_LAT, nLat, 1e-9)
        // every point is ~150 m from the centre (equirectangular, so exact)
        for ((lon, lat) in ring) {
            val dx = (lon + 0.97) * METRES_PER_DEG_LAT * Math.cos(Math.toRadians(51.45))
            val dy = (lat - 51.45) * METRES_PER_DEG_LAT
            assertEquals(150.0, Math.hypot(dx, dy), 1e-6)
        }
        assertEquals(9, circleRing(0.0, 0.0, 10.0, steps = 8).size)
    }

    @Test
    fun `fencesFc flags inside known private and carries popup fields`() {
        val inside = fence("home", state = FenceState(inside = true, since = 1_700_000_000_000, tst = 1_700_000_000), private = true, wake = listOf("al", "ceo"), note = "n\"q", expiresAt = 42L)
        val outside = fence("gym", state = FenceState(inside = false, since = 5, tst = 6))
        val unknown = fence("new")
        val fc = fencesFc(listOf(inside, outside, unknown))
        assertTrue(fc.contains("\"type\":\"Polygon\""))
        assertTrue(fc.contains("\"id\":\"home\",\"name\":\"home\",\"radius\":150.0,\"inside\":1,\"known\":1,\"private\":1,\"since\":1700000000000"))
        assertTrue(fc.contains("\"wake\":\"al, ceo\""))
        assertTrue(fc.contains("\"note\":\"n\\\"q\"")) // escaped through jsonStr
        assertTrue(fc.contains("\"expiresAt\":42"))
        assertTrue(fc.contains("\"id\":\"gym\",\"name\":\"gym\",\"radius\":150.0,\"inside\":0,\"known\":1,\"private\":0"))
        assertTrue(fc.contains("\"id\":\"new\",\"name\":\"new\",\"radius\":150.0,\"inside\":0,\"known\":0,\"private\":0,\"since\":0"))
        assertTrue(fc.contains("\"expiresAt\":0}")) // null → 0, the SPA's "no expiry"
        assertEquals(MapRenderer.emptyFc(), fencesFc(emptyList()))
    }

    @Test
    fun `fencesFc polygon ring is closed and lon-lat ordered`() {
        val fc = fencesFc(listOf(fence("f", lat = 10.0, lon = 20.0, radius = 100.0)))
        val ring = circleRing(10.0, 20.0, 100.0)
        val first = "[${ring.first().first},${ring.first().second}]"
        assertTrue(fc.contains("\"coordinates\":[[$first,"))
        assertTrue(fc.contains(",$first]]}")) // last point == first point
    }

    @Test
    fun `fenceLabelsFc sits the label on the north edge and mirrors inside`() {
        val fc = fenceLabelsFc(listOf(fence("home", lat = 51.45, lon = -0.97, radius = 111.32, state = FenceState(true, 0, 0))))
        assertTrue(fc.contains("\"type\":\"Point\""))
        assertTrue(fc.contains("\"coordinates\":[-0.97,51.451]")) // 111.32 m = 0.001°
        assertTrue(fc.contains("\"inside\":1"))
        assertEquals(MapRenderer.emptyFc(), fenceLabelsFc(emptyList()))
    }

    // --- feed dot / since formatting (MapTab.tsx feedTitle / fmtSince) --- //

    @Test
    fun `fmtSince buckets seconds minutes hours days and never goes negative`() {
        val now = 1_000_000_000_000L
        assertEquals("42 s", fmtSince(now - 42_000, now))
        assertEquals("5 min", fmtSince(now - 5 * 60_000, now))
        assertEquals("1.5 h", fmtSince(now - 90 * 60_000, now))
        assertEquals("3 d", fmtSince(now - 3 * 86_400_000, now))
        assertEquals("0 s", fmtSince(now + 10_000, now))
    }

    @Test
    fun `feedTitle words each feed state`() {
        assertEquals("live feed: unknown", feedTitle(null))
        assertTrue(feedTitle(LocationFeed("connected", 1, null, 0, null)).startsWith("live feed connected"))
        assertTrue(feedTitle(LocationFeed("connected", 1, 1, 2, null)).endsWith(", 2 reconnects"))
        assertEquals("live feed reconnecting (closed 1006)", feedTitle(LocationFeed("connecting", null, null, 1, "closed 1006")))
        assertEquals("no live feed — OwnTracks not configured", feedTitle(LocationFeed("polling", null, null, 0, "OwnTracks not configured")))
        assertEquals("live feed stopped", feedTitle(LocationFeed("stopped", null, null, 0, null)))
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
