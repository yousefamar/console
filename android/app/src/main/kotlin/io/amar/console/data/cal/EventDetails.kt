package io.amar.console.data.cal

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Pure parse of the extra event fields the detail sheet + grid need out of
 * CalEventRow.rawJson (the full Google event). Mirrors what the SPA's
 * CalendarEventPopover / CalendarGrid read: attendees + RSVP status,
 * organizer/self markers, description, hangoutLink, htmlLink, reminders,
 * working-location, eventType (task detection).
 */
data class Attendee(
    val email: String,
    val displayName: String?,
    val responseStatus: String,   // accepted | tentative | declined | needsAction
    val organizer: Boolean,
    val self: Boolean,
)

/** One reminder override (method popup/email + minutes-before-start). */
data class ReminderOverride(val method: String, val minutes: Int)

data class Reminders(
    val useDefault: Boolean,
    val overrides: List<ReminderOverride>,
)

/** workingLocationProperties on a Google event (eventType == workingLocation). */
data class WorkingLocation(
    val type: String,             // homeOffice | officeLocation | customLocation
    val label: String?,           // office/custom label
)

data class EventDetails(
    val attendees: List<Attendee>,
    val description: String?,
    val hangoutLink: String?,
    val htmlLink: String?,
    val reminders: Reminders?,
    val eventType: String?,       // default | workingLocation | ...
    val workingLocation: WorkingLocation?,
    val organizerSelf: Boolean,
    val recurringEventId: String?,
) {
    val selfAttendee: Attendee? get() = attendees.firstOrNull { it.self }
    val isTask: Boolean get() = description?.contains("tasks.google.com/task/") == true
    val isRecurring: Boolean get() = recurringEventId != null
}

private val lenientJson = Json { ignoreUnknownKeys = true }

fun parseEventDetails(rawJson: String): EventDetails {
    val e = runCatching { lenientJson.parseToJsonElement(rawJson).jsonObject }.getOrNull()
        ?: return EventDetails(emptyList(), null, null, null, null, null, null, false, null)
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

    val reminders = (e["reminders"] as? JsonObject)?.let { r ->
        val overrides = (r["overrides"] as? JsonArray)?.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            ReminderOverride(
                method = o["method"]?.jsonPrimitive?.content ?: "popup",
                minutes = o["minutes"]?.jsonPrimitive?.intOrNull ?: return@mapNotNull null,
            )
        } ?: emptyList()
        Reminders(useDefault = r["useDefault"]?.jsonPrimitive?.booleanOrNull ?: true, overrides = overrides)
    }

    val workingLocation = (e["workingLocationProperties"] as? JsonObject)?.let { w ->
        val type = w["type"]?.jsonPrimitive?.content ?: "homeOffice"
        val label = when (type) {
            "officeLocation" -> (w["officeLocation"] as? JsonObject)?.get("label")?.jsonPrimitive?.content
            "customLocation" -> (w["customLocation"] as? JsonObject)?.get("label")?.jsonPrimitive?.content
            else -> null
        }
        WorkingLocation(type, label)
    }

    return EventDetails(
        attendees = attendees,
        description = e["description"]?.jsonPrimitive?.content,
        hangoutLink = hangout,
        htmlLink = e["htmlLink"]?.jsonPrimitive?.content,
        reminders = reminders,
        eventType = e["eventType"]?.jsonPrimitive?.content,
        workingLocation = workingLocation,
        organizerSelf = (e["organizer"] as? JsonObject)?.get("self")?.jsonPrimitive?.booleanOrNull ?: false,
        recurringEventId = e["recurringEventId"]?.jsonPrimitive?.content,
    )
}

/**
 * Resolve the effective reminder minutes for an event, folding useDefault into
 * the calendar's defaultReminders (SPA ReminderPicker parity). Returns the
 * active minutes (first override) or null when there is no reminder.
 */
fun effectiveReminderMinutes(reminders: Reminders?, calendarDefaults: List<Int>): Int? {
    val effective = if (reminders == null || reminders.useDefault) {
        calendarDefaults
    } else {
        reminders.overrides.map { it.minutes }
    }
    return effective.firstOrNull()
}

/** True when an event carries any reminder (explicit override or useDefault
 *  with calendar defaults present) — drives the grid bell icon. */
fun hasReminder(reminders: Reminders?, calendarDefaults: List<Int>): Boolean {
    if (reminders == null) return calendarDefaults.isNotEmpty()
    return if (reminders.useDefault) calendarDefaults.isNotEmpty() else reminders.overrides.isNotEmpty()
}

/**
 * "accepted" for grid styling: no attendees, OR organizer.self, OR the self
 * attendee responded 'accepted'. Everything else → unaccepted (dashed).
 */
fun isAccepted(details: EventDetails): Boolean {
    if (details.attendees.isEmpty()) return true
    if (details.organizerSelf) return true
    val self = details.selfAttendee ?: return true
    return self.responseStatus == "accepted"
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

/** Extract raw http(s) URLs from text so a description can render tappable
 *  links (the SPA auto-linkifies; on Android we surface them as chips).
 *  Trailing sentence punctuation is trimmed so "…/y." doesn't capture the dot. */
fun extractUrls(s: String): List<String> =
    Regex("https?://[^\\s<>\"')]+").findAll(s)
        .map { it.value.trimEnd('.', ',', ';', ':', '!', '?', ')') }
        .distinct().toList()
