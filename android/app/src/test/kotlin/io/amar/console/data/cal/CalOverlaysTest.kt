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

    // ---- OutdoorLads -------------------------------------------------- //

    @Test
    fun `outdoorlads camping event produces a 2h block`() {
        val row = outdoorLadsEventRow(obj(
            """{"id":"o1","title":"Peak District Camp","link":"https://ol/o1",
                "start":"2026-08-01T10:00:00+01:00","eventType":"Campsites","region":"North West",
                "location":"Edale, North West","description":"Bring a tent"}"""
        ))!!
        assertEquals("Peak District Camp", row.summary)
        assertEquals("Edale, North West", row.location)
        assertEquals(2 * HOUR_MS, row.endTime - row.startTime)
        assertTrue(parseEventDetails(row.rawJson).description!!.contains("Campsites"))
    }

    @Test
    fun `outdoorlads non-camping event is filtered out`() {
        assertNull(outdoorLadsEventRow(obj(
            """{"id":"o2","title":"Hill Walk","link":"l","start":"2026-08-01T10:00:00+01:00",
                "eventType":"Lowland and Hill Walks","region":"SE","location":"x","description":"d"}"""
        )))
    }

    @Test
    fun `outdoorLadsIncluded matches camp substring case-insensitively`() {
        assertTrue(outdoorLadsIncluded("Campsites"))
        assertTrue(outdoorLadsIncluded("CAMPING WEEKEND"))
        assertFalse(outdoorLadsIncluded("Cycling"))
    }

    @Test
    fun `overlay calendar rows carry brand colours and reader access`() {
        val m = overlayCalendarRow(MEETUP_ID, "Meetup", MEETUP_COLOR)
        assertEquals("meetup:meetup", m.id)
        assertEquals("reader", m.accessRole)
        assertEquals("#ff4a79", m.color)
    }

    // ---- guest parsing ------------------------------------------------ //

    @Test
    fun `parseGuest handles Name email and bare email`() {
        assertEquals("Alice" to "alice@x.com", parseGuest("Alice <alice@x.com>"))
        assertEquals("" to "bob@x.com", parseGuest("bob@x.com"))
        assertNull(parseGuest("   "))
    }
}
