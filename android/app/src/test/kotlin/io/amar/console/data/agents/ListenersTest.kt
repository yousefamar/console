package io.amar.console.data.agents

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The hub `Listener` record (server/src/listeners/types.ts) parses into the
 *  phone model, and the pure formatters reproduce the SPA ListenerPanel's
 *  labels (src/components/agent/ListenerPanel.tsx) so both clients read the
 *  same rule the same way. */
class ListenersTest {

    private val now = 1_700_000_000_000L
    private val relIn: (Long) -> String = { ms -> "${ms / 60_000}m" }
    private val relAgo: (Long) -> String = { ms -> "${ms / 60_000}m ago" }
    private val date: (Long) -> String = { "D$it" }

    private fun parse(json: String) = Listeners.listenerFrom(Json.parseToJsonElement(json).jsonObject)

    private val wake = """{
        "id":"L1","name":"al mail","owner":{"claudeSessionId":"csid-a","agentKey":"al","cwd":"/x"},"ownerName":"AL",
        "createdAt":1,"on":"mail.received","where":[{"path":"data.account","op":"=","value":"al"},{"path":"data.subject","op":"~","value":"/urgent/i"}],
        "guard":"bash ~/exec/g.sh","coalesceMs":60000,"cooldownMs":600000,"hours":"07:00-23:00","days":"Mon-Fri","maxPerHour":12,
        "action":{"type":"wake","prompt":"New mail for al: {{data.subject}}","fork":true,"model":"haiku"},
        "times":2,"timesTotal":3,"expiresAt":${now + 2 * 3_600_000},
        "consecutiveSkips":0,
        "stats":{"matched":9,"fired":4,"guardSkipped":2,"lastEventAt":${now - 60_000},"lastFiredAt":${now - 3 * 60_000},"lastOutcome":"fired"},
        "pending":{"events":["e1","e2","e3"],"startedAt":${now - 10_000},"dueAt":${now + 50_000}},
        "firedAt":[],"outcomes":[]
    }"""

    @Test
    fun `wake listener parses every field the panel renders`() {
        val l = parse(wake)
        assertEquals("L1", l.id)
        assertEquals("csid-a", l.claudeSessionId)
        assertEquals("al", l.agentKey)
        assertEquals("AL", l.ownerName)
        assertEquals("mail.received", l.on)
        assertEquals(2, l.where.size)
        assertEquals("bash ~/exec/g.sh", l.guard)
        assertEquals(60_000L, l.coalesceMs)
        assertEquals(600_000L, l.cooldownMs)
        assertEquals("wake", l.action.type)
        assertTrue(l.action.fork)
        assertEquals("haiku", l.action.model)
        assertEquals(2, l.times); assertEquals(3, l.timesTotal)
        assertEquals(4, l.stats.fired); assertEquals(9, l.stats.matched); assertEquals(2, l.stats.guardSkipped)
        assertEquals(listOf("e1", "e2", "e3"), l.pending?.events)
        assertNull(l.expect)
        assertTrue(l.active); assertFalse(l.paused)
    }

    @Test
    fun `wake listener labels match the SPA row`() {
        val l = parse(wake)
        assertEquals("mail.received where data.account=al && data.subject~/urgent/i", Listeners.listenerSummary(l))
        assertEquals("wake (fork haiku): New mail for al: {{data.subject}}", Listeners.actionLine(l))
        assertEquals(listOf("coalesce 1m", "cooldown 10m", "Mon-Fri 07:00-23:00", "guard"), Listeners.gates(l))
        assertEquals(listOf("2/3 left", "expires in 120m"), Listeners.life(l, now, relIn))
        assertEquals(listOf("fired 4 · 3m ago", "matched 9", "guard-skipped 2"), Listeners.statsLine(l, now, relAgo))
        assertEquals(Listeners.StateChip("pending 3", Listeners.StateKind.INFO), Listeners.stateChip(l, now, relIn))
        assertEquals("in 0m", Listeners.nextIn(l, now, relIn))
        assertFalse(Listeners.outcomeBad(l.stats.lastOutcome))
    }

