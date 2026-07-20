package io.amar.console.data.cal

import io.amar.console.core.HubClient
import io.amar.console.sync.SyncBusClient
import kotlinx.coroutines.test.TestScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FlightsRepositoryTest {

    private val repo = FlightsRepository(HubClient(), SyncBusClient(TestScope()))
    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject

    @Test
    fun `parses a route watchlist with results and history`() {
        val wl = repo.parseWatchlist(obj(
            """{"id":"w1","kind":"route","origin":"LHR","destination":"JFK","currency":"GBP",
                "outboundDate":"2026-08-01","maxPriceMajor":400,"notifyOnDrop":true,
                "history":[{"at":1,"priceMajor":420},{"at":2,"priceMajor":399}],
                "lastResults":[{"label":"BA 09:30","priceMajor":399,"departureTime":"2026-08-01 09:30",
                    "arrivalTime":"2026-08-01 12:00","stops":0,"airlines":["BA"],"flightNumbers":["BA117"],
                    "totalDurationMin":390}]}"""
        ))!!
        assertEquals("w1", wl.id)
        assertEquals("route", wl.kind)
        assertEquals("JFK", wl.destination)
        assertEquals(listOf(420.0, 399.0), wl.history)
        assertEquals(1, wl.lastResults.size)
        assertEquals("BA117", wl.lastResults[0].flightNumbers.first())
        assertEquals(0, wl.lastResults[0].stops)
    }

    @Test
    fun `parses an explore watchlist`() {
        val wl = repo.parseWatchlist(obj(
            """{"id":"w2","kind":"explore","origin":"LHR","region":"europe","month":7,
                "duration":"Weekend","currency":"GBP"}"""
        ))!!
        assertEquals("explore", wl.kind)
        assertEquals("europe", wl.region)
        assertEquals(7, wl.month)
        // defaults
        assertEquals("GBP", wl.currency)
        assertEquals(true, wl.notifyOnDrop)
    }

    @Test
    fun `watchlist without id is null`() {
        assertNull(repo.parseWatchlist(obj("""{"kind":"route","origin":"LHR"}""")))
    }
}
