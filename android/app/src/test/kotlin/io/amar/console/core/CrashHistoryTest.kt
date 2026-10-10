package io.amar.console.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CrashHistoryTest {

    private fun entry(ts: Long, message: String = "IllegalStateException: boom $ts", stack: String = "at a.b.C(C.kt:$ts)") =
        CrashHistory.Entry(ts = ts, version = "0.2.113 (113)", thread = "main", route = "mail/thread/abc", message = message, stack = stack)

    @Test
    fun `a crash is kept with everything needed to place it`() {
        val back = CrashHistory.parse(CrashHistory.push(null, entry(1000)))
        assertEquals(listOf(entry(1000)), back)
    }

    @Test
    fun `newest first and capped`() {
        var h: String? = null
        for (ts in 1L..8L) h = CrashHistory.push(h, entry(ts))
        assertEquals(listOf(8L, 7L, 6L, 5L, 4L), CrashHistory.parse(h).map { it.ts })
    }

    @Test
    fun `unreadable history starts again instead of losing the new crash`() {
        for (bad in listOf("", "   ", "not json", "{\"ts\":1}", "[1, \"x\", {\"no\":\"ts\"}]")) {
            assertEquals(bad, listOf(9L), CrashHistory.parse(CrashHistory.push(bad, entry(9))).map { it.ts })
        }
    }

    @Test
    fun `a long stack is cut, a missing route stays missing`() {
        val long = "x".repeat(CrashHistory.STACK_CAP + 500)
        val back = CrashHistory.parse(CrashHistory.push(null, entry(1, stack = long).copy(route = null))).single()
        assertEquals(CrashHistory.STACK_CAP, back.stack.length)
        assertNull(back.route)
    }

    @Test
    fun `render answers the debug command, empty included`() {
        assertEquals("[]", CrashHistory.render(null).replace(Regex("\\s"), ""))
        val out = CrashHistory.render(CrashHistory.push(null, entry(42)))
        assertTrue(out.contains("\"version\": \"0.2.113 (113)\""))
        assertTrue(out.contains("IllegalStateException: boom 42"))
        assertEquals(listOf(entry(42)), CrashHistory.parse(out))
    }
}
