package io.amar.console.data.longtail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GmapsLogicTest {

    private val place = GPlace(
        id = "places/ChIJabc", name = "Workhouse Coffee", address = "King's Road, Reading", lat = 51.455, lon = -0.965,
        types = listOf("cafe", "food", "point_of_interest", "establishment"), rating = 4.6, userRatingCount = 1234,
        googleMapsUri = "https://maps.google.com/?cid=1",
    )

    // --- parsers --- //

    @Test
    fun `parseGmapsStatus reads configured`() {
        assertEquals(true, parseGmapsStatus("""{"configured":true}"""))
        assertEquals(false, parseGmapsStatus("""{"configured":false}"""))
        assertNull(parseGmapsStatus("not json"))
    }

    @Test
    fun `parsePlaces maps hub PlaceResult rows and skips coordless ones`() {
        val raw = """{"results":[
            {"id":"places/A","name":"A","address":"1 St","lat":51.4,"lon":-0.9,"types":["cafe"],"rating":4.2,"userRatingCount":10,"googleMapsUri":"https://g/a"},
            {"id":"places/B","name":"B"},
            {"id":"places/C","name":"C","lat":51.5,"lon":-0.8,"address":null}
        ]}"""
        val out = parsePlaces(raw)
        assertEquals(listOf("places/A", "places/C"), out.map { it.id })
        assertEquals("1 St", out[0].address)
        assertEquals(4.2, out[0].rating!!, 1e-9)
        assertEquals(10, out[0].userRatingCount)
        assertEquals(listOf("cafe"), out[0].types)
        assertNull(out[1].address) // JSON null → absent, not "null"
        assertNull(out[1].rating)
    }

    @Test
    fun `parsePlaceEnvelope unwraps place and tolerates garbage`() {
        assertEquals("X", parsePlaceEnvelope("""{"place":{"id":"p","name":"X","lat":1.0,"lon":2.0}}""")!!.name)
        assertNull(parsePlaceEnvelope("""{"error":"nope"}"""))
        assertNull(parsePlaceEnvelope(""))
    }

    @Test
    fun `parseSuggestions keeps main + secondary text`() {
        val out = parseSuggestions(
            """{"suggestions":[{"placeId":"p1","text":"Workhouse Coffee, King's Road","mainText":"Workhouse Coffee","secondaryText":"King's Road"},{"placeId":"p2","text":"Only text"}]}""",
        )
        assertEquals(2, out.size)
        assertEquals("Workhouse Coffee", out[0].mainText)
        assertEquals("King's Road", out[0].secondaryText)
        assertEquals("Only text", out[1].mainText) // falls back to text
        assertNull(out[1].secondaryText)
        assertTrue(parseSuggestions("""{"suggestions":[]}""").isEmpty())
    }

    @Test
    fun `parseRoutes reads geometry as lon-lat pairs and drops degenerate routes`() {
        val raw = """{"routes":[
            {"description":"M4","durationSec":1800,"distanceMeters":32000,"geometry":{"type":"LineString","coordinates":[[-0.9,51.4],[-0.8,51.5]]}},
            {"durationSec":10,"distanceMeters":5,"geometry":{"type":"LineString","coordinates":[[-0.9,51.4]]}}
        ]}"""
        val out = parseRoutes(raw)
        assertEquals(1, out.size)
        assertEquals("M4", out[0].description)
        assertEquals(1800, out[0].durationSec)
        assertEquals(-0.9 to 51.4, out[0].coordinates.first())
    }

    @Test
    fun `gmapsErrorText prefers the hub error envelope`() {
        assertEquals("API key missing", gmapsErrorText("""{"error":"API key missing"}"""))
        assertEquals("HTTP 500: boom", gmapsErrorText("HTTP 500: boom"))
        assertEquals("request failed", gmapsErrorText(null))
    }

    // --- deep link (MapTab.tsx gmapsDirUrl parity) --- //

    @Test
    fun `gmapsDirUrl encodes destination, mode, stripped place id, optional origin`() {
        val noOrigin = gmapsDirUrl(null, place, GTravelMode.WALK)
        assertTrue(noOrigin.startsWith("https://www.google.com/maps/dir/?api=1"))
        assertTrue(noOrigin.contains("destination=51.455%2C-0.965"))
        assertTrue(noOrigin.contains("travelmode=walking"))
        assertTrue(noOrigin.contains("destination_place_id=ChIJabc")) // "places/" prefix stripped
        assertFalse(noOrigin.contains("origin="))

        val withOrigin = gmapsDirUrl(LatLon(51.0, -1.0), place, GTravelMode.DRIVE)
        assertTrue(withOrigin.contains("origin=51.0%2C-1.0"))
        assertTrue(withOrigin.contains("travelmode=driving"))
    }

    // --- formatters --- //

    @Test
    fun `fmtDuration mirrors the SPA`() {
        assertEquals("—", fmtDuration(0))
        assertEquals("20s", fmtDuration(20))
        assertEquals("1 min", fmtDuration(45)) // rounds like the SPA (Math.round(45/60) = 1)
        assertEquals("3 min", fmtDuration(170))
        assertEquals("1h 5m", fmtDuration(3900))
    }

    @Test
    fun `fmtDistance mirrors the SPA`() {
        assertEquals("", fmtDistance(0))
        assertEquals("850 m", fmtDistance(850))
        assertEquals("1.2 km", fmtDistance(1234))
        assertEquals("32 km", fmtDistance(32000))
    }

    @Test
    fun `fmtRating and placeTypeLabels`() {
        assertEquals("★ 4.6 (1,234)", fmtRating(4.6, 1234))
        assertEquals("★ 4.0", fmtRating(4.0, null))
        assertNull(fmtRating(null, 5))
        assertEquals(listOf("cafe"), placeTypeLabels(place.types))
        assertEquals(listOf("train station", "bus stop"), placeTypeLabels(listOf("train_station", "bus_stop", "point_of_interest")))
    }
}
