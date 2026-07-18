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
