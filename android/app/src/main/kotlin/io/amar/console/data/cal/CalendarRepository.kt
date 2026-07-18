package io.amar.console.data.cal

import androidx.room.withTransaction
import io.amar.console.core.HubClient
import io.amar.console.data.db.CalEventRow
import io.amar.console.data.db.CalendarRow
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Calendar domain. No hub resume cursor exists (by design — plan A5): the
 * connect-time reconcile refetches the display window (−30d..+90d, tens of
 * KB), and cal.delta broadcasts trigger the same. Mutations are optimistic
 * with ~temp compound keys; create carries clientToken (dedupeToken) so a
 * queued retry can't double-create.
 */
class CalendarRepository(
    private val db: ConsoleDb,
    private val hub: HubClient,
    private val syncBus: SyncBusClient,
    private val outbox: Outbox,
) {
    private val json = Json { ignoreUnknownKeys = true }

    companion object {
        const val TYPE_CREATE = "calCreate"
        const val TYPE_UPDATE = "calUpdate"
        const val TYPE_DELETE = "calDelete"
        const val TYPE_RSVP = "calRsvp"
        val WINDOW_PAST_MS = 30L * 24 * 60 * 60 * 1000
        val WINDOW_FUTURE_MS = 90L * 24 * 60 * 60 * 1000
    }

    fun observeEvents(startMs: Long, endMs: Long): Flow<List<CalEventRow>> =
        db.calendar().observeEventsInRange(startMs, endMs)

    fun observeCalendars(): Flow<List<CalendarRow>> = db.calendar().observeCalendars()

    // ---------------------------------------------------------------- //
    // Mutations

    suspend fun createEvent(
        accountEmail: String,
        calendarId: String,
        summary: String,
        startMs: Long,
        endMs: Long,
        isAllDay: Boolean = false,
        location: String? = null,
    ) {
        val token = outbox.mintToken()
        val tempKey = "$accountEmail:$calendarId:~${System.currentTimeMillis()}"
        val eventBody = buildEventJson(summary, startMs, endMs, isAllDay, location)
        db.calendar().upsertEvents(
            listOf(
                CalEventRow(
                    compoundKey = tempKey, accountEmail = accountEmail, calendarId = calendarId,
                    eventId = tempKey.substringAfterLast(':'), summary = summary,
                    location = location, startTime = startMs, endTime = endMs,
                    isAllDay = isAllDay, status = "confirmed", rawJson = eventBody.toString(),
                )
            )
        )
        val payload = buildJsonObject {
            put("tempKey", tempKey)
            put("account", accountEmail)
            put("calendarId", calendarId)
            put("event", eventBody)
        }
        outbox.enqueue(TYPE_CREATE, payload.toString(), entityId = tempKey, dedupeToken = token)
    }

    suspend fun deleteEvent(compoundKey: String) {
        val row = db.calendar().byKey(compoundKey) ?: return
        db.calendar().deleteByKey(compoundKey)
        if (row.eventId.startsWith("~")) {
            // Still queued — cancel the pending create instead of a server call.
            outbox.cancel(compoundKey, TYPE_CREATE)
            return
        }
        val payload = buildJsonObject {
            put("account", row.accountEmail)
            put("calendarId", row.calendarId)
            put("eventId", row.eventId)
        }
        outbox.enqueue(TYPE_DELETE, payload.toString(), entityId = compoundKey)
    }

    /** Edit summary/times/location on an existing event (queued PATCH). */
    suspend fun updateEvent(
        compoundKey: String,
        summary: String,
        startMs: Long,
        endMs: Long,
        location: String?,
    ) {
        val row = db.calendar().byKey(compoundKey) ?: return
        if (row.eventId.startsWith("~")) return // still queued — edit unsupported until created
        // Optimistic local update.
        db.calendar().upsertEvents(
            listOf(row.copy(summary = summary, startTime = startMs, endTime = endMs, location = location))
        )
        val payload = buildJsonObject {
            put("account", row.accountEmail)
            put("calendarId", row.calendarId)
            put("eventId", row.eventId)
            put("event", buildEventJson(summary, startMs, endMs, row.isAllDay, location))
        }
        outbox.enqueue(TYPE_UPDATE, payload.toString(), entityId = compoundKey)
    }

    suspend fun rsvp(compoundKey: String, status: String) {
        val row = db.calendar().byKey(compoundKey) ?: return
        val payload = buildJsonObject {
            put("account", row.accountEmail)
            put("calendarId", row.calendarId)
            put("eventId", row.eventId)
            put("status", status)
        }
        outbox.enqueue(TYPE_RSVP, payload.toString(), entityId = compoundKey)
    }

    private fun buildEventJson(summary: String, startMs: Long, endMs: Long, isAllDay: Boolean, location: String?): JsonObject =
        buildJsonObject {
            put("summary", summary)
            location?.let { put("location", it) }
            if (isAllDay) {
                put("start", buildJsonObject { put("date", isoDate(startMs)) })
                put("end", buildJsonObject { put("date", isoDate(endMs)) })
            } else {
                put("start", buildJsonObject { put("dateTime", isoDateTime(startMs)) })
                put("end", buildJsonObject { put("dateTime", isoDateTime(endMs)) })
            }
        }

    // ---------------------------------------------------------------- //
    // Outbox handlers

    fun registerOutboxHandlers() {
        outbox.register(TYPE_CREATE) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            try {
                val body = buildJsonObject {
                    p["event"]!!.jsonObject.forEach { (k, v) -> put(k, v) }
                    put("calendarId", p["calendarId"]!!.jsonPrimitive.content)
                    put("account", p["account"]!!.jsonPrimitive.content)
                    put("clientToken", row.dedupeToken)
                }
                val resp = hub.post("/cal/events", body.toString())
                // Swap the temp row for the real Google event.
                val created = json.parseToJsonElement(resp).jsonObject
                val tempKey = p["tempKey"]!!.jsonPrimitive.content
                val realId = created["id"]?.jsonPrimitive?.content
                if (realId != null) {
                    db.withTransaction {
                        db.calendar().deleteByKey(tempKey)
                        eventRowFromGoogle(created, p["account"]!!.jsonPrimitive.content, p["calendarId"]!!.jsonPrimitive.content)
                            ?.let { db.calendar().upsertEvents(listOf(it)) }
                    }
                }
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }

        outbox.register(TYPE_UPDATE) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            try {
                val body = buildJsonObject {
                    p["event"]!!.jsonObject.forEach { (k, v) -> put(k, v) }
                    put("calendarId", p["calendarId"]!!.jsonPrimitive.content)
                    put("account", p["account"]!!.jsonPrimitive.content)
                }
                hub.patch("/cal/events/${enc(p["eventId"]!!.jsonPrimitive.content)}", body.toString())
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }
        outbox.register(TYPE_DELETE) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            try {
                val eventId = p["eventId"]!!.jsonPrimitive.content
                val q = "?account=${enc(p["account"]!!.jsonPrimitive.content)}&calendarId=${enc(p["calendarId"]!!.jsonPrimitive.content)}"
                hub.delete("/cal/events/${enc(eventId)}$q")
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                // 404/410 = already gone — success for a delete.
                if (e.code == 404 || e.code == 410) Outbox.Result.Done
                else if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}")
                else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }

        outbox.register(TYPE_RSVP) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            try {
                val body = buildJsonObject {
                    put("status", p["status"]!!.jsonPrimitive.content)
                    put("calendarId", p["calendarId"]!!.jsonPrimitive.content)
                    put("account", p["account"]!!.jsonPrimitive.content)
                }
                hub.post("/cal/events/${enc(p["eventId"]!!.jsonPrimitive.content)}/rsvp", body.toString())
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }
    }

    // ---------------------------------------------------------------- //
    // Sync

    fun wireLiveDeltas(scope: CoroutineScope) {
        // cal.delta carries full event objects but scoping/pruning is easier
        // as a window refetch (same as SPA's 500ms-debounced refetch).
        syncBus.on("cal", "delta") { _ ->
            scope.launch { runCatching { reconcile() } }
        }
    }

    suspend fun reconcile() {
        // 1. Calendar list.
        val calsResp = runCatching { hub.get("/cal/calendars") }.getOrNull() ?: return
        val cals = (json.parseToJsonElement(calsResp) as? JsonArray)
            ?.mapNotNull { it as? JsonObject } ?: emptyList()
        val calRows = cals.mapNotNull { c ->
            val id = c["id"]?.jsonPrimitive?.content ?: return@mapNotNull null
            val account = c["accountEmail"]?.jsonPrimitive?.content ?: ""
            CalendarRow(
                id = "$account:$id", accountEmail = account, calendarId = id,
                name = c["summary"]?.jsonPrimitive?.content ?: id,
                color = c["backgroundColor"]?.jsonPrimitive?.content,
                accessRole = c["accessRole"]?.jsonPrimitive?.content ?: "reader",
                visible = true,
            )
        }
        if (calRows.isNotEmpty()) db.calendar().upsertCalendars(calRows)

        // 2. Events for the offline window — hub fans out across calendars.
        val now = System.currentTimeMillis()
        val timeMin = isoDateTime(now - WINDOW_PAST_MS)
        val timeMax = isoDateTime(now + WINDOW_FUTURE_MS)
        val eventsResp = runCatching {
            hub.get("/cal/events?timeMin=${enc(timeMin)}&timeMax=${enc(timeMax)}&singleEvents=true")
        }.getOrNull() ?: return
        val events = (json.parseToJsonElement(eventsResp) as? JsonArray)
            ?.mapNotNull { it as? JsonObject } ?: return

        db.withTransaction {
            val rows = events.mapNotNull { e ->
                val account = e["accountEmail"]?.jsonPrimitive?.content ?: ""
                val calId = e["calendarId"]?.jsonPrimitive?.content ?: ""
                eventRowFromGoogle(e, account, calId)
            }
            // Authoritative for the window: remove stale rows (keep ~temp
            // queued creates), then upsert.
            val serverKeys = rows.map { it.compoundKey }.toSet()
            val stale = db.calendar().keysInRange(now - WINDOW_PAST_MS, now + WINDOW_FUTURE_MS)
                .filter { it !in serverKeys && !it.contains(":~") }
            if (stale.isNotEmpty()) db.calendar().deleteByKeys(stale)
            if (rows.isNotEmpty()) db.calendar().upsertEvents(rows)
        }
    }

    suspend fun prune() {
        val now = System.currentTimeMillis()
        db.calendar().pruneOutsideWindow(now - WINDOW_PAST_MS, now + WINDOW_FUTURE_MS)
    }

    // ---------------------------------------------------------------- //

    internal fun eventRowFromGoogle(e: JsonObject, account: String, calendarId: String): CalEventRow? {
        val id = e["id"]?.jsonPrimitive?.content ?: return null
        val start = e["start"] as? JsonObject
        val end = e["end"] as? JsonObject
        val isAllDay = start?.get("date") != null
        val startMs = parseGoogleTime(start) ?: return null
        val endMs = parseGoogleTime(end) ?: startMs
        return CalEventRow(
            compoundKey = "$account:$calendarId:$id",
            accountEmail = account,
            calendarId = calendarId,
            eventId = id,
            summary = e["summary"]?.jsonPrimitive?.content ?: "(no title)",
            location = e["location"]?.jsonPrimitive?.content,
            startTime = startMs,
            endTime = endMs,
            isAllDay = isAllDay,
            status = e["status"]?.jsonPrimitive?.content ?: "confirmed",
            rawJson = e.toString(),
        )
    }

    private fun parseGoogleTime(t: JsonObject?): Long? {
        t ?: return null
        t["dateTime"]?.jsonPrimitive?.content?.let { iso ->
            return runCatching {
                // RFC3339 with offset — java.time handles it on API 26+.
                java.time.OffsetDateTime.parse(iso).toInstant().toEpochMilli()
            }.getOrNull()
        }
        t["date"]?.jsonPrimitive?.content?.let { d ->
            return runCatching {
                val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
                fmt.timeZone = TimeZone.getDefault()
                fmt.parse(d)?.time
            }.getOrNull()
        }
        return null
    }

    private fun isoDateTime(ms: Long): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US)
        return fmt.format(Date(ms))
    }

    private fun isoDate(ms: Long): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        return fmt.format(Date(ms))
    }

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
}
