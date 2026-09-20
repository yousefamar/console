package io.amar.console.data.agents

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Cron fire records (^plum-goat): the three optional fields parse when a hub
 *  ships them and stay null on an older hub; the row's status line matches the
 *  SPA CronPanel `TaskRow` — `next <in>` · `fired|queued <ago>` · `skip: …`. */
class CronStatusTest {

    private val relIn: (Long) -> String = { "${it / 60_000}m" }
    private val relAgo: (Long) -> String = { "${it / 60_000}m ago" }
    private val now = 1_000_000_000_000L

    private fun task(json: String) = Cron.taskFrom(Json.parseToJsonElement(json).jsonObject)

    @Test
    fun `new fields parse and are optional`() {
        val t = task("""{"id":"a","trigger":"* * * * *","prompt":"p","consecutiveSkips":0,
            "lastFiredAt":1,"lastAttemptAt":2,"lastOutcome":"queued (session mid-turn)","nextFireAt":3}""")
        assertEquals(2L, t.lastAttemptAt)
        assertEquals("queued (session mid-turn)", t.lastOutcome)
        assertEquals(3L, t.nextFireAt)

        val old = task("""{"id":"b","trigger":"* * * * *","prompt":"p","consecutiveSkips":0,"lastFiredAt":1}""")
        assertNull(old.lastAttemptAt)
        assertNull(old.lastOutcome)
        assertNull(old.nextFireAt)
    }

    @Test
    fun `hub nextFireAt wins over the client cron walk, disabled hides next`() {
        val t = task("""{"id":"a","trigger":"* * * * *","prompt":"p","consecutiveSkips":0,"nextFireAt":${now + 5 * 60_000}}""")
        assertEquals("next 5m", Cron.statusChips(t, now, computedNext = now + 60_000, relIn, relAgo).next)

        val older = task("""{"id":"a","trigger":"* * * * *","prompt":"p","consecutiveSkips":0}""")
        assertEquals("next 1m", Cron.statusChips(older, now, computedNext = now + 60_000, relIn, relAgo).next)
        assertNull(Cron.statusChips(older, now, computedNext = null, relIn, relAgo).next)

        val disabled = task("""{"id":"a","trigger":"* * * * *","prompt":"p","consecutiveSkips":0,"disabledAt":1,"nextFireAt":${now + 60_000}}""")
        assertNull(Cron.statusChips(disabled, now, computedNext = now + 60_000, relIn, relAgo).next)
    }

    @Test
    fun `last chip says queued when the outcome was a queue, fired otherwise`() {
        val fired = task("""{"id":"a","trigger":"x","prompt":"p","consecutiveSkips":0,"lastFiredAt":${now - 3 * 60_000},"lastOutcome":"fired"}""")
        assertEquals("fired 3m ago", Cron.statusChips(fired, now, null, relIn, relAgo).last)

        val queued = task("""{"id":"a","trigger":"x","prompt":"p","consecutiveSkips":0,"lastFiredAt":${now - 2 * 60_000},"lastOutcome":"queued (already pending from an earlier fire)"}""")
        assertEquals("queued 2m ago", Cron.statusChips(queued, now, null, relIn, relAgo).last)

        // An older hub: lastFiredAt without an outcome still reads as fired.
        val old = task("""{"id":"a","trigger":"x","prompt":"p","consecutiveSkips":0,"lastFiredAt":${now - 60_000}}""")
        assertEquals("fired 1m ago", Cron.statusChips(old, now, null, relIn, relAgo).last)

        val never = task("""{"id":"a","trigger":"x","prompt":"p","consecutiveSkips":0}""")
        assertNull(Cron.statusChips(never, now, null, relIn, relAgo).last)
    }

    @Test
    fun `skip chip follows lastSkipReason whatever produced it`() {
        val guard = task("""{"id":"a","trigger":"x","prompt":"p","consecutiveSkips":3,"lastGuardResult":"skipped","lastSkipReason":"guard: no change"}""")
        assertEquals("skip: guard: no change", Cron.statusChips(guard, now, null, relIn, relAgo).skip)

        // A missed slot is recorded without a guard result — it must still show.
        val missed = task("""{"id":"a","trigger":"x","prompt":"p","consecutiveSkips":1,
            "lastSkipReason":"missed fire due 2026-09-14T09:00:00.000Z — scheduler never ran it",
            "lastOutcome":"skipped: missed fire due 2026-09-14T09:00:00.000Z — scheduler never ran it"}""")
        assertEquals("skip: missed fire due 2026-09-14T09:00:00.000Z — scheduler never ran it", Cron.statusChips(missed, now, null, relIn, relAgo).skip)

        val clean = task("""{"id":"a","trigger":"x","prompt":"p","consecutiveSkips":0,"lastOutcome":"fired"}""")
        assertNull(Cron.statusChips(clean, now, null, relIn, relAgo).skip)
    }
}
