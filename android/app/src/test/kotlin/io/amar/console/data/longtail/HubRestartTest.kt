package io.amar.console.data.longtail

import io.amar.console.core.HubClient
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/** The SPA `HubSection` contract: "back" means /health's startedAt MOVED, a
 *  refused POST stops, a dropped POST keeps polling, and 30 s with the old
 *  startedAt is a timeout. */
class HubRestartTest {

    private class Clock(var t: Long = 0L) {
        val sleep: suspend (Long) -> Unit = { t += it }
        val now: () -> Long = { t }
    }

    private fun probes(vararg values: Long?): suspend () -> Long? {
        val it = values.iterator()
        var last: Long? = values.lastOrNull()
        return { if (it.hasNext()) it.next().also { v -> last = v } else last }
    }

    @Test
    fun `back only when startedAt differs from the pre-restart probe`() {
        assertFalse(HubRestart.cameBack(before = 100, probe = 100))
        assertFalse(HubRestart.cameBack(before = 100, probe = null))
        assertTrue(HubRestart.cameBack(before = 100, probe = 101))
        // No baseline (hub was already unreachable) — any answer is the new process.
        assertTrue(HubRestart.cameBack(before = null, probe = 5))
    }

    @Test
    fun `old process answering during shutdown does not count, the new one does`() = runTest {
        val clock = Clock()
        val state = HubRestart.run(post = {}, probe = probes(100, 100, null, null, 200), sleep = clock.sleep, now = clock.now)
        assertEquals(HubRestart.State.Back(2), state)
    }

    @Test
    fun `thirty seconds of the old startedAt is a timeout`() = runTest {
        val clock = Clock()
        val state = HubRestart.run(post = {}, probe = probes(100), sleep = clock.sleep, now = clock.now)
        assertEquals(HubRestart.State.Timeout, state)
        assertTrue(clock.t >= HubRestart.TIMEOUT_MS)
    }

    @Test
    fun `a status from POST restart means refused, stop`() = runTest {
        val clock = Clock()
        val state = HubRestart.run(post = { throw HubClient.HttpException(403, "{\"error\":\"nope\"}") }, probe = probes(100, 200), sleep = clock.sleep, now = clock.now)
        assertEquals(HubRestart.State.Error("Hub returned 403"), state)
    }

    @Test
    fun `a transport error from POST restart means the hub is already going down, keep polling`() = runTest {
        val clock = Clock()
        val state = HubRestart.run(post = { throw IOException("connection reset") }, probe = probes(100, null, 300), sleep = clock.sleep, now = clock.now)
        assertEquals(HubRestart.State.Back(1), state)
        assertNull(HubRestart.postFailure(IOException("reset")))
    }

    @Test
    fun `startedAt is read off the health body`() {
        assertEquals(1_700_000_000_000L, HubRestart.startedAtOf("""{"ok":true,"startedAt":1700000000000,"pid":4}"""))
        assertNull(HubRestart.startedAtOf("""{"ok":true}"""))
    }
}
