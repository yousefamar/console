package io.amar.console.ui.mail

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.border
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.People
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.mail.CalendarInvite
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Calendar-invite card rendered above an expanded message that carries a
 * text/calendar part. Port of src/components/CalendarEventCard.tsx: coloured
 * bar (red when cancelled), strikethrough title + "Cancelled" label, adaptive
 * all-day/same-day/multi-day date line, location row, and attendee list with
 * RSVP status dots.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CalendarInviteCard(event: CalendarInvite) {
    val cancelled = event.status == "CANCELLED" || event.method == "CANCEL"
    val accent = MaterialTheme.colorScheme.primary
    val destructive = MaterialTheme.colorScheme.error
    val barColor = if (cancelled) destructive else accent

    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(4.dp))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(4.dp)),
    ) {
        Box(Modifier.fillMaxWidth().height(3.dp).background(barColor))
        Column(
            Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            // Title
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
                Icon(
                    Icons.Filled.CalendarMonth, null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(14.dp).padding(top = 1.dp),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        event.summary,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        textDecoration = if (cancelled) TextDecoration.LineThrough else null,
                        color = if (cancelled) MaterialTheme.colorScheme.onSurfaceVariant
                        else MaterialTheme.colorScheme.onSurface,
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                    if (cancelled) {
                        Text(
                            "Cancelled",
                            style = MaterialTheme.typography.labelSmall,
                            color = destructive, fontWeight = FontWeight.Medium,
                            modifier = Modifier.padding(start = 6.dp),
                        )
                    }
                }
            }
            // Date/time
            Text(
                formatInviteRange(event.start, event.end),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 20.dp),
            )
            // Location
            event.location?.takeIf { it.isNotBlank() }?.let { loc ->
                Row(
                    Modifier.padding(start = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.LocationOn, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(11.dp))
                    Text(loc, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            // Attendees
            if (event.attendees.isNotEmpty()) {
                Row(
                    Modifier.padding(start = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Icon(Icons.Filled.People, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(11.dp).padding(top = 2.dp))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (a in event.attendees) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                                Box(Modifier.size(6.dp).clip(CircleShape).background(statusColor(a.status)))
                                Text(
                                    a.name?.ifBlank { null } ?: a.email,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun statusColor(status: String): Color = when (status) {
    "accepted" -> Color(0xFF22C55E)
    "declined" -> MaterialTheme.colorScheme.error
    "tentative" -> Color(0xFFF59E0B)
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** All-day (00:00 start+end) → day(s); same-day → "Ddd Mon N, HH:MM – HH:MM"; else both. */
private fun formatInviteRange(start: Long, end: Long): String {
    val s = java.util.Calendar.getInstance().apply { timeInMillis = start }
    val e = java.util.Calendar.getInstance().apply { timeInMillis = end }
    val allDay = s.get(java.util.Calendar.HOUR_OF_DAY) == 0 && s.get(java.util.Calendar.MINUTE) == 0 &&
        e.get(java.util.Calendar.HOUR_OF_DAY) == 0 && e.get(java.util.Calendar.MINUTE) == 0
    val sameDay = fmtDay(start) == fmtDay(end)
    return when {
        allDay -> if (sameDay) fmtDay(start) else "${fmtDay(start)} – ${fmtDay(end)}"
        sameDay -> "${fmtDay(start)}, ${fmtTime(start)} – ${fmtTime(end)}"
        else -> "${fmtDay(start)} ${fmtTime(start)} – ${fmtDay(end)} ${fmtTime(end)}"
    }
}

private fun fmtDay(ts: Long): String = SimpleDateFormat("EEE, MMM d", Locale.UK).format(Date(ts))
private fun fmtTime(ts: Long): String = SimpleDateFormat("HH:mm", Locale.UK).format(Date(ts))