    private val relativeExpect = """{
        "id":"E1","owner":{"claudeSessionId":"csid-a"},"createdAt":1,
        "on":"geo.enter","where":[{"path":"data.fence","op":"=","value":"office"}],
        "coalesceMs":0,"cooldownMs":0,"maxPerHour":60,"consecutiveSkips":0,
        "action":{"type":"notify","title":"Not at the office yet"},
        "expect":{"after":{"on":"geo.leave","where":[{"path":"data.fence","op":"=","value":"home"}]},"withinMs":5400000,
                  "then":{"type":"notify","title":"Arrived"},
                  "pending":[{"armedAt":${now - 45 * 60_000},"deadlineAt":${now + 45 * 60_000},"triggerEventId":"ev9"}],
                  "matches":[],"satisfied":3,"missed":1},
        "stats":{"matched":4,"fired":1,"guardSkipped":0,"lastFiredAt":${now - 86_400_000},"lastOutcome":"missed: deadline passed"},
        "firedAt":[],"outcomes":[]
    }"""

    @Test
    fun `relative expectation renders rule, else-then, armed chip and one-line summary`() {
        val l = parse(relativeExpect)
        val e = l.expect!!
        assertEquals("geo.leave", e.afterOn)
        assertEquals(5_400_000L, e.withinMs)
        assertEquals(1, e.pending.size)
        assertEquals(3, e.satisfied); assertEquals(1, e.missed)

        assertEquals("expect geo.enter where data.fence=office within 90m after geo.leave where data.fence=home", Listeners.listenerSummary(l, date))
        assertEquals("else notify: Not at the office yet; then notify: Arrived", Listeners.actionLine(l))
        assertEquals(Listeners.StateChip("armed 1 · in 45m", Listeners.StateKind.INFO), Listeners.stateChip(l, now, relIn))
        assertEquals("in 45m", Listeners.nextIn(l, now, relIn))
        assertEquals(now + 45 * 60_000, Listeners.nextDeadline(l))
        assertEquals(
            "expect geo.enter where data.fence=office within 90m after geo.leave where data.fence=home · armed 1 · next in 45m → else notify: Not at the office yet; then notify: Arrived",
            Listeners.expectationSummary(l, now, relIn, date),
        )
        assertEquals(listOf("satisfied 3 · missed 1", "fired 1 · 1440m ago", "matched 4"), Listeners.statsLine(l, now, relAgo))
        assertTrue(Listeners.gates(l).isEmpty())
        assertTrue(Listeners.life(l, now, relIn).isEmpty())
    }

    @Test
    fun `absolute expectation quotes a cron, formats an epoch, and waits when nothing is armed`() {
        val cron = parse("""{"id":"E2","owner":{"claudeSessionId":"c"},"createdAt":1,"on":"geo.enter","where":[{"path":"data.fence","op":"=","value":"buzz-gym"}],
            "coalesceMs":0,"cooldownMs":0,"maxPerHour":60,"consecutiveSkips":0,"action":{"type":"wake","prompt":"No gym this week?"},
            "expect":{"by":"10 19 * * 2","windowMs":10800000,"pending":[],"matches":[],"satisfied":0,"missed":0},
            "stats":{"matched":0,"fired":0,"guardSkipped":0},"firedAt":[],"outcomes":[]}""")
        assertEquals("expect geo.enter where data.fence=buzz-gym by \"10 19 * * 2\" (window 3h)", Listeners.listenerSummary(cron, date))
        assertEquals(Listeners.StateChip("waiting", Listeners.StateKind.INFO), Listeners.stateChip(cron, now, relIn))
        assertNull(Listeners.nextIn(cron, now, relIn))
        assertEquals("expect geo.enter where data.fence=buzz-gym by \"10 19 * * 2\" (window 3h) · waiting → else wake: No gym this week?", Listeners.expectationSummary(cron, now, relIn, date))

        val epoch = parse("""{"id":"E3","owner":{"claudeSessionId":"c"},"createdAt":1,"on":"astera.release.landed","where":[],
            "coalesceMs":0,"cooldownMs":0,"maxPerHour":60,"consecutiveSkips":0,"action":{"type":"wake","prompt":"Release did not land"},
            "expect":{"by":"1700003600000","pending":[{"armedAt":1,"deadlineAt":1700003600000}],"matches":[],"satisfied":0,"missed":0},
            "stats":{"matched":0,"fired":0,"guardSkipped":0},"firedAt":[],"outcomes":[]}""")
        assertEquals("expect astera.release.landed by D1700003600000", Listeners.listenerSummary(epoch, date))
        assertEquals(Listeners.StateChip("armed 1 · in 60m", Listeners.StateKind.INFO), Listeners.stateChip(epoch, now, relIn))
    }

