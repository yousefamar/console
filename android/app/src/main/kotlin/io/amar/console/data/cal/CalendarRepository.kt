package io.amar.console.data.cal

import androidx.room.withTransaction
import io.amar.console.core.HubClient
import io.amar.console.core.HubPrefs
import io.amar.console.data.db.CalEventRow
import io.amar.console.data.db.CalendarRow
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
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
 *
 * Read-only overlay sources (Meetup, OutdoorLads) live in-memory and are merged
 * into the observed event stream — never persisted, never Google-synced.
 */
class CalendarRepository(
    private val db: ConsoleDb,
    private val hub: HubClient,
    private val syncBus: SyncBusClient,
    private val outbox: Outbox,
) {
    private val json = Json { ignoreUnknownKeys = true }

    /** Flight watchlists ride on the same hub+bus; exposed so the calendar UI
     *  can drive the flights panel without a separate graph wire. */
    val flights: FlightsRepository by lazy { FlightsRepository(hub, syncBus) }

    companion object {
        const val TYPE_CREATE = "calCreate"
        const val TYPE_UPDATE = "calUpdate"
        const val TYPE_DELETE = "calDelete"
        const val TYPE_RSVP = "calRsvp"
        const val TYPE_REMINDER = "calReminder"
        const val TYPE_LOCATION = "calLocation"
        val WINDOW_PAST_MS = 30L * 24 * 60 * 60 * 1000
        val WINDOW_FUTURE_MS = 90L * 24 * 60 * 60 * 1000
    }

    // ---------------------------------------------------------------- //
    // In-memory read-only overlays (Meetup / OutdoorLads)

    private val overlayEvents = MutableStateFlow<Map<String, List<CalEventRow>>>(emptyMap())
    private val overlayCalendars = MutableStateFlow<Map<String, CalendarRow>>(emptyMap())

    /** Calendar default-reminder minutes per calendar id (from /cal/calendars). */
    private val calendarDefaults = MutableStateFlow<Map<String, List<Int>>>(emptyMap())
    fun observeCalendarDefaults(): StateFlow<Map<String, List<Int>>> = calendarDefaults

    private fun setOverlay(source: String, calRow: CalendarRow, events: List<CalEventRow>) {
        if (events.isEmpty()) {
            overlayEvents.value = overlayEvents.value - source
            overlayCalendars.value = overlayCalendars.value - source
        } else {
            overlayEvents.value = overlayEvents.value + (source to events)
            overlayCalendars.value = overlayCalendars.value + (source to calRow)
        }
    }

    // ---------------------------------------------------------------- //
    // Reads

    /** Room events in range MERGED with in-memory overlay events in the same range. */
    fun observeEvents(startMs: Long, endMs: Long): Flow<List<CalEventRow>> =
        combine(db.calendar().observeEventsInRange(startMs, endMs), overlayEvents) { rows, overlays ->
            val extra = overlays.values.flatten().filter { it.startTime < endMs && it.endTime > startMs }
            (rows + extra).sortedBy { it.startTime }
        }

    /** Room calendars MERGED with synthetic overlay calendars. */
    fun observeCalendars(): Flow<List<CalendarRow>> =
        combine(db.calendar().observeCalendars(), overlayCalendars) { rows, overlays ->
            rows + overlays.values.filter { ov -> rows.none { it.id == ov.id } }
        }

    fun observeAccounts(): Flow<List<CalendarAccount>> = accountsFlow
    private val accountsFlow = MutableStateFlow<List<CalendarAccount>>(emptyList())

    // ---------------------------------------------------------------- //
    // Hub-synced calendar prefs (cross-device): visible calendar allow-list +
    // default calendar id. Mirrors the SPA keys calendar.visibleIds /
    // calendar.defaultId under /config. null visibleIds = "not yet loaded /
    // all visible" (first-load default). Optimistic local write + /config PUT.

    private val _visibleIds = MutableStateFlow<Set<String>?>(null)
    val visibleIds: StateFlow<Set<String>?> = _visibleIds
    private val _defaultCalendarId = MutableStateFlow<String?>(null)
    val defaultCalendarId: StateFlow<String?> = _defaultCalendarId

    private val _overlaySeen = MutableStateFlow<Set<String>>(emptySet())

    private suspend fun hydratePrefs() {
        runCatching {
            val cfg = json.parseToJsonElement(hub.get("/config")).jsonObject
            (cfg["calendar.visibleIds"] as? JsonArray)?.let { arr ->
                _visibleIds.value = arr.mapNotNull { it.jsonPrimitive.content }.toSet()
            }
            _defaultCalendarId.value = cfg["calendar.defaultId"]?.jsonPrimitive?.content
            (cfg["calendar.overlaySeen"] as? JsonArray)?.let { arr ->
                _overlaySeen.value = arr.mapNotNull { it.jsonPrimitive.content }.toSet()
            }
        }
    }

    /**
     * A saved visibleIds allow-list that predates an overlay (Meetup/OutdoorLads)
     * would hide it even though the user never opted out. For any overlay id not
     * yet in overlaySeen: default it visible and mark it seen — only an explicit
     * toggle-off then sticks. No-op until visibleIds has loaded (else the
     * first-load "all visible" default already covers overlays).
     */
    fun ensureOverlaysVisible(overlayIds: Set<String>) {
        val vis = _visibleIds.value ?: return
        val unseen = overlayIds - _overlaySeen.value
        if (unseen.isEmpty()) return
        _overlaySeen.value = _overlaySeen.value + unseen
        _visibleIds.value = vis + unseen
        putConfig(buildJsonObject {
            putJsonArray("calendar.visibleIds") { (_visibleIds.value ?: emptySet()).forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
            putJsonArray("calendar.overlaySeen") { _overlaySeen.value.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
        })
    }

    fun setVisibleIds(ids: Set<String>) {
        _visibleIds.value = ids
        putConfig(buildJsonObject { putJsonArray("calendar.visibleIds") { ids.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } } })
    }

    fun setDefaultCalendar(id: String?) {
        _defaultCalendarId.value = id
        putConfig(buildJsonObject { put("calendar.defaultId", id ?: "") })
    }

    private var appScope: CoroutineScope? = null

    private fun putConfig(patch: JsonObject) {
        // Route through HubPrefs so the shared /config mirror stays consistent
        // (setPrefs shallow-merges locally + PUTs), rather than a bare hub.put
        // that leaves HubPrefs.prefs stale.
        appScope?.launch { runCatching { HubPrefs.setPrefs(hub, patch) } }
    }

    // ---------------------------------------------------------------- //
    // Accounts (OAuth add / remove) — port of src/calendar/accounts.ts

    data class CalendarAccount(val email: String, val isPrimary: Boolean)

    /** GET /cal/accounts — degrades to [] (never throws), mirroring the SPA. */
    suspend fun getAccounts(): List<CalendarAccount> {
        val list = runCatching {
            val resp = hub.get("/cal/accounts")
            (json.parseToJsonElement(resp) as? JsonArray)?.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                CalendarAccount(
                    email = o["email"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                    isPrimary = (o["isPrimary"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "true",
                )
            } ?: emptyList()
        }.getOrDefault(emptyList())
        accountsFlow.value = list
        return list
    }

    /**
     * Poll /auth/google/poll until the OAuth flow (opened in a Custom Tab)
     * completes. Returns the new account email, or null on timeout/cancel.
     * The caller opens the Custom Tab to /auth/google/start; we poll for the
     * result (1s cadence, 5-min hard cap — SPA parity).
     */
    suspend fun pollForNewAccount(timeoutMs: Long = 5 * 60 * 1000): String? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val email = runCatching {
                val resp = hub.get("/auth/google/poll")
                val o = json.parseToJsonElement(resp).jsonObject
                if ((o["done"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "true")
                    o["email"]?.jsonPrimitive?.content else null
            }.getOrNull()
            if (email != null) {
                getAccounts()
                runCatching { reconcile() }
                return email
            }
            delay(1000)
        }
        return null
    }

    /** DELETE /cal/accounts/:email + purge that account's local rows. */
    suspend fun removeAccount(email: String) {
        runCatching { hub.delete("/cal/accounts/${enc(email)}") }
        db.calendar().deleteCalendarsForAccount(email)
        db.calendar().deleteEventsForAccount(email)
    }

    // ---------------------------------------------------------------- //
    // Contacts (guest autocomplete) — GET /mail/contacts?q=

    data class Contact(val name: String, val email: String)

    suspend fun searchContacts(query: String): List<Contact> {
        if (query.isBlank()) return emptyList()
        return runCatching {
            val resp = hub.get("/mail/contacts?q=${enc(query)}")
            (json.parseToJsonElement(resp) as? JsonArray)?.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val email = o["email"]?.jsonPrimitive?.content ?: return@mapNotNull null
                Contact(name = o["name"]?.jsonPrimitive?.content ?: "", email = email)
            } ?: emptyList()
        }.getOrDefault(emptyList())
    }

    // ---------------------------------------------------------------- //
    // Mutations

    /**
     * Create an event. [attendees] are `email` or `Name <email>` strings; when
     * present a Google Meet conference is auto-requested (SPA parity) and the
     * organizer (accountEmail) is auto-added as an accepted attendee.
     */
    suspend fun createEvent(
        accountEmail: String,
        calendarId: String,
        summary: String,
        startMs: Long,
        endMs: Long,
        isAllDay: Boolean = false,
        location: String? = null,
        description: String? = null,
        attendees: List<String> = emptyList(),
        addMeet: Boolean = attendees.isNotEmpty(),
    ) {
        val token = outbox.mintToken()
        val tempKey = "$accountEmail:$calendarId:~${System.currentTimeMillis()}"
        val eventBody = buildEventJson(
            summary, startMs, endMs, isAllDay, location, description,
            attendeeJson(accountEmail, attendees), addMeet,
        )
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

    /**
     * Edit an event (queued PATCH). Supports summary/times/location/description
     * and guests. When [targetCalendarId] differs from the row's calendar the
     * edit becomes a MOVE — Google can't PATCH the calendar, so we delete from
     * the old calendar and create in the new one (SPA parity).
     */
    suspend fun updateEvent(
        compoundKey: String,
        summary: String,
        startMs: Long,
        endMs: Long,
        location: String?,
        description: String? = null,
        attendees: List<String> = emptyList(),
        targetAccountEmail: String? = null,
        targetCalendarId: String? = null,
        scope: String = "single", // single | all — recurring edit scope
    ) {
        val row = db.calendar().byKey(compoundKey) ?: return
        if (row.eventId.startsWith("~")) return // still queued — edit unsupported until created

        val moving = targetCalendarId != null && targetAccountEmail != null &&
            (targetCalendarId != row.calendarId || targetAccountEmail != row.accountEmail)

        if (moving) {
            // Move = delete old + create new. Optimistic: remove the old row now.
            db.calendar().deleteByKey(compoundKey)
            outbox.enqueue(TYPE_DELETE, buildJsonObject {
                put("account", row.accountEmail); put("calendarId", row.calendarId); put("eventId", row.eventId)
            }.toString(), entityId = compoundKey)
            createEvent(
                targetAccountEmail!!, targetCalendarId!!, summary, startMs, endMs,
                row.isAllDay, location, description, attendees,
            )
            return
        }

        // For a recurring "all events" scope, patch the master series.
        val details = parseEventDetails(row.rawJson)
        val patchId = if (scope == "all" && details.recurringEventId != null) details.recurringEventId else row.eventId

        db.calendar().upsertEvents(
            listOf(row.copy(summary = summary, startTime = startMs, endTime = endMs, location = location))
        )
        val eventBody = buildEventJson(
            summary, startMs, endMs, row.isAllDay, location, description,
            attendeeJson(row.accountEmail, attendees), addMeet = false,
        )
        val payload = buildJsonObject {
            put("account", row.accountEmail)
            put("calendarId", row.calendarId)
            put("eventId", patchId)
            put("event", eventBody)
            put("rollback", json.parseToJsonElement(rollbackJson(row)))
            put("compoundKey", compoundKey)
        }
        outbox.enqueue(TYPE_UPDATE, payload.toString(), entityId = compoundKey)
    }

    suspend fun rsvp(compoundKey: String, status: String) {
        val row = db.calendar().byKey(compoundKey) ?: return
        // Optimistic: flip our own attendee's responseStatus in rawJson.
        runCatching {
            val e = json.parseToJsonElement(row.rawJson).jsonObject
            val attendees = (e["attendees"] as? JsonArray)?.map { a ->
                val o = a as? JsonObject ?: return@map a
                if ((o["self"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "true") {
                    buildJsonObject {
                        o.forEach { (k, v) -> if (k != "responseStatus") put(k, v) }
                        put("responseStatus", status)
                    }
                } else a
            }
            if (attendees != null) {
                val updated = buildJsonObject {
                    e.forEach { (k, v) -> if (k != "attendees") put(k, v) }
                    put("attendees", JsonArray(attendees))
                }
                db.calendar().upsertEvents(listOf(row.copy(rawJson = updated.toString())))
            }
        }
        // Hub maps accept/maybe/decline → accepted/tentative/declined.
        val hubStatus = when (status) {
            "accepted" -> "accept"; "tentative" -> "maybe"; "declined" -> "decline"; else -> status
        }
        val payload = buildJsonObject {
            put("account", row.accountEmail)
            put("calendarId", row.calendarId)
            put("eventId", row.eventId)
            put("status", hubStatus)
        }
        outbox.enqueue(TYPE_RSVP, payload.toString(), entityId = compoundKey)
    }

    /**
     * Set/clear an event reminder (queued PATCH). [minutes] null → use calendar
     * default; a number → single popup override. Optimistic local write.
     */
    suspend fun setReminder(compoundKey: String, minutes: Int?) {
        val row = db.calendar().byKey(compoundKey) ?: return
        if (row.eventId.startsWith("~")) return
        val reminders = reminderJson(minutes)
        runCatching {
            val e = json.parseToJsonElement(row.rawJson).jsonObject
            val updated = buildJsonObject {
                e.forEach { (k, v) -> if (k != "reminders") put(k, v) }
                put("reminders", reminders)
            }
            db.calendar().upsertEvents(listOf(row.copy(rawJson = updated.toString())))
        }
        val payload = buildJsonObject {
            put("account", row.accountEmail)
            put("calendarId", row.calendarId)
            put("eventId", row.eventId)
            put("event", buildJsonObject { put("reminders", reminders) })
        }
        outbox.enqueue(TYPE_REMINDER, payload.toString(), entityId = compoundKey)
    }

    /**
     * Set a working location for a day (Home / Office / Custom). Implemented as
     * delete-old + create-new (Google rejects PATCH on the workingLocation
     * instance). Uses the primary calendar (== accountEmail), SPA/hub parity.
     */
    suspend fun updateWorkingLocation(
        accountEmail: String,
        dayStartMs: Long,
        type: String,           // homeOffice | officeLocation | customLocation
        label: String? = null,
        oldEventId: String? = null,
    ) {
        val calendarId = accountEmail
        val dateStr = isoDate(dayStartMs)
        val summary = when (type) {
            "homeOffice" -> "Home"
            "officeLocation" -> label ?: "Office"
            else -> label ?: "Custom"
        }
        val wlProps = buildJsonObject {
            put("type", type)
            if (type == "officeLocation" && label != null) putJsonObject("officeLocation") { put("label", label) }
            if (type == "customLocation" && label != null) putJsonObject("customLocation") { put("label", label) }
        }
        val eventBody = buildJsonObject {
            put("summary", summary)
            putJsonObject("start") { put("date", dateStr) }
            putJsonObject("end") { put("date", dateStr) }
            put("eventType", "workingLocation")
            put("visibility", "public")
            put("transparency", "transparent")
            put("workingLocationProperties", wlProps)
        }

        // Optimistic: drop the old row (if any) and add a temp replacement.
        // If the old row is itself an unsynced temp create, cancel that queued
        // create rather than passing its ~id to the server (else two working-
        // location events would land). serverOldId is only sent for real ids.
        val serverOldId = oldEventId?.takeUnless { it.startsWith("~") }
        oldEventId?.let {
            val oldKey = "$accountEmail:$calendarId:$it"
            db.calendar().deleteByKey(oldKey)
            if (it.startsWith("~")) outbox.cancel(oldKey, TYPE_LOCATION)
        }
        val tempKey = "$accountEmail:$calendarId:~${System.currentTimeMillis()}"
        db.calendar().upsertEvents(
            listOf(
                CalEventRow(
                    compoundKey = tempKey, accountEmail = accountEmail, calendarId = calendarId,
                    eventId = tempKey.substringAfterLast(':'), summary = summary,
                    location = null, startTime = dayStartMs, endTime = dayStartMs + DAY_MS,
                    isAllDay = true, status = "confirmed", rawJson = eventBody.toString(),
                )
            )
        )
        val payload = buildJsonObject {
            put("tempKey", tempKey)
            put("account", accountEmail)
            put("calendarId", calendarId)
            serverOldId?.let { put("oldEventId", it) }
            put("event", eventBody)
        }
        outbox.enqueue(TYPE_LOCATION, payload.toString(), entityId = tempKey)
    }

    /**
     * Undo a just-issued delete (5s snackbar window): restore the row and drop
     * the queued server call. A ~temp row's delete cancelled its CREATE, so
     * undo re-enqueues the create from the row's rawJson.
     */
    suspend fun undoDelete(row: CalEventRow) {
        db.calendar().upsertEvents(listOf(row))
        if (row.eventId.startsWith("~")) {
            val payload = buildJsonObject {
                put("tempKey", row.compoundKey)
                put("account", row.accountEmail)
                put("calendarId", row.calendarId)
                put("event", json.parseToJsonElement(row.rawJson).jsonObject)
            }
            outbox.enqueue(TYPE_CREATE, payload.toString(), entityId = row.compoundKey, dedupeToken = outbox.mintToken())
        } else {
            outbox.cancel(row.compoundKey, TYPE_DELETE)
        }
    }

    // ---------------------------------------------------------------- //
    // JSON builders

    private fun buildEventJson(
        summary: String,
        startMs: Long,
        endMs: Long,
        isAllDay: Boolean,
        location: String?,
        description: String? = null,
        attendees: JsonArray? = null,
        addMeet: Boolean = false,
    ): JsonObject = buildJsonObject {
        put("summary", summary)
        location?.takeIf { it.isNotBlank() }?.let { put("location", it) }
        description?.takeIf { it.isNotBlank() }?.let { put("description", it) }
        if (isAllDay) {
            putJsonObject("start") { put("date", isoDate(startMs)) }
            putJsonObject("end") { put("date", isoDate(endMs)) }
        } else {
            putJsonObject("start") { put("dateTime", isoDateTime(startMs)) }
            putJsonObject("end") { put("dateTime", isoDateTime(endMs)) }
        }
        if (attendees != null && attendees.isNotEmpty()) put("attendees", attendees)
        if (addMeet) {
            putJsonObject("conferenceData") {
                putJsonObject("createRequest") {
                    put("requestId", "apk-${System.currentTimeMillis()}")
                    putJsonObject("conferenceSolutionKey") { put("type", "hangoutsMeet") }
                }
            }
        }
    }

    /** organizer (self, accepted) + each guest (needsAction). Guest strings are
     *  `email` or `Name <email>`; entries without '@' are dropped. */
    internal fun attendeeJson(organizerEmail: String, guests: List<String>): JsonArray? {
        val parsed = guests.mapNotNull { parseGuest(it) }.filter { it.second.contains("@") }
        if (parsed.isEmpty()) return null
        return buildJsonArray {
            add(buildJsonObject {
                put("email", organizerEmail); put("organizer", true)
                put("self", true); put("responseStatus", "accepted")
            })
            for ((name, email) in parsed) {
                if (email.equals(organizerEmail, ignoreCase = true)) continue
                add(buildJsonObject {
                    put("email", email)
                    if (name.isNotBlank()) put("displayName", name)
                    put("responseStatus", "needsAction")
                })
            }
        }
    }

    private fun reminderJson(minutes: Int?): JsonObject = buildJsonObject {
        if (minutes == null) {
            put("useDefault", true)
        } else {
            put("useDefault", false)
            putJsonArray("overrides") {
                add(buildJsonObject { put("method", "popup"); put("minutes", minutes) })
            }
        }
    }

    private fun rollbackJson(row: CalEventRow): String = buildJsonObject {
        put("compoundKey", row.compoundKey)
        put("accountEmail", row.accountEmail)
        put("calendarId", row.calendarId)
        put("eventId", row.eventId)
        put("summary", row.summary)
        row.location?.let { put("location", it) }
        put("startTime", row.startTime)
        put("endTime", row.endTime)
        put("isAllDay", row.isAllDay)
        put("status", row.status)
        put("rawJson", row.rawJson)
    }.toString()

    private fun rowFromRollback(o: JsonObject): CalEventRow = CalEventRow(
        compoundKey = o["compoundKey"]!!.jsonPrimitive.content,
        accountEmail = o["accountEmail"]!!.jsonPrimitive.content,
        calendarId = o["calendarId"]!!.jsonPrimitive.content,
        eventId = o["eventId"]!!.jsonPrimitive.content,
        summary = o["summary"]!!.jsonPrimitive.content,
        location = o["location"]?.jsonPrimitive?.content,
        startTime = o["startTime"]!!.jsonPrimitive.content.toLong(),
        endTime = o["endTime"]!!.jsonPrimitive.content.toLong(),
        isAllDay = o["isAllDay"]!!.jsonPrimitive.content.toBoolean(),
        status = o["status"]!!.jsonPrimitive.content,
        rawJson = o["rawJson"]!!.jsonPrimitive.content,
    )

    // ---------------------------------------------------------------- //
    // Outbox handlers

    fun registerOutboxHandlers() {
        outbox.register(TYPE_CREATE) { row, _ -> handleCreate(row) }
        outbox.register(TYPE_LOCATION) { row, _ -> handleLocation(row) }
        outbox.register(TYPE_UPDATE) { row, _ -> handleUpdate(row) }
        outbox.register("$TYPE_UPDATE:onFailed") { row, _ -> rollbackUpdate(row) }
        outbox.register(TYPE_DELETE) { row, _ -> handleDelete(row) }
        outbox.register(TYPE_REMINDER) { row, _ -> handleReminder(row) }
        outbox.register(TYPE_RSVP) { row, _ -> handleRsvp(row) }
    }

    private suspend fun handleCreate(row: io.amar.console.data.db.OutboxRow): Outbox.Result {
        val p = json.parseToJsonElement(row.payloadJson).jsonObject
        return try {
            val body = buildJsonObject {
                p["event"]!!.jsonObject.forEach { (k, v) -> put(k, v) }
                put("calendarId", p["calendarId"]!!.jsonPrimitive.content)
                put("account", p["account"]!!.jsonPrimitive.content)
                put("clientToken", row.dedupeToken)
            }
            val resp = hub.post("/cal/events", body.toString())
            val created = json.parseToJsonElement(resp).jsonObject
            val tempKey = p["tempKey"]!!.jsonPrimitive.content
            if (created["id"]?.jsonPrimitive?.content != null) {
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

    private suspend fun handleLocation(row: io.amar.console.data.db.OutboxRow): Outbox.Result {
        val p = json.parseToJsonElement(row.payloadJson).jsonObject
        return try {
            val account = p["account"]!!.jsonPrimitive.content
            val calendarId = p["calendarId"]!!.jsonPrimitive.content
            // Delete old event first (tolerate already-gone).
            p["oldEventId"]?.jsonPrimitive?.content?.let { oldId ->
                runCatching { hub.delete("/cal/events/${enc(oldId)}?account=${enc(account)}&calendarId=${enc(calendarId)}") }
            }
            val body = buildJsonObject {
                p["event"]!!.jsonObject.forEach { (k, v) -> put(k, v) }
                put("calendarId", calendarId); put("account", account)
                put("clientToken", row.dedupeToken)
            }
            val resp = hub.post("/cal/events", body.toString())
            val created = json.parseToJsonElement(resp).jsonObject
            val tempKey = p["tempKey"]!!.jsonPrimitive.content
            if (created["id"]?.jsonPrimitive?.content != null) {
                db.withTransaction {
                    db.calendar().deleteByKey(tempKey)
                    eventRowFromGoogle(created, account, calendarId)?.let { db.calendar().upsertEvents(listOf(it)) }
                }
            }
            Outbox.Result.Done
        } catch (e: HubClient.HttpException) {
            if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
        } catch (e: Exception) {
            Outbox.Result.Retry(e.message ?: "network")
        }
    }

    private suspend fun handleUpdate(row: io.amar.console.data.db.OutboxRow): Outbox.Result {
        val p = json.parseToJsonElement(row.payloadJson).jsonObject
        return try {
            val body = buildJsonObject {
                p["event"]!!.jsonObject.forEach { (k, v) -> put(k, v) }
                put("calendarId", p["calendarId"]!!.jsonPrimitive.content)
                put("account", p["account"]!!.jsonPrimitive.content)
            }
            val resp = hub.patch("/cal/events/${enc(p["eventId"]!!.jsonPrimitive.content)}", body.toString())
            // Write the authoritative server response back over the optimistic row.
            val ck = p["compoundKey"]?.jsonPrimitive?.content
            val updated = runCatching { json.parseToJsonElement(resp).jsonObject }.getOrNull()
            if (ck != null && updated != null) {
                val existing = db.calendar().byKey(ck)
                if (existing != null) {
                    eventRowFromGoogle(updated, existing.accountEmail, existing.calendarId)
                        ?.let { db.calendar().upsertEvents(listOf(it.copy(compoundKey = existing.compoundKey))) }
                }
            }
            Outbox.Result.Done
        } catch (e: HubClient.HttpException) {
            if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
        } catch (e: Exception) {
            Outbox.Result.Retry(e.message ?: "network")
        }
    }

    /** Terminal-failure rollback for calUpdate: restore the pre-edit row. */
    private suspend fun rollbackUpdate(row: io.amar.console.data.db.OutboxRow): Outbox.Result {
        runCatching {
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            (p["rollback"] as? JsonObject)?.let { db.calendar().upsertEvents(listOf(rowFromRollback(it))) }
        }
        return Outbox.Result.Done
    }

    private suspend fun handleDelete(row: io.amar.console.data.db.OutboxRow): Outbox.Result {
        val p = json.parseToJsonElement(row.payloadJson).jsonObject
        return try {
            val eventId = p["eventId"]!!.jsonPrimitive.content
            val q = "?account=${enc(p["account"]!!.jsonPrimitive.content)}&calendarId=${enc(p["calendarId"]!!.jsonPrimitive.content)}"
            hub.delete("/cal/events/${enc(eventId)}$q")
            Outbox.Result.Done
        } catch (e: HubClient.HttpException) {
            if (e.code == 404 || e.code == 410) Outbox.Result.Done
            else if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}")
            else Outbox.Result.Retry("HTTP ${e.code}")
        } catch (e: Exception) {
            Outbox.Result.Retry(e.message ?: "network")
        }
    }

    private suspend fun handleReminder(row: io.amar.console.data.db.OutboxRow): Outbox.Result {
        val p = json.parseToJsonElement(row.payloadJson).jsonObject
        return try {
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

    private suspend fun handleRsvp(row: io.amar.console.data.db.OutboxRow): Outbox.Result {
        val p = json.parseToJsonElement(row.payloadJson).jsonObject
        return try {
            val body = buildJsonObject {
                put("status", p["status"]!!.jsonPrimitive.content)
                put("calendarId", p["calendarId"]!!.jsonPrimitive.content)
                put("account", p["account"]!!.jsonPrimitive.content)
            }
            val resp = hub.post("/cal/events/${enc(p["eventId"]!!.jsonPrimitive.content)}/rsvp", body.toString())
            // Persist server-confirmed attendee list back over the optimistic row.
            val ck = "${p["account"]!!.jsonPrimitive.content}:${p["calendarId"]!!.jsonPrimitive.content}:${p["eventId"]!!.jsonPrimitive.content}"
            runCatching {
                val updated = json.parseToJsonElement(resp).jsonObject
                val existing = db.calendar().byKey(ck)
                if (existing != null && updated["attendees"] != null) {
                    val e = json.parseToJsonElement(existing.rawJson).jsonObject
                    val merged = buildJsonObject {
                        e.forEach { (k, v) -> if (k != "attendees") put(k, v) }
                        put("attendees", updated["attendees"]!!)
                    }
                    db.calendar().upsertEvents(listOf(existing.copy(rawJson = merged.toString())))
                }
            }
            Outbox.Result.Done
        } catch (e: HubClient.HttpException) {
            if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
        } catch (e: Exception) {
            Outbox.Result.Retry(e.message ?: "network")
        }
    }

    // ---------------------------------------------------------------- //
    // Sync

    fun wireLiveDeltas(scope: CoroutineScope) {
        appScope = scope
        syncBus.on("cal", "delta") { _ ->
            scope.launch { runCatching { reconcile() } }
        }
        // Flights mirror lives on the same bus.
        flights.wireLiveDeltas()
        scope.launch { runCatching { flights.init() } }
        scope.launch { runCatching { hydratePrefs() } }
    }

    /** Boot/reconnect refresh of the overlay sources (Meetup + OutdoorLads). */
    suspend fun refreshOverlays() {
        runCatching {
            val resp = hub.get("/meetup/events")
            val events = (json.parseToJsonElement(resp).jsonObject["events"] as? JsonArray)
                ?.mapNotNull { (it as? JsonObject)?.let { o -> meetupEventRow(o) } } ?: emptyList()
            setOverlay(MEETUP_ID, overlayCalendarRow(MEETUP_ID, "Meetup", MEETUP_COLOR), events)
        }
        runCatching {
            val resp = hub.get("/outdoorlads/events")
            val events = (json.parseToJsonElement(resp).jsonObject["events"] as? JsonArray)
                ?.mapNotNull { (it as? JsonObject)?.let { o -> outdoorLadsEventRow(o) } } ?: emptyList()
            setOverlay(OUTDOORLADS_ID, overlayCalendarRow(OUTDOORLADS_ID, "OutdoorLads", OUTDOORLADS_COLOR), events)
        }
    }

    suspend fun reconcile() {
        // 1. Calendar list.
        val calsResp = runCatching { hub.get("/cal/calendars") }.getOrNull()
        if (calsResp != null) {
            val cals = (json.parseToJsonElement(calsResp) as? JsonArray)
                ?.mapNotNull { it as? JsonObject } ?: emptyList()
            val defaults = HashMap<String, List<Int>>()
            val calRows = cals.mapNotNull { c ->
                val id = c["id"]?.jsonPrimitive?.content ?: return@mapNotNull null
                val account = c["accountEmail"]?.jsonPrimitive?.content ?: ""
                (c["defaultReminders"] as? JsonArray)?.let { dr ->
                    defaults[id] = dr.mapNotNull { (it as? JsonObject)?.get("minutes")?.jsonPrimitive?.intOrNull }
                }
                CalendarRow(
                    id = "$account:$id", accountEmail = account, calendarId = id,
                    name = c["summary"]?.jsonPrimitive?.content ?: id,
                    color = c["backgroundColor"]?.jsonPrimitive?.content,
                    accessRole = c["accessRole"]?.jsonPrimitive?.content ?: "reader",
                    visible = true,
                )
            }
            if (calRows.isNotEmpty()) db.calendar().upsertCalendars(calRows)
            calendarDefaults.value = defaults
        }

        // 2. Events for the offline window — hub fans out across calendars.
        val now = System.currentTimeMillis()
        val timeMin = isoDateTime(now - WINDOW_PAST_MS)
        val timeMax = isoDateTime(now + WINDOW_FUTURE_MS)
        val eventsResp = runCatching {
            hub.get("/cal/events?timeMin=${enc(timeMin)}&timeMax=${enc(timeMax)}&singleEvents=true")
        }.getOrNull() ?: return
        val parsed = json.parseToJsonElement(eventsResp)
        // Route returns {items:[...]} when no calendarId — handle both shapes.
        val eventsArr = (parsed as? JsonObject)?.get("items") as? JsonArray
            ?: parsed as? JsonArray ?: return
        val events = eventsArr.mapNotNull { it as? JsonObject }

        db.withTransaction {
            val rows = events.mapNotNull { e ->
                if (e["status"]?.jsonPrimitive?.content == "cancelled") return@mapNotNull null
                val account = e["accountEmail"]?.jsonPrimitive?.content ?: ""
                val calId = e["calendarId"]?.jsonPrimitive?.content ?: ""
                eventRowFromGoogle(e, account, calId)
            }
            val serverKeys = rows.map { it.compoundKey }.toSet()
            // Protect pending-queue temp/optimistic writes from stale-cleanup.
            val pendingKeys = db.outbox().pending()
                .mapNotNull { runCatching { json.parseToJsonElement(it.payloadJson).jsonObject }.getOrNull() }
                .mapNotNull { it["tempKey"]?.jsonPrimitive?.content ?: it["compoundKey"]?.jsonPrimitive?.content }
                .toSet()
            val stale = db.calendar().keysInRange(now - WINDOW_PAST_MS, now + WINDOW_FUTURE_MS)
                .filter { it !in serverKeys && !it.contains(":~") && it !in pendingKeys }
            if (stale.isNotEmpty()) db.calendar().deleteByKeys(stale)
            if (rows.isNotEmpty()) db.calendar().upsertEvents(rows)
        }

        getAccounts()
        refreshOverlays()
        hydratePrefs()
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

/** Parse `Name <email>` or bare `email` → (name, email). */
internal fun parseGuest(raw: String): Pair<String, String>? {
    val s = raw.trim()
    if (s.isEmpty()) return null
    val m = Regex("^(.*?)<([^>]+)>$").find(s)
    return if (m != null) {
        m.groupValues[1].trim() to m.groupValues[2].trim()
    } else {
        "" to s
    }
}
