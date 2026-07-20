package io.amar.console.data.mail

import kotlinx.serialization.Serializable

/**
 * Parsed calendar invite from a message's `text/calendar` MIME part.
 * Serialized to the `meta` KV table (key `mail:cal:<messageId>`) since the
 * mail_messages schema has no column for it — the UI reads it back to render
 * a [CalendarEventCard] above the body (parity with the SPA's DbMessage.calendarEvent).
 */
@Serializable
data class CalendarInvite(
    val summary: String,
    val location: String? = null,
    val description: String? = null,
    val start: Long,      // epoch ms
    val end: Long,        // epoch ms
    val organizer: Attendee? = null,
    val attendees: List<Attendee> = emptyList(),
    val status: String? = null,   // CONFIRMED / CANCELLED / TENTATIVE
    val method: String? = null,   // REQUEST / CANCEL / REPLY
) {
    @Serializable
    data class Attendee(val name: String? = null, val email: String, val status: String = "needs-action")
}

/**
 * Pure ICS (RFC 5545) → [CalendarInvite]. Direct port of `parseIcs` in
 * src/utils/email.ts: unfolds continuation lines, reads the first VEVENT,
 * decodes ATTENDEE/ORGANIZER params (CN, PARTSTAT), and handles UTC / local /
 * all-day DTSTART/DTEND forms. Returns null when there's no DTSTART.
 */
object IcsParser {

    fun parse(ics: String): CalendarInvite? {
        // Unfold: a line beginning with space/tab continues the previous one.
        val unfolded = ics.replace(Regex("\\r?\\n[ \\t]"), "")
        val lines = unfolded.split(Regex("\\r?\\n"))

        var inEvent = false
        var method: String? = null
        val props = mutableMapOf<String, String>()
        val attendees = mutableListOf<CalendarInvite.Attendee>()
        var organizer: CalendarInvite.Attendee? = null

        for (line in lines) {
            val colon = line.indexOf(':')
            if (colon < 0) continue
            val key = line.substring(0, colon)
            val value = line.substring(colon + 1)

            if (key == "METHOD") method = value
            if (key == "BEGIN" && value == "VEVENT") { inEvent = true; continue }
            if (key == "END" && value == "VEVENT") break
            if (!inEvent) continue

            val baseName = key.split(';')[0]
            val params = parseParams(key)

            when (baseName) {
                "ATTENDEE" -> attendees.add(
                    CalendarInvite.Attendee(
                        name = params["CN"],
                        email = value.replace(Regex("(?i)^mailto:"), ""),
                        status = (params["PARTSTAT"] ?: "NEEDS-ACTION").lowercase(),
                    )
                )
                "ORGANIZER" -> organizer = CalendarInvite.Attendee(
                    name = params["CN"],
                    email = value.replace(Regex("(?i)^mailto:"), ""),
                )
                else -> props[baseName] = value
            }
        }

        val dtStart = props["DTSTART"] ?: return null
        return CalendarInvite(
            summary = props["SUMMARY"] ?: "(no title)",
            location = props["LOCATION"],
            description = props["DESCRIPTION"]?.replace("\\n", "\n")?.replace("\\,", ","),
            start = parseDate(dtStart),
            end = parseDate(props["DTEND"] ?: dtStart),
            organizer = organizer,
            attendees = attendees,
            status = props["STATUS"],
            method = method,
        )
    }

    private fun parseParams(key: String): Map<String, String> {
        val out = mutableMapOf<String, String>()
        val parts = key.split(';')
        for (i in 1 until parts.size) {
            val eq = parts[i].indexOf('=')
            if (eq > 0) {
                out[parts[i].substring(0, eq)] =
                    parts[i].substring(eq + 1).trim('"')
            }
        }
        return out
    }

    /** 20240115T090000Z (UTC) | 20240115T090000 (local) | TZID=..:.. | 20240115 (all-day). */
    private fun parseDate(value: String): Long {
        val dateStr = if (value.contains(':')) value.substringAfterLast(':') else value
        val dt = Regex("^(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})(Z)?$").find(dateStr)
        if (dt != null) {
            val (y, mo, d, h, mi, s, z) = dt.destructured
            val cal = if (z == "Z") java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"))
            else java.util.Calendar.getInstance()
            cal.clear()
            cal.set(y.toInt(), mo.toInt() - 1, d.toInt(), h.toInt(), mi.toInt(), s.toInt())
            return cal.timeInMillis
        }
        val day = Regex("^(\\d{4})(\\d{2})(\\d{2})$").find(dateStr)
        if (day != null) {
            val (y, mo, d) = day.destructured
            val cal = java.util.Calendar.getInstance()
            cal.clear()
            cal.set(y.toInt(), mo.toInt() - 1, d.toInt(), 0, 0, 0)
            return cal.timeInMillis
        }
        return System.currentTimeMillis()
    }
}
