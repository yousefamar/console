package io.amar.console.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * The last few uncaught exceptions, kept ON THE PHONE until someone reads them
 * (`crashes` in the debug agent). The replay to the hub is not a record: the
 * stored crash was cleared the moment it was queued, and the hub's debug log
 * keeps about an hour under the notes sync's traffic, so on 10 Oct 2026 a v113
 * crash was known only as a bare CRASH row in `exits` 70 minutes later, with
 * no stack anywhere. Android itself keeps a trace only for ANRs and native
 * crashes, never for a Java one.
 *
 * Pure: the ring is one JSON string in the crash prefs, newest first.
 */
object CrashHistory {
    const val CAP = 5
    const val STACK_CAP = 4000

    data class Entry(
        val ts: Long,
        val version: String,
        val thread: String,
        val route: String?,
        val message: String,
        val stack: String,
    )

    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }

    /** [historyJson] with [entry] put first, capped at [cap]. Unreadable history starts again. */
    fun push(historyJson: String?, entry: Entry, cap: Int = CAP): String {
        val kept = (listOf(entry.copy(stack = entry.stack.take(STACK_CAP))) + parse(historyJson)).take(cap.coerceAtLeast(1))
        return JsonArray(kept.map(::encode)).toString()
    }

    fun parse(historyJson: String?): List<Entry> {
        if (historyJson.isNullOrBlank()) return emptyList()
        val arr = runCatching { Json.parseToJsonElement(historyJson) as? JsonArray }.getOrNull() ?: return emptyList()
        return arr.mapNotNull { el ->
            val o = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
            Entry(
                ts = o["ts"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null,
                version = o.str("version") ?: "?",
                thread = o.str("thread") ?: "?",
                route = o.str("route"),
                message = o.str("message") ?: return@mapNotNull null,
                stack = o.str("stack") ?: "",
            )
        }
    }

    /** What the `crashes` debug command answers: the ring as indented JSON, `[]` when empty. */
    fun render(historyJson: String?): String =
        json.encodeToString(JsonArray.serializer(), JsonArray(parse(historyJson).map(::encode)))

    private fun encode(e: Entry): JsonObject = buildJsonObject {
        put("ts", JsonPrimitive(e.ts))
        put("version", JsonPrimitive(e.version))
        put("thread", JsonPrimitive(e.thread))
        e.route?.let { put("route", JsonPrimitive(it)) }
        put("message", JsonPrimitive(e.message))
        put("stack", JsonPrimitive(e.stack))
    }

    private fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull
}