    @Test
    fun `describeAction covers all six kinds`() {
        assertEquals("wake: hi", Listeners.describeAction(Listeners.Action("wake", prompt = "hi")))
        assertEquals("wake (fork) @ceo: hi", Listeners.describeAction(Listeners.Action("wake", prompt = "hi", fork = true, asKey = "ceo")))
        assertEquals("wake (fork haiku): hi", Listeners.describeAction(Listeners.Action("wake", prompt = "hi", fork = true, model = "haiku")))
        assertEquals("run: bash x.sh", Listeners.describeAction(Listeners.Action("run", cmd = "bash x.sh")))
        assertEquals("post POST https://h/x", Listeners.describeAction(Listeners.Action("post", url = "https://h/x")))
        assertEquals("post PUT https://h/x", Listeners.describeAction(Listeners.Action("post", url = "https://h/x", method = "PUT")))
        assertEquals("notify: Ping", Listeners.describeAction(Listeners.Action("notify", title = "Ping")))
        assertEquals("emit console.card.done", Listeners.describeAction(Listeners.Action("emit", topic = "console.card.done")))
        assertEquals("card console: Look into X", Listeners.describeAction(Listeners.Action("card", project = "console", text = "Look into X")))
        assertEquals("teleport", Listeners.describeAction(Listeners.Action("teleport")))
    }

    @Test
    fun `fmtDur uses whole units like the SPA`() {
        assertEquals("1h", Listeners.fmtDur(3_600_000))
        assertEquals("10m", Listeners.fmtDur(600_000))
        assertEquals("90s", Listeners.fmtDur(90_000))
        assertEquals("24h", Listeners.fmtDur(86_400_000))
    }

    @Test
    fun `whereText spells the in operator with spaces and joins with and-and`() {
        assertEquals("data.room in !a,!b && topic^=chat", Listeners.whereText(listOf(
            Listeners.Where("data.room", "in", "!a,!b"), Listeners.Where("topic", "^=", "chat"),
        )))
    }

    @Test
    fun `outcomeBad flags skipped error paused dropped, not guard-skipped or fired`() {
        assertTrue(Listeners.outcomeBad("skipped: target not live"))
        assertTrue(Listeners.outcomeBad("error: spawn failed"))
        assertTrue(Listeners.outcomeBad("paused: ceiling 12/h"))
        assertTrue(Listeners.outcomeBad("dropped: outside window"))
        assertFalse(Listeners.outcomeBad("guard-skipped"))
        assertFalse(Listeners.outcomeBad("fired"))
        assertFalse(Listeners.outcomeBad(null))
    }

    @Test
    fun `state chip precedence is disabled, paused, armed, waiting, pending, idle`() {
        val base = parse(wake)
        assertEquals(Listeners.StateKind.DISABLED, Listeners.stateChip(base.copy(disabledAt = 1, pausedAt = 1), now, relIn)?.kind)
        assertEquals(Listeners.StateChip("paused", Listeners.StateKind.PAUSED), Listeners.stateChip(base.copy(pausedAt = 1), now, relIn))
        assertNull(Listeners.stateChip(base.copy(pending = null), now, relIn))
    }

    @Test
    fun `life reads once for a single-shot and expired past the deadline`() {
        val l = parse(wake).copy(times = 1, timesTotal = 1, expiresAt = now - 1)
        assertEquals(listOf("once", "expired"), Listeners.life(l, now, relIn))
        assertEquals(listOf("5/5 left"), Listeners.life(l.copy(times = 5, timesTotal = null, expiresAt = null), now, relIn))
    }

    @Test
    fun `pill counts active and paused, hides when none active`() {
        val a = parse(wake)
        assertNull(Listeners.pillCounts(emptyList()))
        assertNull(Listeners.pillCounts(listOf(a.copy(disabledAt = 1))))
        assertEquals(Listeners.PillCounts(3, 1), Listeners.pillCounts(listOf(a, a.copy(id = "b", pausedAt = 5), a.copy(id = "c"), a.copy(id = "d", disabledAt = 1))))
    }

    @Test
    fun `an older hub record with sparse fields still parses`() {
        val l = parse("""{"id":"old","owner":{"claudeSessionId":"c"},"on":"chat.message","action":{"type":"run","cmd":"true"}}""")
        assertEquals("chat.message", Listeners.listenerSummary(l))
        assertEquals("run: true", Listeners.actionLine(l))
        assertEquals(0L, l.coalesceMs)
        assertEquals(listOf("fired 0"), Listeners.statsLine(l, now, relAgo))
        assertNull(Listeners.stateChip(l, now, relIn))
        assertTrue(l.where.isEmpty())
    }
}
