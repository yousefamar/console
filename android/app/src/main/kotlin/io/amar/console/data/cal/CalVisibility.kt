package io.amar.console.data.cal

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * "What Google Calendar shows Yousef" — the phone twin of the hub's
 * server/src/cal/visibility.ts and the SPA store's calendar-list gate.
 *
 * A CalendarListEntry is shown only when `selected` is literally true: Google
 * OMITS the field when it is false ("Optional. The default is False."), so a
 * `selected != false` test lets every unchecked calendar through — that is how
 * a colleague's whole calendar (shared with admin access, unchecked in Google)
 * leaked onto the phone.
 */
fun isSelectedCalendar(entry: JsonObject): Boolean {
    fun flag(key: String) = (entry[key] as? JsonPrimitive)?.booleanOrNull
    return flag("selected") == true && flag("hidden") != true && flag("deleted") != true
}

private val ACCESS_RANK = mapOf("owner" to 3, "writer" to 2, "reader" to 1, "freeBusyReader" to 0)

/** The most capable of several accounts' roles on one calendar (SPA `ACCESS_RANK`). */
fun bestAccessRole(roles: Collection<String>): String? =
    roles.maxByOrNull { ACCESS_RANK[it] ?: -1 }

/** Console's own per-device-synced allow-list (`calendar.visibleIds`, bare
 *  calendar ids). null = not loaded yet → everything Google shows. */
fun isCalendarShown(visibleIds: Set<String>?, calendarId: String): Boolean =
    visibleIds?.contains(calendarId) ?: true

/**
 * Title for an event row. Google strips every detail (summary, attendees,
 * description) from events the token may not read — a private event on a
 * "see all event details" share, or anything on a free/busy-only share — and
 * its own UI labels the block "Busy". An untitled event on a calendar we can
 * write to is genuinely untitled.
 */
fun eventTitle(summary: String?, accessRole: String?): String {
    if (!summary.isNullOrBlank()) return summary
    return if (accessRole == "reader" || accessRole == "freeBusyReader") "Busy" else "(no title)"
}
