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
 * Read-only calendar overlay sources (Meetup, OutdoorLads) — ports of
 * src/meetup/calendar-overlay.ts + src/outdoorlads/calendar-overlay.ts.
 *
 * Both surface time-based events that don't belong to a Google account, as
 * synthetic "reader" calendars: never persisted to Room, never editable,
 * merged into the grid in-memory. Pure adapters here; the repository owns the
 * hub fetch + the in-memory StateFlow that feeds the combined event flow.
 */

const val MEETUP_ID = "meetup"
const val MEETUP_COLOR = "#ff4a79"      // Meetup brand pink
const val OUTDOORLADS_ID = "outdoorlads"
const val OUTDOORLADS_COLOR = "#f5821f" // OutdoorLads brand orange

private const val HOUR_MS_OVL = 60L * 60 * 1000
private const val MEETUP_BLOCK_MS = HOUR_MS_OVL         // no end time → 1h block
private const val OUTDOORLADS_BLOCK_MS = 2 * HOUR_MS_OVL // feed has no end → 2h block

/** OutdoorLads: only surface camping event types (substring, case-insensitive). */
private val OUTDOORLADS_INCLUDE = listOf("camp")

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
// OutdoorLads

fun outdoorLadsIncluded(eventType: String): Boolean {
    val t = eventType.lowercase()
    return OUTDOORLADS_INCLUDE.any { t.contains(it) }
}

/** Pure: one OutdoorLads event JSON node → a synthetic timed CalEventRow (or null,
 *  incl. when it isn't a camping event). */
fun outdoorLadsEventRow(e: JsonObject): CalEventRow? {
    val id = e["id"]?.jsonPrimitive?.content ?: return null
    val eventType = e["eventType"]?.jsonPrimitive?.content ?: ""
    if (!outdoorLadsIncluded(eventType)) return null
    val startIso = e["start"]?.jsonPrimitive?.content ?: return null
    val startMs = parseIso(startIso) ?: return null
    val endMs = startMs + OUTDOORLADS_BLOCK_MS
    val title = e["title"]?.jsonPrimitive?.content ?: "(untitled)"
    val location = e["location"]?.jsonPrimitive?.content
    val link = e["link"]?.jsonPrimitive?.content ?: ""
    val text = e["description"]?.jsonPrimitive?.content ?: ""
    val description = listOf(eventType, text, link).filter { it.isNotBlank() }.joinToString("\n")

    return synthEventRow(OUTDOORLADS_ID, "outdoorlads:$id", title, location, startMs, endMs, description, link)
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
