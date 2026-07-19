package io.amar.console.data.cal

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Pure parse of the extra event fields the detail sheet needs out of
 * CalEventRow.rawJson (the full Google event). Mirrors what the SPA's
 * CalendarEventPopover reads: attendees + RSVP status, organizer/self
 * markers, description (HTML-stripped at render), hangoutLink, htmlLink.
 */
data class Attendee(
    val email: String,
    val displayName: String?,
    val responseStatus: String,   // accepted | tentative | declined | needsAction
    val organizer: Boolean,
    val self: Boolean,
)

data class EventDetails(
    val attendees: List<Attendee>,
    val description: String?,
    val hangoutLink: String?,
    val htmlLink: String?,
) {
    val selfAttendee: Attendee? get() = attendees.firstOrNull { it.self }
}

private val lenientJson = Json { ignoreUnknownKeys = true }

fun parseEventDetails(rawJson: String): EventDetails {
    val e = runCatching { lenientJson.parseToJsonElement(rawJson).jsonObject }.getOrNull()
        ?: return EventDetails(emptyList(), null, null, null)
    val attendees = (e["attendees"] as? JsonArray)?.mapNotNull { el ->
        val a = el as? JsonObject ?: return@mapNotNull null
        Attendee(
            email = a["email"]?.jsonPrimitive?.content ?: return@mapNotNull null,
            displayName = a["displayName"]?.jsonPrimitive?.content,
            responseStatus = a["responseStatus"]?.jsonPrimitive?.content ?: "needsAction",
            organizer = a["organizer"]?.jsonPrimitive?.booleanOrNull ?: false,
            self = a["self"]?.jsonPrimitive?.booleanOrNull ?: false,
        )
    } ?: emptyList()
    // Prefer hangoutLink; fall back to conferenceData video entry point (SPA parity).
    val hangout = e["hangoutLink"]?.jsonPrimitive?.content
        ?: (e["conferenceData"] as? JsonObject)?.get("entryPoints")?.let { eps ->
            (eps as? JsonArray)?.firstOrNull {
                (it as? JsonObject)?.get("entryPointType")?.jsonPrimitive?.content == "video"
            }?.jsonObject?.get("uri")?.jsonPrimitive?.content
        }
    return EventDetails(
        attendees = attendees,
        description = e["description"]?.jsonPrimitive?.content,
        hangoutLink = hangout,
        htmlLink = e["htmlLink"]?.jsonPrimitive?.content,
    )
}

/** Cheap HTML → text for event descriptions (Google often embeds markup). */
fun stripHtml(s: String): String = s
    .replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
    .replace(Regex("</p>", RegexOption.IGNORE_CASE), "\n")
    .replace(Regex("<[^>]+>"), "")
    .replace("&nbsp;", " ")
    .replace("&amp;", "&")
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&quot;", "\"")
    .replace("&#39;", "'")
    .replace(Regex("\n{3,}"), "\n\n")
    .trim()
