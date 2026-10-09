package io.amar.console.data.agents

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AuthFailureTest {
    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject

    @Test fun `parses the hub shape`() {
        val f = AuthFailures.parse(obj("""{"at":12,"detail":"401 not logged in","count":4}"""))
        assertEquals(AuthFailure(12, "401 not logged in", 4), f)
        assertEquals("not logged in · 4 unanswered", f!!.label)
    }

    @Test fun `single failure has no count suffix`() {
        assertEquals("not logged in", AuthFailures.parse(obj("""{"at":1,"detail":"x","count":1}"""))!!.label)
    }

    @Test fun `null or absent is cleared`() {
        assertNull(AuthFailures.parse(null))
        assertNull(AuthFailures.parse(JsonNull))
    }

    @Test fun `fromSessions keeps only failing sessions`() {
        val m = AuthFailures.fromSessions(listOf(
            obj("""{"id":"a","authFailure":{"at":1,"detail":"d","count":2}}"""),
            obj("""{"id":"b"}"""),
            obj("""{"id":"c","authFailure":null}"""),
        ))
        assertEquals(setOf("a"), m.keys)
    }
}
