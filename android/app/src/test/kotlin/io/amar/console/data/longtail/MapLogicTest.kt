package io.amar.console.data.longtail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import kotlinx.serialization.json.jsonObject
import org.junit.Test

class MapLogicTest {

    // --- decimate --- //

    @Test
    fun `decimate keeps small lists untouched`() {
        assertEquals(listOf(1, 2, 3), decimate(listOf(1, 2, 3), 4000))
    }

    @Test
    fun `decimate caps at max and always keeps the last`() {
        val big = (1..10_000).toList()
        val out = decimate(big, 4000)
        assertTrue(out.size <= 4001)
        assertEquals(10_000, out.last())
        assertEquals(1, out.first())
    }

    @Test
    fun `decimate empty is empty`() {
        assertTrue(decimate(emptyList<Int>(), 100).isEmpty())
    }

    // --- iso → epoch --- //

    @Test
    fun `iso with offset parses to epoch ms`() {
        // 2026-07-07T19:00:00+01:00 == 2026-07-07T18:00:00Z
        assertEquals(
            java.time.Instant.parse("2026-07-07T18:00:00Z").toEpochMilli(),
            isoToEpochMs("2026-07-07T19:00:00+01:00"),
        )
    }

    @Test
    fun `iso garbage gives zero`() {
        assertEquals(0L, isoToEpochMs(""))
        assertEquals(0L, isoToEpochMs("nope"))
    }

    // --- gc status parse (server/src/geocaching/client.ts getStatus) --- //

    @Test
    fun `gc status parses login, username, budget, count`() {
        val s = parseGcStatus(
            """{"loggedIn": true, "username": "amar", "hasCredentials": true,
                "budget": {"used": 12, "cap": 400, "remaining": 388}, "cacheCount": 57}""",
        )!!
        assertTrue(s.loggedIn)
        assertEquals("amar", s.username)
        assertEquals(388, s.budget?.remaining)
        assertEquals(57, s.cacheCount)
    }

    @Test
    fun `gc status null username survives`() {
        val s = parseGcStatus("""{"loggedIn": false, "username": null, "cacheCount": 0}""")!!
        assertFalse(s.loggedIn)
        assertNull(s.username)
    }

    // --- meetup status parse --- //

    @Test
    fun `meetup status parses budget, count, lastFetch`() {
        val s = parseMeetupStatus("""{"budget": {"used": 3, "cap": 800, "remaining": 797}, "eventCount": 33, "lastFetch": 123}""")!!
        assertEquals(797, s.budget?.remaining)
        assertEquals(33, s.eventCount)
        assertEquals(123L, s.lastFetch)
    }

    // --- owntracks fixes parse (array OR {data:[...]}) --- //

    @Test
    fun `fixes parse from bare array and from data wrapper`() {
        val bare = parseFixes("""[{"lat": 51.4, "lon": -0.9, "tst": 100, "tid": "ph"}]""")
        assertEquals(1, bare.size)
        assertEquals("ph", bare[0].device)
        val wrapped = parseFixes("""{"data": [{"lat": 51.4, "lon": -0.9, "tst": 100, "device": "phone"}]}""")
        assertEquals(1, wrapped.size)
        assertEquals("phone", wrapped[0].device)
    }

    @Test
    fun `fixes skip rows without coords`() {
        val fixes = parseFixes("""[{"tst": 1}, {"lat": 1.0, "lon": 2.0, "tst": 2}]""")
        assertEquals(1, fixes.size)
    }

    // --- live location: /location/map + SyncBus 'location' ops (src/store/map.ts) --- //

    private val mapPayload = """{
      "fix": {"lat": 51.45, "lon": -0.97, "tst": 1700000100, "acc": 12, "batt": 80, "vel": 3, "device": "phone", "user": "amar"},
      "ageS": 30, "inside": [{"id": "home", "name": "Home", "private": true}], "polledAt": null,
      "live": {"state": "connected", "since": 1700000000000, "lastFrameAt": 1700000100000, "reconnects": 2, "lastError": null},
      "fences": [
        {"id": "home", "name": "Home", "lat": 51.45, "lon": -0.97, "radius": 150, "private": true, "note": "privacy zone",
         "wake": ["al"], "expiresAt": null, "state": {"inside": true, "since": 1699990000000, "tst": 1700000100}},
        {"id": "gym", "name": "Buzz Gym", "lat": 51.46, "lon": -0.98, "radius": 80, "private": false, "note": null,
         "wake": [], "expiresAt": 1700100000000, "state": {"inside": false, "since": 1699995000000, "tst": 1700000100}},
        {"id": "new", "name": "Just added", "lat": 51.5, "lon": -1.0, "radius": 200, "private": false, "note": null,
         "wake": ["al", "ceo"], "expiresAt": null, "state": null}
      ]
    }"""

