package io.amar.console.data.longtail

import io.amar.console.core.HubClient
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.io.IOException

/**
 * Graceful hub restart from the phone — the port of the SPA's `HubSection`
 * (AccountModal.tsx): `POST /restart`, then poll `/health` until its
 * `startedAt` differs from the one read BEFORE the request. The old process
 * keeps answering during its shutdown window, so "any 200" would pass as
 * "back" — only a moved `startedAt` counts.
 */
object HubRestart {
    sealed interface State {
        data object Idle : State
        data object Restarting : State
        data class Back(val secs: Int) : State
        data object Timeout : State
        data class Error(val message: String) : State
    }

    const val TIMEOUT_MS = 30_000L
    const val POLL_MS = 400L
    const val PROBE_TIMEOUT_MS = 2_000L

    /** The new process has answered: a probe landed and its startedAt is not the one we saw before. */
    fun cameBack(before: Long?, probe: Long?): Boolean = probe != null && probe != before

    /** What a failed `POST /restart` means: a status = the hub answered and
     *  refused (stop); a transport error = it is already going down (keep polling). */
    fun postFailure(e: Throwable): State.Error? =
        (e as? HubClient.HttpException)?.let { State.Error("Hub returned ${it.code}") }

    suspend fun run(hub: HubClient): State = run(
        post = { hub.post("/restart", "{}") },
        probe = { withTimeoutOrNull(PROBE_TIMEOUT_MS) { runCatching { startedAtOf(hub.get("/health")) }.getOrNull() } },
        sleep = { delay(it) },
        now = { System.currentTimeMillis() },
    )

    /** The state machine with its IO injected (tested with fakes). */
    suspend fun run(
        post: suspend () -> Unit,
        probe: suspend () -> Long?,
        sleep: suspend (Long) -> Unit,
        now: () -> Long,
    ): State {
        val t0 = now()
        val before = probe()
        try {
            post()
        } catch (e: IOException) {
            postFailure(e)?.let { return it }
        }
        while (now() - t0 < TIMEOUT_MS) {
            sleep(POLL_MS)
            if (cameBack(before, probe())) return State.Back(((now() - t0) / 1000.0).let { Math.round(it).toInt() })
        }
        return State.Timeout
    }

    internal fun startedAtOf(healthJson: String): Long? =
        (Json.parseToJsonElement(healthJson) as? JsonObject)?.get("startedAt")?.jsonPrimitive?.longOrNull
}
