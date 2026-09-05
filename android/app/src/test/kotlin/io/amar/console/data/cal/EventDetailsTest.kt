package io.amar.console.data.cal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EventDetailsTest {

    @Test
    fun `parses attendees with rsvp status, organizer and self markers`() {
        val d = parseEventDetails(
            """{"id":"e1","summary":"Standup",
                "attendees":[
                  {"email":"boss@x.com","displayName":"Boss","responseStatus":"accepted","organizer":true},
                  {"email":"me@x.com","responseStatus":"needsAction","self":true},
                  {"email":"flake@x.com","responseStatus":"declined"}
                ],
                "hangoutLink":"https://meet.google.com/abc",
                "htmlLink":"https://calendar.google.com/event?eid=1",
                "description":"<p>Agenda: things &amp; stuff</p><br>Line two"}"""
        )
        assertEquals(3, d.attendees.size)
        assertEquals("Boss", d.attendees[0].displayName)
        assertTrue(d.attendees[0].organizer)
        assertEquals("accepted", d.attendees[0].responseStatus)
        assertEquals("me@x.com", d.selfAttendee?.email)
        assertEquals("needsAction", d.selfAttendee?.responseStatus)
        assertEquals("https://meet.google.com/abc", d.hangoutLink)
        assertEquals("https://calendar.google.com/event?eid=1", d.htmlLink)
    }

    @Test
    fun `falls back to conferenceData video entry point when no hangoutLink`() {
        val d = parseEventDetails(
            """{"id":"e2","conferenceData":{"entryPoints":[
                 {"entryPointType":"phone","uri":"tel:+44123"},
                 {"entryPointType":"video","uri":"https://zoom.us/j/1"}]}}"""
        )
        assertEquals("https://zoom.us/j/1", d.hangoutLink)
    }

    @Test
    fun `empty or malformed rawJson yields empty details`() {
        val d = parseEventDetails("not json at all")
        assertTrue(d.attendees.isEmpty())
        assertNull(d.selfAttendee)
        assertNull(d.hangoutLink)

        val d2 = parseEventDetails("""{"id":"e3","summary":"No attendees"}""")
        assertTrue(d2.attendees.isEmpty())
    }

    @Test
    fun `attendee without email is skipped, defaults applied`() {
        val d = parseEventDetails(
            """{"attendees":[{"displayName":"ghost"},{"email":"a@x.com"}]}"""
        )
        assertEquals(1, d.attendees.size)
        assertEquals("needsAction", d.attendees[0].responseStatus)
        assertEquals(false, d.attendees[0].organizer)
        assertEquals(false, d.attendees[0].self)
    }

    @Test
    fun `stripHtml flattens markup and entities`() {
        assertEquals(
            "Agenda: things & stuff\n\nLine two", // </p> + <br> each break
            stripHtml("<p>Agenda: things &amp; stuff</p><br>Line two"),
        )
        assertEquals("a < b", stripHtml("a &lt; b"))
        assertEquals("plain", stripHtml("plain"))
    }

    @Test
    fun `truncateRecurrence ends the series just before the cut and drops COUNT`() {
        // Timed cut: UNTIL is one second before the cut instance, UTC basic format.
        assertEquals(
            listOf("RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260914T085959Z", "EXDATE:20260907T090000Z"),
            truncateRecurrence(listOf("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10", "EXDATE:20260907T090000Z"), "2026-09-14T10:00:00+01:00"),
        )
        // All-day cut: date-only UNTIL, the day before.
        assertEquals(listOf("RRULE:FREQ=DAILY;UNTIL=20260913"), truncateRecurrence(listOf("RRULE:FREQ=DAILY;UNTIL=20261231"), "2026-09-14"))
    }

    @Test
    fun `isDeclined only when the self attendee declined`() {
        val declined = parseEventDetails("""{"attendees":[{"email":"me@x","self":true,"responseStatus":"declined"}]}""")
        val accepted = parseEventDetails("""{"attendees":[{"email":"me@x","self":true,"responseStatus":"accepted"}]}""")
        val other = parseEventDetails("""{"attendees":[{"email":"you@x","responseStatus":"declined"}]}""")
        assertTrue(isDeclined(declined))
        assertTrue(!isDeclined(accepted))
        assertTrue(!isDeclined(other))
        assertTrue(!isDeclined(parseEventDetails("{}")))
    }
}