    @Test
    fun `location snapshot parses fix fences with state and live feed`() {
        val snap = parseLocationSnapshot(mapPayload)!!
        assertEquals(OtFix(51.45, -0.97, 1700000100, "phone", acc = 12.0, batt = 80), snap.fix)
        assertEquals("connected", snap.live?.state)
        assertEquals(2, snap.live?.reconnects)
        assertNull(snap.live?.lastError)
        assertEquals(listOf("home", "gym", "new"), snap.fences.map { it.id })
        val home = snap.fences[0]
        assertTrue(home.private)
        assertEquals("privacy zone", home.note)
        assertEquals(listOf("al"), home.wake)
        assertNull(home.expiresAt)
        assertEquals(FenceState(true, 1699990000000, 1700000100), home.state)
        val gym = snap.fences[1]
        assertFalse(gym.private)
        assertNull(gym.note)
        assertEquals(1700100000000, gym.expiresAt)
        assertEquals(false, gym.state?.inside)
        assertNull(snap.fences[2].state) // never evaluated → dashed on the map
        assertEquals(listOf("al", "ceo"), snap.fences[2].wake)
    }

    @Test
    fun `location snapshot tolerates missing sections and garbage`() {
        val bare = parseLocationSnapshot("""{"fences": []}""")!!
        assertNull(bare.fix)
        assertNull(bare.live)
        assertTrue(bare.fences.isEmpty())
        assertNull(parseLocationSnapshot("nope"))
        assertNull(parseLocationSnapshot("[]"))
        // a fence without coords or id is skipped, not fatal
        val partial = parseLocationSnapshot("""{"fences": [{"id": "x"}, {"name": "no id", "lat": 1, "lon": 2}, {"id": "ok", "lat": 1, "lon": 2}]}""")!!
        assertEquals(listOf("ok"), partial.fences.map { it.id })
        assertEquals("ok", partial.fences[0].name) // name falls back to id
    }

    @Test
    fun `location snapshot round-trips through the Room cache serializer`() {
        val snap = parseLocationSnapshot(mapPayload)!!
        val again = parseLocationSnapshot(locationSnapshotJson(snap))!!
        assertEquals(snap, again)
        // and the fix-less, live-less shape the repository actually caches
        val cached = LocationSnapshot(null, snap.fences, null)
        assertEquals(cached, parseLocationSnapshot(locationSnapshotJson(cached)))
    }

    @Test
    fun `location feed parses every state and requires one`() {
        val o = kotlinx.serialization.json.Json.parseToJsonElement("""{"state": "connecting", "since": null, "lastFrameAt": null, "reconnects": 1, "lastError": "closed 1006"}""").jsonObject
        assertEquals(LocationFeed("connecting", null, null, 1, "closed 1006"), parseLocationFeed(o))
        assertNull(parseLocationFeed(kotlinx.serialization.json.Json.parseToJsonElement("""{"reconnects": 1}""").jsonObject))
    }

    private fun state(current: List<OtFix> = emptyList(), track: List<OtFix> = emptyList(), rangeTo: Long, device: String? = null) =
        MapUiState(current = current, devices = current.mapNotNull { it.device }.distinct(), device = device, track = track, rangeFrom = rangeTo - MapUiState.DAY_MS, rangeTo = rangeTo)

    @Test
    fun `mergeLiveFix replaces the device's current fix newest-first and learns the device`() {
        val s = state(current = listOf(OtFix(1.0, 1.0, 100, "phone"), OtFix(2.0, 2.0, 90, "tablet")), rangeTo = 0)
        val out = mergeLiveFix(s, OtFix(3.0, 3.0, 200, "phone"))
        assertEquals(listOf(OtFix(3.0, 3.0, 200, "phone"), OtFix(2.0, 2.0, 90, "tablet")), out.current)
        assertEquals(listOf("phone", "tablet"), out.devices)
        assertEquals("phone", out.device) // null → first device
        // a fix with no device name belongs to the newest known device (SPA `fix.device ?? current[0].device`)
        val anon = mergeLiveFix(out, OtFix(4.0, 4.0, 300, null))
        assertEquals("phone", anon.current[0].device)
        assertEquals(4.0, anon.current[0].lat, 0.0)
        assertEquals(2, anon.current.size)
    }

