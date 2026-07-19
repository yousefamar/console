package io.amar.console.data.longtail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LongTailLogicTest {

    // --- parseTagsJson --- //

    @Test
    fun `tags json parses to a list`() {
        assertEquals(listOf("dev", "ai/tools"), parseTagsJson("""["dev","ai/tools"]"""))
    }

    @Test
    fun `null, blank, and garbage tag json give empty`() {
        assertEquals(emptyList<String>(), parseTagsJson(null))
        assertEquals(emptyList<String>(), parseTagsJson(""))
        assertEquals(emptyList<String>(), parseTagsJson("not json"))
        assertEquals(emptyList<String>(), parseTagsJson("{}"))
    }

    @Test
    fun `blank tags are filtered`() {
        assertEquals(listOf("a"), parseTagsJson("""["a",""]"""))
    }

    // --- dashboard snapshot parse (shape from server/src/dashboard.ts) --- //

    @Test
    fun `snapshot parses hub, tailscale, pm2, external`() {
        val raw = """
        {
          "generatedAt": 1,
          "hub": {"ok": true, "uptimeMs": 7260000, "sessions": 12},
          "tailscale": [
            {"hostname": "amarhp", "dnsName": "amarhp.ts.net", "os": "linux", "online": true, "self": true},
            {"hostname": "phone", "online": false, "self": false}
          ],
          "pm2": [
            {"name": "console-server", "pid": 4, "status": "online", "uptimeMs": 5, "restartCount": 2, "memoryBytes": 157286400, "cpuPct": 1.5}
          ],
          "external": [
            {"id": "srv_1", "name": "blog", "url": "https://x", "probe": {"ok": true, "latencyMs": 42, "status": 200}},
            {"id": "srv_2", "name": "down", "url": "https://y", "probe": {"ok": false, "error": "timeout", "latencyMs": 3000}}
          ]
        }
        """.trimIndent()
        val snap = parseDashboardSnapshot(raw)
        assertEquals(7260000L, snap.hub?.uptimeMs)
        assertEquals(12, snap.hub?.sessions)
        assertEquals(2, snap.tailscale.size)
        assertTrue(snap.tailscale[0].online)
        assertTrue(snap.tailscale[0].self)
        assertFalse(snap.tailscale[1].online)
        assertEquals(1, snap.pm2.size)
        assertEquals("online", snap.pm2[0].status)
        assertEquals(150, snap.pm2[0].memoryMb)
        assertEquals(2, snap.external.size)
        assertTrue(snap.external[0].ok)
        assertEquals(42L, snap.external[0].latencyMs)
        assertFalse(snap.external[1].ok)
        assertEquals("timeout", snap.external[1].error)
    }

    @Test
    fun `garbage snapshot gives empty struct`() {
        val snap = parseDashboardSnapshot("nope")
        assertNull(snap.hub)
        assertTrue(snap.tailscale.isEmpty())
    }

    // --- alerts parse ({alerts: [...]} kind-tagged union) --- //

    @Test
    fun `alerts parse all three kinds and skip unknown`() {
        val raw = """
        {"alerts": [
          {"kind": "agent-approval", "sessionId": "s1", "sessionName": "Al", "requestId": "r", "toolName": "AskUserQuestion", "question": "Deploy?", "ts": 1},
          {"kind": "cal-upcoming", "summary": "Standup", "startMs": 123, "calendarId": "c"},
          {"kind": "error", "ts": 5, "source": "net", "message": "GET /x → 500"},
          {"kind": "future-thing", "foo": 1}
        ]}
        """.trimIndent()
        val alerts = parseDashboardAlerts(raw)
        assertEquals(3, alerts.size)
        val approval = alerts[0] as DashboardAlert.Approval
        assertEquals("s1", approval.sessionId)
        assertEquals("Al", approval.sessionName)
        assertEquals("Deploy?", approval.question)
        val upcoming = alerts[1] as DashboardAlert.Upcoming
        assertEquals("Standup", upcoming.summary)
        assertEquals(123L, upcoming.startMs)
        val err = alerts[2] as DashboardAlert.Err
        assertEquals("net", err.source)
    }

    @Test
    fun `empty or malformed alerts give empty list`() {
        assertTrue(parseDashboardAlerts("{}").isEmpty())
        assertTrue(parseDashboardAlerts("garbage").isEmpty())
    }

    // --- uptime format --- //

    @Test
    fun `uptime formats minutes, hours, days`() {
        assertEquals("5m", formatUptime(5 * 60_000L))
        assertEquals("2h 1m", formatUptime((2 * 60 + 1) * 60_000L))
        assertEquals("3d 4h", formatUptime(((3 * 24 + 4) * 60L + 9) * 60_000L))
    }

    // --- spotify disallows --- //

    @Test
    fun `disallows gate shuffle, repeat, seek`() {
        assertTrue(shuffleAllowed(emptyList()))
        assertFalse(shuffleAllowed(listOf("toggling_shuffle")))
        assertTrue(repeatAllowed(emptyList()))
        assertFalse(repeatAllowed(listOf("toggling_repeat_context")))
        assertFalse(repeatAllowed(listOf("toggling_repeat_track")))
        assertTrue(seekAllowed(listOf("toggling_shuffle")))
        assertFalse(seekAllowed(listOf("seeking")))
    }

    // --- glasses config + mic status parse --- //

    @Test
    fun `glasses config parses channels and angle`() {
        val cfg = parseGlassesConfig(
            """{"notifyEnabled": false, "channels": {"mail": true, "chat": false}, "hudEnabled": true, "headUpAngleDeg": 25}"""
        )!!
        assertFalse(cfg.notifyEnabled)
        assertEquals(mapOf("mail" to true, "chat" to false), cfg.channels)
        assertTrue(cfg.hudEnabled)
        assertEquals(25, cfg.headUpAngleDeg)
    }

    @Test
    fun `glasses config defaults on missing fields`() {
        val cfg = parseGlassesConfig("{}")!!
        assertTrue(cfg.notifyEnabled)
        assertEquals(30, cfg.headUpAngleDeg)
        assertNull(parseGlassesConfig("garbage"))
    }

    @Test
    fun `mic status parses owner name and hot`() {
        val s = parseMicStatus("""{"owner": "sess1", "ownerName": "Al", "hot": true, "explicit": null}""")!!
        assertEquals("Al", s.ownerName)
        assertTrue(s.hot)
    }
}
