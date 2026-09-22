package io.amar.console.data.cal

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.core.HubConfig
import io.amar.console.data.db.CalEventRow
import io.amar.console.data.db.CalendarRow
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * "What Google Calendar shows Yousef" on the phone (^odd-bat). A colleague's
 * calendar shared with admin access but UNCHECKED in Google leaked onto the
 * launcher tile: Google omits `selected` when false, and the hub's fan-out
 * returned every calendar of every account.
 */
@RunWith(RobolectricTestRunner::class)
class CalVisibilityTest {

    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject

    @Test
    fun `only a literal selected true shows — Google omits the flag when false`() {
        assertTrue(isSelectedCalendar(obj("""{"id":"me@x.com","selected":true}""")))
        assertFalse(isSelectedCalendar(obj("""{"id":"sam@x.com","accessRole":"owner"}"""))) // live sam@ shape
        assertFalse(isSelectedCalendar(obj("""{"id":"c","selected":false}""")))
        assertFalse(isSelectedCalendar(obj("""{"id":"c","selected":true,"hidden":true}""")))
        assertFalse(isSelectedCalendar(obj("""{"id":"c","selected":true,"deleted":true}""")))
    }

    @Test
    fun `detail-stripped events read Busy, untitled writable events keep no title`() {
        assertEquals("Standup", eventTitle("Standup", "freeBusyReader"))
        assertEquals("Busy", eventTitle(null, "freeBusyReader"))
        assertEquals("Busy", eventTitle("", "reader"))
        assertEquals("(no title)", eventTitle(null, "owner"))
        assertEquals("(no title)", eventTitle(null, null))
    }

    @Test
    fun `best access role across accounts and the Console allow-list`() {
        assertEquals("owner", bestAccessRole(listOf("reader", "owner")))
        assertEquals("reader", bestAccessRole(listOf("freeBusyReader", "reader")))
        assertNull(bestAccessRole(emptyList()))
        assertTrue(isCalendarShown(null, "any"))
        assertTrue(isCalendarShown(setOf("a"), "a"))
        assertFalse(isCalendarShown(setOf("a"), "b"))
    }

    // ------------------------------------------------------------------ //
    // reconcile() against a hub that still returns the whole union.

    private lateinit var db: ConsoleDb
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(), ConsoleDb::class.java
        ).allowMainThreadQueries().build()
        server = MockWebServer()
        // Serve by PATH — HubConfig is process-wide and the real ConsoleApp's
        // pollers share this base; a FIFO queue would be eaten by a stray call.
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val p = request.path ?: ""
                return when {
                    p == "/hub/cal/calendars" -> MockResponse().setBody(CALENDARS)
                    p.startsWith("/hub/cal/events?") -> MockResponse().setBody(EVENTS)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        HubConfig.init(ApplicationProvider.getApplicationContext())
        HubConfig.setHubBase(server.url("/hub").toString())
    }

    @After
    fun tearDown() {
        HubConfig.setHubBase("")
        runCatching { server.shutdown() }
        db.close()
    }

    private fun repo(): CalendarRepository {
        val scope = TestScope()
        val syncBus = SyncBusClient(scope)
        val outbox = Outbox(ApplicationProvider.getApplicationContext(), scope, db, HubClient(), syncBus, durableScheduler = {})
        return CalendarRepository(db, HubClient(), syncBus, outbox)
    }

    @Test
    fun `reconcile keeps only Google-checked calendars and drops a colleague's cached events`() = runBlocking {
        // Stale state from before the fix: Sam's calendar + one of his events cached.
        db.calendar().upsertCalendars(listOf(
            CalendarRow("me@artanis.ai:sam@artanis.ai", "me@artanis.ai", "sam@artanis.ai", "sam@artanis.ai", null, "owner", true),
        ))
        db.calendar().upsertEvents(listOf(
            CalEventRow("me@artanis.ai:sam@artanis.ai:old", "me@artanis.ai", "sam@artanis.ai", "old", "Fish Founders - Meetup",
                null, NOW + HOUR, NOW + 2 * HOUR, false, "confirmed", "{}"),
        ))

        repo().reconcile()

        val cals = db.calendar().calendars().map { it.id }.toSet()
        assertEquals(setOf("me@artanis.ai:me@artanis.ai", "me@artanis.ai:shared@x.com"), cals)

        val keys = db.calendar().keysInRange(NOW - 30L * 24 * HOUR, NOW + 90L * 24 * HOUR).toSet()
        assertFalse("cached Sam event must be swept", "me@artanis.ai:sam@artanis.ai:old" in keys)
        assertFalse("Sam's event from the union must not be cached", "me@artanis.ai:sam@artanis.ai:fish" in keys)
        assertNotNull(db.calendar().byKey("me@artanis.ai:me@artanis.ai:mine"))
        // Free/busy-only share: Google stripped the title; the phone says Busy.
        assertEquals("Busy", db.calendar().byKey("me@artanis.ai:shared@x.com:fb")!!.summary)
    }

    private companion object {
        val NOW = System.currentTimeMillis()
        const val HOUR = 3600_000L
        fun iso(ms: Long) = java.time.Instant.ofEpochMilli(ms).toString()

        val CALENDARS = """[
          {"id":"me@artanis.ai","summary":"Me","accessRole":"owner","selected":true,"primary":true,"accountEmail":"me@artanis.ai"},
          {"id":"sam@artanis.ai","summary":"sam@artanis.ai","accessRole":"owner","accountEmail":"me@artanis.ai"},
          {"id":"shared@x.com","summary":"Shared","accessRole":"freeBusyReader","selected":true,"accountEmail":"me@artanis.ai"}
        ]"""

        val EVENTS = """{"items":[
          {"id":"mine","summary":"Dentist","status":"confirmed","calendarId":"me@artanis.ai","accountEmail":"me@artanis.ai",
           "start":{"dateTime":"${iso(NOW + HOUR)}"},"end":{"dateTime":"${iso(NOW + 2 * HOUR)}"}},
          {"id":"fish","summary":"Fish Founders - Meetup","status":"confirmed","calendarId":"sam@artanis.ai","accountEmail":"me@artanis.ai",
           "start":{"dateTime":"${iso(NOW + 3 * HOUR)}"},"end":{"dateTime":"${iso(NOW + 4 * HOUR)}"}},
          {"id":"fb","status":"confirmed","calendarId":"shared@x.com","accountEmail":"me@artanis.ai",
           "start":{"dateTime":"${iso(NOW + 5 * HOUR)}"},"end":{"dateTime":"${iso(NOW + 6 * HOUR)}"}}
        ]}"""
    }
}
