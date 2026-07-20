package io.amar.console.data.cal

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CalendarRepositoryTest {

    private lateinit var db: ConsoleDb
    private lateinit var repo: CalendarRepository
    private lateinit var outbox: Outbox

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(), ConsoleDb::class.java
        ).allowMainThreadQueries().build()
        val scope = TestScope()
        val syncBus = SyncBusClient(scope)
        outbox = Outbox(
            ApplicationProvider.getApplicationContext(), scope, db,
            HubClient(), syncBus, durableScheduler = {},
        )
        repo = CalendarRepository(db, HubClient(), syncBus, outbox)
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `createEvent writes optimistic temp row and queues with clientToken`() = runTest {
        repo.createEvent("me@x.com", "me@x.com", "Dentist", 1000L, 2000L)
        val events = db.calendar().keysInRange(0, 10_000)
        assertEquals(1, events.size)
        assertTrue(events[0].contains(":~"))
        val q = db.outbox().pending()
        assertEquals(1, q.size)
        assertEquals(CalendarRepository.TYPE_CREATE, q[0].type)
        assertTrue(q[0].dedupeToken.startsWith("apk-"))
    }

    @Test
    fun `deleting a queued temp event cancels the create instead of a server call`() = runTest {
        repo.createEvent("me@x.com", "me@x.com", "Oops", 1000L, 2000L)
        val tempKey = db.calendar().keysInRange(0, 10_000).first()
        repo.deleteEvent(tempKey)
        assertNull(db.calendar().byKey(tempKey))
        assertEquals(0, db.outbox().pending().size) // create cancelled, no delete queued
    }

    @Test
    fun `deleting a real event queues a server delete`() = runTest {
        val row = repo.eventRowFromGoogle(
            Json.parseToJsonElement(
                """{"id":"evt1","summary":"Standup","status":"confirmed",
                    "start":{"dateTime":"2026-07-20T09:00:00+01:00"},
                    "end":{"dateTime":"2026-07-20T09:30:00+01:00"}}"""
            ).jsonObject,
            "me@x.com", "me@x.com",
        )!!
        db.calendar().upsertEvents(listOf(row))
        repo.deleteEvent(row.compoundKey)
        assertNull(db.calendar().byKey(row.compoundKey))
        assertEquals(CalendarRepository.TYPE_DELETE, db.outbox().pending().first().type)
    }

    @Test
    fun `google timed and all-day events parse`() {
        val timed = repo.eventRowFromGoogle(
            Json.parseToJsonElement(
                """{"id":"e1","summary":"Meet","start":{"dateTime":"2026-07-20T09:00:00Z"},
                    "end":{"dateTime":"2026-07-20T10:00:00Z"}}"""
            ).jsonObject, "a@x.com", "cal1",
        )
        assertNotNull(timed)
        assertEquals("a@x.com:cal1:e1", timed!!.compoundKey)
        assertEquals(false, timed.isAllDay)
        assertEquals(3600_000L, timed.endTime - timed.startTime)

        val allDay = repo.eventRowFromGoogle(
            Json.parseToJsonElement(
                """{"id":"e2","summary":"Trip","start":{"date":"2026-07-21"},"end":{"date":"2026-07-22"}}"""
            ).jsonObject, "a@x.com", "cal1",
        )
        assertNotNull(allDay)
        assertTrue(allDay!!.isAllDay)
    }

    @Test
    fun `malformed event returns null`() {
        assertNull(repo.eventRowFromGoogle(Json.parseToJsonElement("""{"summary":"no id"}""").jsonObject, "a", "c"))
        assertNull(repo.eventRowFromGoogle(Json.parseToJsonElement("""{"id":"x"}""").jsonObject, "a", "c"))
    }

    @Test
    fun `undoDelete of a real event restores the row and cancels the queued delete`() = runTest {
        val row = repo.eventRowFromGoogle(
            Json.parseToJsonElement(
                """{"id":"evt2","summary":"Lunch","status":"confirmed",
                    "start":{"dateTime":"2026-07-21T12:00:00+01:00"},
                    "end":{"dateTime":"2026-07-21T13:00:00+01:00"}}"""
            ).jsonObject, "me@x.com", "me@x.com",
        )!!
        db.calendar().upsertEvents(listOf(row))
        repo.deleteEvent(row.compoundKey)
        assertNull(db.calendar().byKey(row.compoundKey))
        assertEquals(1, db.outbox().pending().size)
        repo.undoDelete(row)
        assertNotNull(db.calendar().byKey(row.compoundKey))
        assertEquals(0, db.outbox().pending().size)
    }

    @Test
    fun `undoDelete of a queued temp event re-enqueues its create`() = runTest {
        repo.createEvent("me@x.com", "me@x.com", "Temp", 1000L, 2000L)
        val tempKey = db.calendar().keysInRange(0, 10_000).first()
        val row = db.calendar().byKey(tempKey)!!
        repo.deleteEvent(tempKey) // cancels the pending create
        assertEquals(0, db.outbox().pending().size)
        repo.undoDelete(row)
        assertNotNull(db.calendar().byKey(tempKey))
        val q = db.outbox().pending()
        assertEquals(1, q.size)
        assertEquals(CalendarRepository.TYPE_CREATE, q[0].type)
    }

    @Test
    fun `rsvp flips own attendee status optimistically and queues the call`() = runTest {
        val row = repo.eventRowFromGoogle(
            Json.parseToJsonElement(
                """{"id":"evt3","summary":"Party","status":"confirmed",
                    "start":{"dateTime":"2026-07-22T18:00:00+01:00"},
                    "end":{"dateTime":"2026-07-22T20:00:00+01:00"},
                    "attendees":[
                      {"email":"host@x.com","responseStatus":"accepted","organizer":true},
                      {"email":"me@x.com","responseStatus":"needsAction","self":true}
                    ]}"""
            ).jsonObject, "me@x.com", "me@x.com",
        )!!
        db.calendar().upsertEvents(listOf(row))
        repo.rsvp(row.compoundKey, "accepted")
        val updated = db.calendar().byKey(row.compoundKey)!!
        val details = parseEventDetails(updated.rawJson)
        assertEquals("accepted", details.selfAttendee?.responseStatus)
        assertEquals("accepted", details.attendees.first { it.organizer }.responseStatus) // untouched
        assertEquals(CalendarRepository.TYPE_RSVP, db.outbox().pending().first().type)
    }

    @Test
    fun `day-grid lane packing splits overlapping events`() {
        fun evt(id: String, start: Long, end: Long) = io.amar.console.data.db.CalEventRow(
            compoundKey = id, accountEmail = "a", calendarId = "c", eventId = id,
            summary = id, location = null, startTime = start, endTime = end,
            isAllDay = false, status = "confirmed", rawJson = "{}",
        )
        // a[0..100] and b[50..150] overlap (2 lanes); c/d extend the cluster.
        val lanes = packLanes(
            listOf(
                evt("a", 0, 100),
                evt("b", 50, 150),
                evt("c", 100, 200),
                evt("d", 120, 130),
            )
        )
        assertEquals(0, lanes["a"]!!.lane)
        assertEquals(1, lanes["b"]!!.lane)
        assertEquals(0, lanes["c"]!!.lane)
    }

    @Test
    fun `updateWorkingLocation replacing an unsynced temp cancels its queued create`() = runTest {
        // First set: enqueues a calLocation temp create.
        repo.updateWorkingLocation("me@x.com", 0L, "homeOffice")
        val firstKey = db.calendar().keysInRange(-1, DAY_MS).first { it.contains(":~") }
        val firstEventId = firstKey.substringAfterLast(':')
        assertEquals(1, db.outbox().pending().size)

        // Replace it (still unsynced) → old temp create cancelled, one new create.
        repo.updateWorkingLocation("me@x.com", 0L, "officeLocation", "HQ", oldEventId = firstEventId)
        val pending = db.outbox().pending()
        assertEquals(1, pending.size) // NOT 2 — the stale temp create was cancelled
        assertEquals(CalendarRepository.TYPE_LOCATION, pending.first().type)
        // The surviving payload must NOT carry a ~oldEventId (would 404 + double-create).
        val payload = Json.parseToJsonElement(pending.first().payloadJson).jsonObject
        assertNull(payload["oldEventId"])
    }

    @Test
    fun `setReminder writes optimistic reminders and queues calReminder`() = runTest {
        val row = repo.eventRowFromGoogle(
            Json.parseToJsonElement(
                """{"id":"evtR","summary":"Meeting","status":"confirmed",
                    "start":{"dateTime":"2026-07-20T09:00:00+01:00"},
                    "end":{"dateTime":"2026-07-20T10:00:00+01:00"}}"""
            ).jsonObject, "me@x.com", "me@x.com",
        )!!
        db.calendar().upsertEvents(listOf(row))
        repo.setReminder(row.compoundKey, 15)
        val updated = db.calendar().byKey(row.compoundKey)!!
        val rem = parseEventDetails(updated.rawJson).reminders!!
        assertEquals(false, rem.useDefault)
        assertEquals(15, rem.overrides.first().minutes)
        assertEquals(CalendarRepository.TYPE_REMINDER, db.outbox().pending().first().type)
    }

    @Test
    fun `createEvent with guests adds attendees and a Meet conference request`() = runTest {
        repo.createEvent("me@x.com", "me@x.com", "Sync", 1000L, 2000L, attendees = listOf("Alice <alice@x.com>", "bob@x.com"))
        val key = db.calendar().keysInRange(0, 10_000).first()
        val raw = db.calendar().byKey(key)!!.rawJson
        val o = Json.parseToJsonElement(raw).jsonObject
        val attendees = o["attendees"]!!.jsonArray
        // organizer (self) + 2 guests
        assertEquals(3, attendees.size)
        assertNotNull(o["conferenceData"])
    }

    @Test
    fun `prune drops events outside the window`() = runTest {
        val now = System.currentTimeMillis()
        val old = repo.eventRowFromGoogle(
            Json.parseToJsonElement(
                """{"id":"old","summary":"ancient","start":{"date":"2020-01-01"},"end":{"date":"2020-01-02"}}"""
            ).jsonObject, "a@x.com", "c",
        )!!
        val current = repo.eventRowFromGoogle(
            Json.parseToJsonElement(
                """{"id":"now","summary":"today",
                    "start":{"dateTime":"${java.time.OffsetDateTime.now()}"},
                    "end":{"dateTime":"${java.time.OffsetDateTime.now().plusHours(1)}"}}"""
            ).jsonObject, "a@x.com", "c",
        )!!
        db.calendar().upsertEvents(listOf(old, current))
        repo.prune()
        assertNull(db.calendar().byKey(old.compoundKey))
        assertNotNull(db.calendar().byKey(current.compoundKey))
    }
}
