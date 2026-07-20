package io.amar.console.data.longtail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeLogicTest {

    // --- richer snapshot parse (pm2 uptime/restarts, tailscale dnsName, external status) --- //

    @Test
    fun `snapshot parses pm2 uptime and restart count`() {
        val snap = parseDashboardSnapshot(
            """{"generatedAt": 111, "hub": {"uptimeMs": 5000, "sessions": 3},
                "pm2": [{"name": "console-server", "status": "online", "uptimeMs": 90000, "restartCount": 4, "memoryBytes": 157286400, "cpuPct": 1.2}]}""",
        )
        assertEquals(111L, snap.generatedAt)
        val p = snap.pm2[0]
        assertEquals(90000L, p.uptimeMs)
        assertEquals(4, p.restartCount)
        assertEquals(150, p.memoryMb)
    }

    @Test
    fun `snapshot parses external probe status and id`() {
        val snap = parseDashboardSnapshot(
            """{"external": [{"id": "srv_9", "name": "blog", "url": "https://x", "probe": {"ok": true, "latencyMs": 30, "status": 200}}]}""",
        )
        val e = snap.external[0]
        assertEquals("srv_9", e.id)
        assertEquals(30L, e.latencyMs)
        assertEquals(200, e.status)
    }

    // --- canvas meta --- //

    @Test
    fun `canvas meta parses placeholder + size`() {
        val m = parseCanvasMeta("""{"updatedAt": 500, "sizeBytes": 2048, "isPlaceholder": false}""")!!
        assertEquals(500L, m.updatedAt)
        assertEquals(2048L, m.sizeBytes)
        assertFalse(m.isPlaceholder)
        assertNull(parseCanvasMeta("garbage"))
    }

    // --- external servers list --- //

    @Test
    fun `external servers list parses id name url`() {
        val list = parseExternalServers("""{"servers": [{"id": "a", "name": "n", "url": "https://u"}]}""")
        assertEquals(1, list.size)
        assertEquals("a", list[0].id)
        assertEquals("https://u", list[0].url)
    }

    // --- blog drafts + projects --- //

    @Test
    fun `blog drafts parse path title mtime`() {
        val d = parseBlogDrafts("""[{"path": "scratch/blog-drafts/x.md", "title": "X", "mtime": 42}]""")
        assertEquals(1, d.size)
        assertEquals("X", d[0].title)
        assertEquals(42L, d[0].mtime)
    }

    @Test
    fun `blog projects parse status and null lastPost`() {
        val p = parseBlogProjects(
            """[{"slug": "cura", "title": "Cura", "path": "projects/cura.md", "status": "active", "lastPostMtime": null},
                {"slug": "old", "title": "Old", "path": "projects/old.md", "status": "dormant", "lastPostMtime": 99}]""",
        )
        assertEquals(2, p.size)
        assertNull(p[0].lastPostMtime)
        assertEquals("dormant", p[1].status)
        assertEquals(99L, p[1].lastPostMtime)
    }

    // --- formatters --- //

    @Test
    fun `countdown formats now, minutes, hours`() {
        assertEquals("now", formatCountdown(0))
        assertEquals("5m", formatCountdown(5 * 60_000L))
        assertEquals("1h 5m", formatCountdown(65 * 60_000L))
        assertEquals("2h", formatCountdown(120 * 60_000L))
    }

    @Test
    fun `ago formats just now, minutes, hours, days`() {
        assertEquals("just now", formatAgo(0))
        assertEquals("3m ago", formatAgo(3 * 60_000L))
        assertEquals("2h ago", formatAgo(2 * 3600_000L))
        assertEquals("1d ago", formatAgo(25 * 3600_000L))
    }

    @Test
    fun `bytes formats B K M`() {
        assertEquals("512B", formatBytes(512))
        assertEquals("2K", formatBytes(2048))
        assertEquals("150M", formatBytes(157286400))
    }

    @Test
    fun `canvas age formats s m h d`() {
        assertEquals("5s ago", formatCanvasAge(5000))
        assertEquals("3m ago", formatCanvasAge(3 * 60_000L))
        assertEquals("2h ago", formatCanvasAge(2 * 3600_000L))
    }

    // --- age tints (draft: 7/30d, project: 30/90d) --- //

    @Test
    fun `draft age tint buckets at 7 and 30 days`() {
        assertEquals(AgeTint.NORMAL, draftAgeTint(3.0))
        assertEquals(AgeTint.YELLOW, draftAgeTint(10.0))
        assertEquals(AgeTint.RED, draftAgeTint(40.0))
    }

    @Test
    fun `project age tint buckets at 30 and 90 days, null is normal`() {
        assertEquals(AgeTint.NORMAL, projectAgeTint(null))
        assertEquals(AgeTint.NORMAL, projectAgeTint(10.0))
        assertEquals(AgeTint.YELLOW, projectAgeTint(45.0))
        assertEquals(AgeTint.RED, projectAgeTint(120.0))
    }

    @Test
    fun `draft age string covers h d mo y`() {
        assertEquals("just now", formatDraftAge(0.01))
        assertTrue(formatDraftAge(0.5).endsWith("h ago"))
        assertEquals("5d ago", formatDraftAge(5.0))
        assertEquals("2mo ago", formatDraftAge(60.0))
        assertTrue(formatDraftAge(400.0).endsWith("y ago"))
    }

    @Test
    fun `project age string starts at today`() {
        assertEquals("today", formatProjectAge(0.3))
        assertEquals("5d ago", formatProjectAge(5.0))
    }
}
