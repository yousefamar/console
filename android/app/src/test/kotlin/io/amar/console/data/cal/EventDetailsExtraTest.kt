package io.amar.console.data.cal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EventDetailsExtraTest {

    @Test
    fun `reminders with explicit overrides parse`() {
        val d = parseEventDetails(
            """{"id":"e","reminders":{"useDefault":false,"overrides":[{"method":"popup","minutes":15}]}}"""
        )
        assertNotNull(d.reminders)
        assertFalse(d.reminders!!.useDefault)
        assertEquals(15, d.reminders!!.overrides.first().minutes)
    }

    @Test
    fun `effectiveReminderMinutes folds useDefault into calendar defaults`() {
        val useDefault = Reminders(useDefault = true, overrides = emptyList())
        assertEquals(30, effectiveReminderMinutes(useDefault, listOf(30, 10)))
        val explicit = Reminders(useDefault = false, overrides = listOf(ReminderOverride("popup", 5)))
        assertEquals(5, effectiveReminderMinutes(explicit, listOf(30)))
        // No reminders object → calendar defaults apply.
        assertEquals(60, effectiveReminderMinutes(null, listOf(60)))
    }

    @Test
    fun `hasReminder reflects overrides or default presence`() {
        assertTrue(hasReminder(Reminders(false, listOf(ReminderOverride("popup", 10))), emptyList()))
        assertFalse(hasReminder(Reminders(false, emptyList()), listOf(30)))
        assertTrue(hasReminder(Reminders(true, emptyList()), listOf(30)))
        assertFalse(hasReminder(Reminders(true, emptyList()), emptyList()))
        assertTrue(hasReminder(null, listOf(15)))
        assertFalse(hasReminder(null, emptyList()))
    }

    @Test
    fun `isAccepted no attendees is accepted`() {
        assertTrue(isAccepted(parseEventDetails("""{"id":"e"}""")))
    }

    @Test
    fun `isAccepted organizer self is accepted`() {
        val d = parseEventDetails(
            """{"id":"e","organizer":{"self":true},"attendees":[{"email":"other@x","responseStatus":"needsAction"}]}"""
        )
        assertTrue(isAccepted(d))
    }

    @Test
    fun `isAccepted self needsAction is not accepted`() {
        val d = parseEventDetails(
            """{"id":"e","attendees":[{"email":"me@x","self":true,"responseStatus":"needsAction"}]}"""
        )
        assertFalse(isAccepted(d))
    }

    @Test
    fun `isAccepted self accepted is accepted`() {
        val d = parseEventDetails(
            """{"id":"e","attendees":[{"email":"me@x","self":true,"responseStatus":"accepted"}]}"""
        )
        assertTrue(isAccepted(d))
    }

    @Test
    fun `isTask detects google task description`() {
        val task = parseEventDetails("""{"id":"e","description":"see https://tasks.google.com/task/abc"}""")
        assertTrue(task.isTask)
        assertFalse(parseEventDetails("""{"id":"e","description":"normal"}""").isTask)
    }

    @Test
    fun `working location parses office label`() {
        val d = parseEventDetails(
            """{"id":"e","eventType":"workingLocation",
                "workingLocationProperties":{"type":"officeLocation","officeLocation":{"label":"London HQ"}}}"""
        )
        assertEquals("workingLocation", d.eventType)
        assertEquals("officeLocation", d.workingLocation!!.type)
        assertEquals("London HQ", d.workingLocation!!.label)
    }

    @Test
    fun `recurringEventId marks event recurring`() {
        assertTrue(parseEventDetails("""{"id":"e","recurringEventId":"master1"}""").isRecurring)
        assertFalse(parseEventDetails("""{"id":"e"}""").isRecurring)
    }

    @Test
    fun `extractUrls pulls http links from text`() {
        val urls = extractUrls("Join https://meet.google.com/abc and see http://x.com/y.")
        assertEquals(listOf("https://meet.google.com/abc", "http://x.com/y"), urls)
    }
}
