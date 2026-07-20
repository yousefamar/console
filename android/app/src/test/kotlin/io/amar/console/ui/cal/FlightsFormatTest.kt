package io.amar.console.ui.cal

import io.amar.console.data.cal.FlightsRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FlightsFormatTest {

    private fun wl(
        kind: String = "route", origin: String = "LHR", destination: String? = "JFK",
        region: String? = null, month: Int? = null, outboundDate: String? = "2026-08-01",
        history: List<Double> = emptyList(), label: String? = null,
    ) = FlightsRepository.Watchlist(
        id = "w", label = label, kind = kind, origin = origin, currency = "GBP",
        maxPriceMajor = null, notifyOnDrop = true, region = region, destination = destination,
        month = month, duration = null, outboundDate = outboundDate, returnDate = null,
        travelClass = null, adults = null, lastCheckedAt = null, lastError = null,
        lastPriceMajor = null, history = history, lastResults = emptyList(),
    )

    @Test
    fun `price formats with symbol or currency code`() {
        assertEquals("£200", FlightsFormat.formatPrice(199.6, "GBP"))
        assertEquals("$50", FlightsFormat.formatPrice(50.0, "USD"))
        assertEquals("100 SEK", FlightsFormat.formatPrice(100.0, "SEK"))
    }

    @Test
    fun `describe route and explore`() {
        assertEquals("LHR → JFK · 1 Aug", FlightsFormat.describe(wl()))
        assertEquals(
            "LHR → Europe · Jul",
            FlightsFormat.describe(wl(kind = "explore", destination = null, region = "europe", month = 7)),
        )
        assertEquals(
            "LHR → anywhere · next 6mo",
            FlightsFormat.describe(wl(kind = "explore", destination = null, region = null, month = 0)),
        )
    }

    @Test
    fun `priceDelta from last two history entries`() {
        assertEquals(-30.0, FlightsFormat.priceDelta(wl(history = listOf(230.0, 200.0)))!!, 0.001)
        assertNull(FlightsFormat.priceDelta(wl(history = listOf(200.0))))
        assertEquals("↓30", FlightsFormat.deltaLabel(-30.0))
        assertEquals("↑15", FlightsFormat.deltaLabel(15.0))
    }

    @Test
    fun `result meta line assembles flight numbers stops duration`() {
        val r = FlightsRepository.ResultRow(
            label = "x", priceMajor = 100.0, startDate = null, endDate = null,
            departureTime = "2026-08-01 09:30", arrivalTime = "2026-08-01 12:00",
            stops = 0, airlines = listOf("BA"), flightNumbers = listOf("BA123"),
            totalDurationMin = 150, airport = null, country = null, link = null,
        )
        assertEquals("09:30", FlightsFormat.clockTime(r.departureTime))
        assertEquals("BA123 · direct · 2h30m", FlightsFormat.resultMeta(r))
    }

    @Test
    fun `stops greater than zero shows Nst`() {
        val r = FlightsRepository.ResultRow(
            "x", 1.0, null, null, null, null, stops = 2, airlines = listOf("AA"),
            flightNumbers = emptyList(), totalDurationMin = null, airport = null, country = null, link = null,
        )
        assertEquals("AA · 2st", FlightsFormat.resultMeta(r))
    }

    @Test
    fun `compactDate formats iso to day-month`() {
        assertEquals("1 Aug", FlightsFormat.compactDate("2026-08-01"))
        assertEquals("", FlightsFormat.compactDate(null))
    }

    @Test
    fun `formatDuration`() {
        assertEquals("2h30m", FlightsFormat.formatDuration(150))
        assertEquals("45m", FlightsFormat.formatDuration(45))
        assertEquals("3h", FlightsFormat.formatDuration(180))
    }

    @Test
    fun `timeAgo buckets`() {
        val now = 10_000_000_000L
        assertEquals("just now", FlightsFormat.timeAgo(now - 30_000, now))
        assertEquals("5m ago", FlightsFormat.timeAgo(now - 5 * 60_000, now))
        assertEquals("2h ago", FlightsFormat.timeAgo(now - 2 * 3600_000, now))
        assertEquals("3d ago", FlightsFormat.timeAgo(now - 3 * 86400_000L, now))
    }
}
