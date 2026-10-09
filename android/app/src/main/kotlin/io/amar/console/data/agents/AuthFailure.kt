package io.amar.console.data.agents

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Hub `SessionInfo.authFailure`: the session's backend answered "not logged
 * in" and nothing real has answered since. Hub-authoritative on every
 * `sessions_list` — absent means cleared, so it is never carried forward.
 */
data class AuthFailure(val at: Long, val detail: String, val count: Int) {
    val label: String get() = if (count > 1) "not logged in · $count unanswered" else "not logged in"
}

object AuthFailures {
    fun parse(el: JsonElement?): AuthFailure? {
        val o = el as? JsonObject ?: return null
        return AuthFailure(
            at = o["at"]?.jsonPrimitive?.longOrNull ?: 0L,
            detail = (o["detail"] as? JsonPrimitive)?.contentOrNull.orEmpty(),
            count = o["count"]?.jsonPrimitive?.intOrNull ?: 1,
        )
    }

    /** sessionId → failure, for every session in one `sessions_list` push. */
    fun fromSessions(sessions: List<JsonObject>): Map<String, AuthFailure> =
        sessions.mapNotNull { s ->
            val id = (s["id"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
            parse(s["authFailure"])?.let { id to it }
        }.toMap()
}
