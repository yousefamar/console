package io.amar.console.data.mail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

class IcsParserTest {

    private val sample = """
        BEGIN:VCALENDAR
        METHOD:REQUEST
        BEGIN:VEVENT
        SUMMARY:Team sync
        LOCATION:Room 4\, Floor 2
        DESCRIPTION:Weekly\nstandup
        DTSTART:20260115T090000Z
        DTEND:20260115T093000Z
        STATUS:CONFIRMED
        ORGANIZER;CN=Alice:mailto:alice@x.com
        ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED:mailto:bob@y.com
        ATTENDEE;PARTSTAT=DECLINED:mailto:carol@z.com
        ATTENDEE;CN=Dave:mailto:dave@w.com
        END:VEVENT
        END:VCALENDAR
    """.trimIndent().replace("\n", "\r\n")

    @Test
    fun `parses summary location description status method`() {
        val ev = IcsParser.parse(sample)!!
        assertEquals("Team sync", ev.summary)
        assertEquals("Room 4\\, Floor 2", ev.location)         // location kept raw (parity w/ SPA)
        assertEquals("Weekly\nstandup", ev.description)        // \n unescaped
        assertEquals("CONFIRMED", ev.status)
        assertEquals("REQUEST", ev.method)
    }

    @Test
    fun `parses UTC start and end`() {
        val ev = IcsParser.parse(sample)!!
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = ev.start }
        assertEquals(2026, c.get(Calendar.YEAR))
        assertEquals(0, c.get(Calendar.MONTH))
        assertEquals(15, c.get(Calendar.DAY_OF_MONTH))
        assertEquals(9, c.get(Calendar.HOUR_OF_DAY))
        val ce = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = ev.end }
        assertEquals(9, ce.get(Calendar.HOUR_OF_DAY))
        assertEquals(30, ce.get(Calendar.MINUTE))
    }

    @Test
    fun `parses organizer and attendees with status`() {
        val ev = IcsParser.parse(sample)!!
        assertEquals("Alice", ev.organizer?.name)
        assertEquals("alice@x.com", ev.organizer?.email)
        assertEquals(3, ev.attendees.size)
        assertEquals("accepted", ev.attendees[0].status)
        assertEquals("Bob", ev.attendees[0].name)
        assertEquals("declined", ev.attendees[1].status)
        assertEquals("needs-action", ev.attendees[2].status) // default
    }

    @Test
    fun `all-day date parses to midnight local`() {
        val ics = "BEGIN:VEVENT\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20260704\r\nEND:VEVENT"
        val ev = IcsParser.parse(ics)!!
        val c = Calendar.getInstance().apply { timeInMillis = ev.start }
        assertEquals(0, c.get(Calendar.HOUR_OF_DAY))
        assertEquals(0, c.get(Calendar.MINUTE))
        assertEquals(4, c.get(Calendar.DAY_OF_MONTH))
    }

    @Test
    fun `unfolds continuation lines`() {
        val ics = "BEGIN:VEVENT\r\nSUMMARY:Long tit\r\n le here\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT"
        val ev = IcsParser.parse(ics)!!
        assertEquals("Long title here", ev.summary)
    }

    @Test
    fun `returns null without DTSTART`() {
        assertNull(IcsParser.parse("BEGIN:VEVENT\r\nSUMMARY:No date\r\nEND:VEVENT"))
    }

    @Test
    fun `cancel method surfaces`() {
        val ics = "METHOD:CANCEL\r\nBEGIN:VEVENT\r\nSUMMARY:Off\r\nDTSTART:20260101T000000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT"
        val ev = IcsParser.parse(ics)!!
        assertEquals("CANCEL", ev.method)
        assertEquals("CANCELLED", ev.status)
        assertTrue(ev.method == "CANCEL" || ev.status == "CANCELLED")
    }
}
