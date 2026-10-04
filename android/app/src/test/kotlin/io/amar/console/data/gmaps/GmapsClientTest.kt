package io.amar.console.data.gmaps

import io.amar.console.data.longtail.GPlace
import io.amar.console.data.longtail.LatLon
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GmapsClientTest {
    private fun place(name: String, address: String?) = GPlace(id = "p", name = name, address = address, lat = 0.0, lon = 0.0)

    // placeLocationText — verbatim port of src/utils/gmaps.ts
    @Test fun nameAndAddressJoined() =
        assertEquals("Workhouse Coffee, 62 Oxford Rd, Reading RG1 7LT, UK",
            placeLocationText(place("Workhouse Coffee", "62 Oxford Rd, Reading RG1 7LT, UK")))

    @Test fun addressAloneWhenItStartsWithTheName() =
        assertEquals("Reading Station, Reading RG1 1LZ, UK",
            placeLocationText(place("reading station", "Reading Station, Reading RG1 1LZ, UK")))

    @Test fun nameAloneWithoutAddress() {
        assertEquals("Forbury Gardens", placeLocationText(place("Forbury Gardens", null)))
        assertEquals("Forbury Gardens", placeLocationText(place("Forbury Gardens", "")))
    }

    @Test fun addressAloneWithoutName() =
        assertEquals("1 High St, Reading", placeLocationText(place("", "1 High St, Reading")))

    @Test fun parsesTheLocationFix() {
        assertEquals(LatLon(51.4554429, -0.9637778),
            parseLocationFix("""{"fix":{"lat":51.4554429,"lon":-0.9637778,"tst":1791061158},"live":{}}"""))
        assertNull(parseLocationFix("""{"fix":null}"""))
        assertNull(parseLocationFix("""{"fix":{"lat":"x"}}"""))
        assertNull(parseLocationFix("not json"))
    }

    @Test fun sessionTokenIsStableUntilReset() {
        val s = GmapsSession()
        val t = s.token()
        assertEquals(t, s.token())
        s.reset()
        assertNotEquals(t, s.token())
    }
}
