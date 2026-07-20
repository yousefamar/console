package io.amar.console.ui.cal

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.cal.effectiveReminderMinutes
import io.amar.console.data.cal.extractUrls
import io.amar.console.data.cal.hasReminder
import io.amar.console.data.cal.parseEventDetails
import io.amar.console.data.cal.stripHtml
import io.amar.console.data.db.CalEventRow
import io.amar.console.data.db.CalendarRow

private val REMINDER_PRESETS = listOf(
    0 to "At start", 5 to "5 min", 10 to "10 min", 15 to "15 min", 30 to "30 min", 60 to "1 hr",
)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun EventDetailSheet(
    event: CalEventRow,
    calendar: CalendarRow?,
    calendarDefaults: List<Int>,
    onDismiss: () -> Unit,
    onRsvp: (String) -> Unit,
    onSetReminder: (Int?) -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    val context = LocalContext.current
    val details = remember(event.rawJson) { parseEventDetails(event.rawJson) }
    val calColor = parseCalColor(calendar?.color)
    val isWritable = calendar?.accessRole == "owner" || calendar?.accessRole == "writer"
    val self = details.selfAttendee
    var confirmDelete by remember { mutableStateOf(false) }

    fun openUrl(url: String) {
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))) }
    }

    // Append ?authuser=<accountEmail> to meet.google.com links so it opens
    // under the right account (SPA parity).
    fun joinUrl(link: String): String {
        if (!link.contains("meet.google.com")) return link
        val sep = if (link.contains("?")) "&" else "?"
        return "$link${sep}authuser=${android.net.Uri.encode(event.accountEmail)}"
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp).verticalScroll(rememberScrollState())) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(12.dp).clip(RoundedCornerShape(3.dp)).background(calColor))
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(event.summary, style = MaterialTheme.typography.titleMedium)
                    calendar?.let {
                        Text(it.name, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
            Text(
                if (event.isAllDay) dayLabelLong(event.startTime) + " · all day"
                else "${dayLabelLong(event.startTime)} · ${timeShort(event.startTime)}–${timeShort(event.endTime)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            event.location?.let {
                Spacer(Modifier.height(4.dp))
                Text("📍 $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            details.description?.let { desc ->
                val text = stripHtml(desc)
                Spacer(Modifier.height(8.dp))
                Box(Modifier.heightIn(max = 160.dp).verticalScroll(rememberScrollState())) {
                    Text(text, style = MaterialTheme.typography.bodySmall)
                }
                val urls = extractUrls(text)
                if (urls.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (u in urls.take(4)) {
                            TextButton(onClick = { openUrl(u) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 6.dp, vertical = 0.dp)) {
                                Icon(Icons.Outlined.OpenInNew, null, Modifier.size(12.dp))
                                Spacer(Modifier.width(2.dp))
                                Text(u.removePrefix("https://").removePrefix("http://").take(24), style = MaterialTheme.typography.labelSmall, maxLines = 1)
                            }
                        }
                    }
                }
            }

            if (details.attendees.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Text("ATTENDEES", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                for (a in details.attendees.take(5)) {
                    Row(Modifier.padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(Modifier.size(7.dp).clip(RoundedCornerShape(4.dp)).background(rsvpDotColor(a.responseStatus)))
                        Text(a.displayName ?: a.email, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        if (a.organizer) Text("(organizer)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (details.attendees.size > 5) {
                    Text("+${details.attendees.size - 5} more", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            // Reminder picker — owner/writer + timed events only.
            if (isWritable && !event.isAllDay) {
                Spacer(Modifier.height(10.dp))
                val hasRem = hasReminder(details.reminders, calendarDefaults)
                val activeMinutes = effectiveReminderMinutes(details.reminders, calendarDefaults)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Icon(if (hasRem) Icons.Filled.Notifications else Icons.Filled.NotificationsOff, null, Modifier.size(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("REMINDER", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((min, label) in REMINDER_PRESETS) {
                        ChipButton(label, active = hasRem && activeMinutes == min) {
                            onSetReminder(if (hasRem && activeMinutes == min) null else min)
                        }
                    }
                }
            }

            if (self != null) {
                Spacer(Modifier.height(10.dp))
                Text("RSVP", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RsvpChip("Accept", Icons.Filled.Check, self.responseStatus == "accepted") { onRsvp("accepted") }
                    RsvpChip("Maybe", Icons.Outlined.HelpOutline, self.responseStatus == "tentative") { onRsvp("tentative") }
                    RsvpChip("Decline", Icons.Filled.Close, self.responseStatus == "declined") { onRsvp("declined") }
                }
            }

            Spacer(Modifier.height(12.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                details.hangoutLink?.let { link ->
                    TextButton(onClick = { openUrl(joinUrl(link)) }) {
                        Icon(Icons.Outlined.Videocam, null, Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)); Text("Join")
                    }
                }
                details.htmlLink?.let { link ->
                    TextButton(onClick = { openUrl(link) }) {
                        Icon(Icons.Outlined.OpenInNew, null, Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)); Text("Google")
                    }
                }
                Spacer(Modifier.weight(1f))
                if (isWritable) {
                    TextButton(onClick = onEdit, enabled = !event.eventId.startsWith("~")) {
                        Icon(Icons.Filled.Edit, null, Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)); Text("Edit")
                    }
                    TextButton(onClick = { confirmDelete = true }) {
                        Icon(Icons.Filled.Delete, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.error)
                        Spacer(Modifier.width(4.dp)); Text("Delete", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete event") },
            text = { Text("Delete this event?") },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; onDelete() }) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun ChipButton(label: String, active: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(if (active) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) { Text(label, style = MaterialTheme.typography.labelSmall) }
}

@Composable
private fun RsvpChip(label: String, icon: ImageVector, active: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .clip(RoundedCornerShape(16.dp))
            .background(if (active) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(icon, null, Modifier.size(14.dp))
        Text(label, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
fun rsvpDotColor(status: String): Color = when (status) {
    "accepted" -> Color(0xFF4ADE80)
    "tentative" -> Color(0xFFFACC15)
    "declined" -> Color(0xFFF87171)
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}
