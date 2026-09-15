package io.amar.console.data.cal

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CalOverlaysTest {

    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject

    // ---- Meetup ------------------------------------------------------- //

    @Test
    fun `meetup physical event with venue produces a timed row`() {
        val row = meetupEventRow(obj(
            """{"id":"m1","title":"Board Games","dateTime":"2026-07-20T19:00:00+01:00",
                "endTime":"2026-07-20T21:00:00+01:00","venueName":"The Pub","venueCity":"Reading",
                "going":12,"eventUrl":"https://meetup.com/e/m1","groupName":"Reading Gamers",
                "isOnline":false,"eventType":"PHYSICAL"}"""
        ))!!
        assertEquals("meetup:meetup:meetup:m1", row.compoundKey)
        assertEquals("Board Games", row.summary)
        assertEquals("The Pub, Reading", row.location)
        assertFalse(row.isAllDay)
        assertEquals(2 * HOUR_MS, row.endTime - row.startTime)
        val details = parseEventDetails(row.rawJson)
        assertTrue(details.description!!.contains("Reading Gamers"))
        assertTrue(details.description!!.contains("12 going"))
        assertEquals("https://meetup.com/e/m1", details.htmlLink)
    }

    @Test
    fun `meetup online event location is Online and gets a default 1h block`() {
        val row = meetupEventRow(obj(
            """{"id":"m2","title":"Webinar","dateTime":"2026-07-20T19:00:00+01:00",
                "endTime":"","going":0,"eventUrl":"u","groupName":"G","isOnline":true,"eventType":"ONLINE"}"""
        ))!!
        assertEquals("Online", row.location)
        assertEquals(HOUR_MS, row.endTime - row.startTime)
    }

    @Test
    fun `meetup event missing id or dateTime returns null`() {
        assertNull(meetupEventRow(obj("""{"title":"no id","dateTime":"2026-07-20T19:00:00+01:00"}""")))
        assertNull(meetupEventRow(obj("""{"id":"x","title":"no time"}""")))
    }

    // ---- Eventbrite --------------------------------------------------- //

    @Test
    fun `eventbrite venue event keeps its real end time and organiser in the description`() {
        val row = eventbriteEventRow(obj(
            """{"id":"e1","title":"Founders Night","url":"https://eventbrite.co.uk/e/e1",
                "start":"2026-09-20T18:00:00Z","end":"2026-09-20T21:30:00Z","organizerId":"o1",
                "organizerName":"Reading Founders","venueName":"The Biscuit Factory",
                "address":"1 Cross St, Reading","online":false,"summary":"Pitches + drinks"}"""
        ))!!
        assertEquals("eventbrite:eventbrite:eventbrite:e1", row.compoundKey)
        assertEquals(EVENTBRITE_ID, row.calendarId)
        assertEquals("Founders Night", row.summary)
        assertEquals("The Biscuit Factory, 1 Cross St, Reading", row.location)
        assertFalse(row.isAllDay)
        assertEquals(3 * HOUR_MS + HOUR_MS / 2, row.endTime - row.startTime)
        val details = parseEventDetails(row.rawJson)
        assertTrue(details.description!!.contains("Reading Founders"))
        assertTrue(details.description!!.contains("Pitches + drinks"))
        assertEquals("https://eventbrite.co.uk/e/e1", details.htmlLink)
    }

    @Test
    fun `eventbrite online event is located Online and a missing end collapses to the start`() {
        val row = eventbriteEventRow(obj(
            """{"id":"e2","title":"Webinar","url":"u","start":"2026-09-20T18:00:00Z","end":"",
                "organizerId":"o","organizerName":"G","venueName":"","address":"","online":true,"summary":""}"""
        ))!!
        assertEquals("Online", row.location)
        assertEquals(row.startTime, row.endTime)
    }

    @Test
    fun `eventbrite event missing id or start returns null`() {
        assertNull(eventbriteEventRow(obj("""{"title":"no id","start":"2026-09-20T18:00:00Z"}""")))
        assertNull(eventbriteEventRow(obj("""{"id":"x","title":"no start"}""")))
    }

    @Test
    fun `only meetup and eventbrite are overlay calendars`() {
        assertTrue(isOverlayCalendar(overlayCalendarRow(MEETUP_ID, "Meetup", MEETUP_COLOR)))
        assertTrue(isOverlayCalendar(overlayCalendarRow(EVENTBRITE_ID, "Eventbrite", EVENTBRITE_COLOR)))
        assertFalse(isOverlayCalendar(overlayCalendarRow("outdoorlads", "OutdoorLads", "#f5821f")))
        assertFalse(isOverlayCalendar(
            overlayCalendarRow(MEETUP_ID, "Meetup", MEETUP_COLOR).copy(accessRole = "owner")
        ))
    }

    @Test
    fun `overlay calendar rows carry brand colours and reader access`() {
        val m = overlayCalendarRow(MEETUP_ID, "Meetup", MEETUP_COLOR)
        assertEquals("meetup:meetup", m.id)
        assertEquals("reader", m.accessRole)
        assertEquals("#ff4a79", m.color)
        val e = overlayCalendarRow(EVENTBRITE_ID, "Eventbrite", EVENTBRITE_COLOR)
        assertEquals("eventbrite:eventbrite", e.id)
        assertEquals("#f05537", e.color)
    }

    // ---- guest parsing ------------------------------------------------ //

    @Test
    fun `parseGuest handles Name email and bare email`() {
        assertEquals("Alice" to "alice@x.com", parseGuest("Alice <alice@x.com>"))
        assertEquals("" to "bob@x.com", parseGuest("bob@x.com"))
        assertNull(parseGuest("   "))
    }
}
