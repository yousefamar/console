package io.amar.console.data.cal

import io.amar.console.data.db.CalEventRow
import io.amar.console.data.db.CalendarRow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.time.OffsetDateTime

/**
 * Read-only calendar overlay sources (Meetup, Eventbrite) — ports of
 * src/meetup/calendar-overlay.ts + src/eventbrite/calendar-overlay.ts.
 *
 * Both surface time-based events that don't belong to a Google account, as
 * synthetic "reader" calendars: never persisted to Room, never editable,
 * merged into the grid in-memory. Pure adapters here; the repository owns the
 * hub fetch + the in-memory StateFlow that feeds the combined event flow.
 */

const val MEETUP_ID = "meetup"
const val MEETUP_COLOR = "#ff4a79"      // Meetup brand pink
const val EVENTBRITE_ID = "eventbrite"
const val EVENTBRITE_COLOR = "#f05537"  // Eventbrite brand orange-red

/** Every synthetic overlay calendar id — the sidebar groups these under "Overlays". */
val OVERLAY_IDS: Set<String> = setOf(MEETUP_ID, EVENTBRITE_ID)

fun isOverlayCalendar(cal: CalendarRow): Boolean =
    cal.accessRole == "reader" && cal.calendarId in OVERLAY_IDS

private const val HOUR_MS_OVL = 60L * 60 * 1000
private const val MEETUP_BLOCK_MS = HOUR_MS_OVL         // no end time → 1h block

/** The synthetic CalendarRow for an overlay source (drives colour + sidebar toggle). */
fun overlayCalendarRow(id: String, name: String, color: String): CalendarRow =
    CalendarRow(
        id = "$id:$id", accountEmail = id, calendarId = id,
        name = name, color = color, accessRole = "reader", visible = true,
    )

private fun parseIso(iso: String): Long? =
    runCatching { OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrNull()

// -------------------------------------------------------------------------- //
// Meetup

/** Pure: one Meetup event JSON node → a synthetic timed CalEventRow (or null). */
fun meetupEventRow(e: JsonObject): CalEventRow? {
    val id = e["id"]?.jsonPrimitive?.content ?: return null
    val startIso = e["dateTime"]?.jsonPrimitive?.content ?: return null
    val startMs = parseIso(startIso) ?: return null
    val endIso = e["endTime"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() }
    val endMs = endIso?.let { parseIso(it) } ?: (startMs + MEETUP_BLOCK_MS)
    val title = e["title"]?.jsonPrimitive?.content ?: "(untitled)"
    val isOnline = (e["isOnline"]?.jsonPrimitive?.booleanOrNull ?: false) ||
        e["eventType"]?.jsonPrimitive?.content == "ONLINE"
    val location = if (isOnline) "Online"
    else listOfNotNull(
        e["venueName"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() },
        e["venueCity"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() },
    ).joinToString(", ")
    val going = e["going"]?.jsonPrimitive?.intOrNull ?: 0
    val eventUrl = e["eventUrl"]?.jsonPrimitive?.content ?: ""
    val group = e["groupName"]?.jsonPrimitive?.content ?: ""
    val description = listOf(group, if (going > 0) "$going going" else "", eventUrl)
        .filter { it.isNotBlank() }.joinToString("\n")

    return synthEventRow(MEETUP_ID, "meetup:$id", title, location, startMs, endMs, description, eventUrl)
}

// -------------------------------------------------------------------------- //
// Eventbrite

/** Pure: one Eventbrite event JSON node (hub `GET /eventbrite/events`) → a synthetic
 *  timed CalEventRow (or null). Real end times; a missing end falls back to the start. */
fun eventbriteEventRow(e: JsonObject): CalEventRow? {
    val id = e["id"]?.jsonPrimitive?.content ?: return null
    val startIso = e["start"]?.jsonPrimitive?.content ?: return null
    val startMs = parseIso(startIso) ?: return null
    val endMs = e["end"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() }?.let { parseIso(it) } ?: startMs
    val title = e["title"]?.jsonPrimitive?.content ?: "(untitled)"
    val online = e["online"]?.jsonPrimitive?.booleanOrNull ?: false
    val location = if (online) "Online"
    else listOfNotNull(
        e["venueName"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() },
        e["address"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() },
    ).joinToString(", ")
    val url = e["url"]?.jsonPrimitive?.content ?: ""
    val description = listOf(
        e["organizerName"]?.jsonPrimitive?.content ?: "",
        e["summary"]?.jsonPrimitive?.content ?: "",
        url,
    ).filter { it.isNotBlank() }.joinToString("\n")

    return synthEventRow(EVENTBRITE_ID, "eventbrite:$id", title, location, startMs, endMs, description, url)
}

// -------------------------------------------------------------------------- //

private fun synthEventRow(
    source: String,
    eventId: String,
    title: String,
    location: String?,
    startMs: Long,
    endMs: Long,
    description: String,
    htmlLink: String,
): CalEventRow {
    val raw = buildJsonObject {
        put("id", eventId)
        put("summary", title)
        put("description", description)
        if (htmlLink.isNotBlank()) put("htmlLink", htmlLink)
    }.toString()
    return CalEventRow(
        compoundKey = "$source:$source:$eventId",
        accountEmail = source,
        calendarId = source,
        eventId = eventId,
        summary = title,
        location = location?.takeIf { it.isNotBlank() },
        startTime = startMs,
        endTime = endMs,
        isAllDay = false,
        status = "confirmed",
        rawJson = raw,
    )
}