    @Test
    fun `mergeLiveFix extends the track only when its range reaches now`() {
        val last = OtFix(1.0, 1.0, 1_000_000, "phone")
        val live = OtFix(1.1, 1.1, 1_000_060, "phone")
        // range ends at the last point → the polyline follows him
        val reaching = state(track = listOf(last), rangeTo = 1_000_000_000L + 30_000, device = "phone")
        assertEquals(listOf(last, live), mergeLiveFix(reaching, live).track)
        // range ended a day ago → history stays history
        val historic = state(track = listOf(last), rangeTo = 1_000_000_000L - 86_400_000, device = "phone")
        assertEquals(listOf(last), mergeLiveFix(historic, live).track)
        // another device's fix never extends this device's track
        val other = mergeLiveFix(reaching, live.copy(device = "tablet"))
        assertEquals(listOf(last), other.track)
        // an out-of-order (older) fix is not appended
        assertEquals(listOf(last), mergeLiveFix(reaching, live.copy(tst = 999_999)).track)
        // an empty track never grows from live fixes (nothing to extend)
        assertTrue(mergeLiveFix(state(rangeTo = 1_000_000_000L + 30_000), live).track.isEmpty())
    }

    // --- caches parse (snapshot {caches:[...]}) --- //

    @Test
    fun `caches parse with found, dnf, pmOnly and detail`() {
        val caches = parseCaches(
            """{"caches": [
              {"code": "GC1", "name": "Cache one", "lat": 51.4, "lon": -0.9, "type": "Traditional",
               "size": "Small", "difficulty": 2.5, "terrain": 1.5, "found": true, "dnf": false,
               "pmOnly": false, "owner": "bob", "hidden": "2020-01-01", "favorites": 12, "status": "enabled",
               "detail": {"hint": "under rock", "description": "d", "attributes": [{"slug": "dogs", "label": "Dogs", "enabled": true}],
                          "logs": [{"id": "l1", "type": "found_it", "text": "<p>TFTC</p>", "date": "2026-01-01", "author": "al"}],
                          "fetchedAt": 5}}
            ]}""",
        )
        assertEquals(1, caches.size)
        val c = caches[0]
        assertEquals("GC1", c.code)
        assertTrue(c.found)
        assertEquals(12, c.favorites)
        assertEquals("under rock", c.detail?.hint)
        assertEquals(1, c.detail?.logs?.size)
        assertEquals("found_it", c.detail?.logs?.first()?.type)
        assertTrue(c.detail?.attributes?.first()?.enabled == true)
    }

    // --- events parse --- //

    @Test
    fun `events parse with venue coords and online flag`() {
        val events = parseEvents(
            """{"events": [
              {"id": "e1", "title": "Hike", "dateTime": "2026-07-07T19:00:00+01:00", "endTime": "",
               "eventUrl": "https://meetup.com/x", "eventType": "PHYSICAL", "isOnline": false, "going": 8,
               "groupName": "Walkers", "venueName": "Park", "venueCity": "Reading", "lat": 51.45, "lon": -0.97},
              {"id": "e2", "title": "Online talk", "eventType": "ONLINE", "isOnline": true, "lat": null, "lon": null}
            ]}""",
        )
        assertEquals(2, events.size)
        assertEquals(51.45, events[0].lat!!, 0.001)
        assertEquals(8, events[0].going)
        assertTrue(events[1].isOnline)
        assertNull(events[1].lat)
    }

    // --- agent layer index parse + round trip --- //

    @Test
    fun `layer index parses meta, bbox, style, popup`() {
        val metas = parseLayerIndex(
            """{"layers": [
              {"slug": "where-to-move/towns", "group": "where-to-move", "name": "towns",
               "geometryTypes": ["Point"], "featureCount": 3, "bbox": [-2.0, 51.0, -1.0, 52.0],
               "style": {"color": "#22c55e", "size": 6, "animated": true,
                         "popup": ["name", {"key": "pop", "label": "Population"}]},
               "fit": true, "updatedAt": 99, "updatedBy": "home"}
            ]}""",
        )
        assertEquals(1, metas.size)
        val m = metas[0]
        assertEquals("where-to-move/towns", m.slug)
        assertEquals("where-to-move", m.group)
        assertEquals(listOf("Point"), m.geometryTypes)
        assertEquals(listOf(-2.0, 51.0, -1.0, 52.0), m.bbox)
        assertTrue(m.style.animated)
        assertEquals("#22c55e", m.style.color)
        assertEquals(2, m.style.popup.size)
        assertEquals("Population", m.style.popup[1].second)
        assertTrue(m.fit)
    }

    @Test
    fun `layer index tolerates bare array and skips slugless`() {
        val metas = parseLayerIndex("""[{"name": "x"}, {"slug": "a/b", "featureCount": 1}]""")
        assertEquals(1, metas.size)
        assertEquals("a/b", metas[0].slug)
    }

    // --- ymd (local-zone yyyy-MM-dd) --- //

    @Test
    fun `ymd formats a known instant`() {
        // Pick midday UTC so most zones land on the same calendar day.
        val ms = java.time.Instant.parse("2026-07-20T12:00:00Z").toEpochMilli()
        // We can't assume the test host's zone, but format shape must hold.
        assertTrue(ymd(ms).matches(Regex("""\d{4}-\d{2}-\d{2}""")))
    }
}
