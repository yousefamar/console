package io.amar.console.data.longtail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PropertyDeckLogicTest {

    private val deckJson = """
        {"cards":[
          {"listingId":"165","searchId":"ps_uk","kind":"house","tier":"gold","portal":"rightmove","alsoOn":["onthemarket"],"country":"UK",
           "url":"https://www.rightmove.co.uk/properties/165","title":"3 bedroom detached house for sale","address":"High St, Lewes",
           "price":285000,"currency":"GBP","bedrooms":3,"bathrooms":1,"floorArea":98,"plotArea":1250,"propertyType":"Detached","tenure":"freehold",
           "listedAt":"2026-09-10T09:00:00Z","agent":"Fox & Sons","image":"https://media.rightmove.co.uk/x.jpg","summary":"A house.",
           "keyFeatures":["Garden","Garage"],"description":"Long text","fixer":true,"highStreet":"320 m to shops","airport":"42min drive to LGW","lat":50.87,"lon":0.01},
          {"listingId":"77","searchId":"ps_it","kind":"house","portal":"immobiliare","alsoOn":[],"country":"IT","url":"https://immobiliare.it/77",
           "currency":"EUR","fixer":false,"lat":43.1,"lon":11.2},
          {"searchId":"ps_x","kind":"house","portal":"rightmove","currency":"GBP","lat":0,"lon":0}
        ],"total":412,"counts":{"house":412,"farmland":38,"plot":5}}
    """.trimIndent()

    @Test
    fun `parse keeps every field, tolerates omissions, drops a card without ids`() {
        val deck = parsePropertyDeck(deckJson)!!
        assertEquals(2, deck.cards.size) // the id-less third card is dropped
        assertEquals(412, deck.total)
        assertEquals(mapOf("house" to 412, "farmland" to 38, "plot" to 5), deck.counts)
        val c = deck.cards[0]
        assertEquals("ps_uk/165", c.key)
        assertEquals("gold", c.tier)
        assertEquals(listOf("onthemarket"), c.alsoOn)
        assertEquals(285000.0, c.price!!, 0.0)
        assertEquals(3, c.bedrooms)
        assertEquals(1250.0, c.plotArea!!, 0.0)
        assertEquals("freehold", c.tenure)
        assertEquals(listOf("Garden", "Garage"), c.keyFeatures)
        assertTrue(c.fixer)
        assertEquals("320 m to shops", c.highStreet)
        val it = deck.cards[1]
        assertNull(it.price)
        assertNull(it.tier)
        assertNull(it.listedAt)
        assertTrue(it.keyFeatures.isEmpty())
        assertFalse(it.fixer)
    }

    @Test
    fun `parse rejects junk`() {
        assertNull(parsePropertyDeck("not json"))
        assertNull(parsePropertyDeck("[]"))
        assertEquals(0, parsePropertyDeck("{}")!!.cards.size)
    }

    @Test
    fun `price and area formatting`() {
        assertEquals("£285,000", formatPrice(285000.0, "GBP"))
        assertEquals("€1,200,000", formatPrice(1200000.0, "EUR"))
        assertEquals("950,000 CHF", formatPrice(950000.0, "CHF"))
        assertNull(formatPrice(null, "GBP"))
        assertEquals("98 m²", formatArea(98.4))
        assertEquals("1250 m²", formatArea(1250.0, land = true))
        assertEquals("1.2 ha", formatArea(12345.0, land = true))
        assertEquals("12345 m²", formatArea(12345.0)) // floor area never goes to hectares
        assertNull(formatArea(0.0))
        assertNull(formatArea(null))
    }

    @Test
    fun `facts line joins what the listing states and skips the rest`() {
        val c = parsePropertyDeck(deckJson)!!.cards[0]
        assertEquals("3 bed · 1 bath · 98 m² · 1250 m² plot · Detached · Freehold", factsLine(c))
        val bare = parsePropertyDeck(deckJson)!!.cards[1]
        assertEquals("", factsLine(bare))
    }

    @Test
    fun `listedAgo buckets days, weeks, months, accepts date-only`() {
        val now = java.time.OffsetDateTime.parse("2026-09-12T12:00:00Z").toInstant().toEpochMilli()
        assertEquals("today", listedAgo("2026-09-12T09:00:00Z", now))
        assertEquals("3d ago", listedAgo("2026-09-09T09:00:00Z", now))
        assertEquals("2w ago", listedAgo("2026-08-26", now))
        assertEquals("3mo ago", listedAgo("2026-06-10T00:00:00+01:00", now))
        assertEquals("today", listedAgo("2026-09-13T00:00:00Z", now)) // clock skew never reads negative
        assertNull(listedAgo(null, now))
        assertNull(listedAgo("", now))
        assertNull(listedAgo("garbage", now))
    }

    @Test
    fun `swipe verdict commits on distance or a matching fling, otherwise springs back`() {
        val w = 1000f
        assertEquals(Verdict.Interested, swipeVerdict(360f, 0f, w))
        assertEquals(Verdict.Dismissed, swipeVerdict(-360f, 0f, w))
        assertNull(swipeVerdict(200f, 0f, w))
        assertNull(swipeVerdict(-340f, 0f, w))
        // A flick commits from a short drag — but only in the drag's own direction and past a dead zone.
        assertEquals(Verdict.Interested, swipeVerdict(120f, 2500f, w))
        assertEquals(Verdict.Dismissed, swipeVerdict(-120f, -2500f, w))
        assertNull(swipeVerdict(120f, -2500f, w))
        assertNull(swipeVerdict(40f, 2500f, w))
        assertNull(swipeVerdict(0f, 0f, w))
        // Up = skip, only once the vertical commit line (25 % of height) or an upward flick is reached; horizontal wins a diagonal.
        val h = 1600f
        assertEquals(Verdict.Skipped, swipeVerdict(0f, 0f, w, offsetY = -420f, velocityY = 0f, heightPx = h))
        assertNull(swipeVerdict(0f, 0f, w, offsetY = -380f, velocityY = 0f, heightPx = h))
        assertEquals(Verdict.Skipped, swipeVerdict(30f, 0f, w, offsetY = -120f, velocityY = -2500f, heightPx = h))
        assertNull(swipeVerdict(0f, 0f, w, offsetY = 420f, velocityY = 0f, heightPx = h)) // down does nothing
        assertEquals(Verdict.Interested, swipeVerdict(360f, 0f, w, offsetY = -500f, velocityY = 0f, heightPx = h))
        assertNull(swipeVerdict(0f, 0f, w, offsetY = -500f, velocityY = 0f, heightPx = 0f)) // no height known = no skip
    }

    @Test
    fun `unreviewed count is listingId pins without an interested verdict`() {
        val gj = """{"type":"FeatureCollection","features":[
            {"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{"listingId":"a","searchId":"s"}},
            {"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{"listingId":"b","searchId":"s","review":"interested"}},
            {"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{"name":"Lewes"}},
            {"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{"listingId":"c","searchId":"s"}}
        ]}"""
        assertEquals(2, countUnreviewedListings(gj))
        // The hub writes compact JSON; whitespace variants count the same.
        assertEquals(2, countUnreviewedListings(gj.replace("\"listingId\":", "\"listingId\" : ").replace("\"review\":\"interested\"", "\"review\" : \"interested\"")))
        assertEquals(0, countUnreviewedListings("nope"))
        assertEquals(0, countUnreviewedListings("""{"type":"FeatureCollection","features":[]}"""))
    }

    @Test
    fun `counting over a layer-sized string with thousands of matches is linear, not matches x length`() {
        // ~6 MB, 4000 property pins: the shape of the live house layer.
        val feature = """{"type":"Feature","geometry":{"type":"Point","coordinates":[-1.5,52.0]},"properties":{"listingId":"%d","searchId":"s","summary":"%s","_icon":"🏠"}},"""
        val pad = "x".repeat(1400)
        val sb = StringBuilder("""{"type":"FeatureCollection","features":[""")
        repeat(4000) { sb.append(feature.format(it, pad)) }
        sb.setLength(sb.length - 1); sb.append("]}")
        val gj = sb.toString()
        assertTrue(gj.length > 5_000_000)
        val t0 = System.nanoTime()
        assertEquals(4000, countUnreviewedListings(gj))
        val ms = (System.nanoTime() - t0) / 1_000_000
        assertTrue("took ${ms}ms", ms < 2000)
    }

    @Test
    fun `labels`() {
        assertEquals("Houses", kindLabel("house"))
        assertEquals("Land", kindLabel("farmland"))
        assertEquals("Plots", kindLabel("plot"))
        assertEquals("ImmoScout24", portalLabel("immoscout24"))
        assertEquals("casa", portalLabel("casa"))
        assertNotNull(PROPERTY_KINDS.indexOf("house"))
    }
}
