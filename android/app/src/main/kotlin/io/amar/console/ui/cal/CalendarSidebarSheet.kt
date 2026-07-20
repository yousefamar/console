package io.amar.console.ui.cal

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.RssFeed
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.StarBorder
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.cal.CalendarRepository
import io.amar.console.data.db.CalendarRow

private const val OVERLAYS_GROUP = " overlays"

/**
 * Calendar list + account management sheet: calendars grouped by account,
 * synthetic overlays under one "Overlays" group, per-calendar visibility
 * toggle, default-calendar star (writable only), RSS/person swatch badges,
 * account add (OAuth) + remove.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarSidebarSheet(
    calendars: List<CalendarRow>,
    accounts: List<CalendarRepository.CalendarAccount>,
    hidden: Set<String>,
    defaultCalendarId: String?,
    onToggle: (String) -> Unit,
    onSetDefault: (String?) -> Unit,
    onAddAccount: () -> Unit,
    onRemoveAccount: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    // Group: synthetic overlays under one bucket, rest by accountEmail.
    val groups = calendars.groupBy { cal ->
        if (cal.accessRole == "reader" && cal.accountEmail == cal.calendarId &&
            (cal.calendarId == "meetup" || cal.calendarId == "outdoorlads")
        ) OVERLAYS_GROUP else cal.accountEmail
    }
    val orderedKeys = (accounts.map { it.email } + groups.keys).distinct()
        .filter { it in groups }
        .sortedBy { if (it == OVERLAYS_GROUP) "zzz" else it }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(bottom = 24.dp).verticalScroll(rememberScrollState())) {
            Text("Calendars", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))

            for (groupKey in orderedKeys) {
                val cals = groups[groupKey] ?: continue
                val header = if (groupKey == OVERLAYS_GROUP) "Overlays" else groupKey
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(header, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (groupKey != OVERLAYS_GROUP && accounts.any { it.email == groupKey }) {
                        IconButton(onClick = { onRemoveAccount(groupKey) }, modifier = Modifier.size(28.dp)) {
                            Icon(Icons.Filled.Delete, "Remove account", Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                for (cal in cals.sortedBy { it.name }) {
                    CalendarRowItem(cal, hidden, defaultCalendarId, onToggle, onSetDefault)
                }
            }

            HorizontalDivider(Modifier.padding(vertical = 6.dp), color = MaterialTheme.colorScheme.surfaceVariant)
            TextButton(onClick = onAddAccount, modifier = Modifier.padding(horizontal = 12.dp)) {
                Icon(Icons.Filled.Add, null, Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text("Add calendar account")
            }
        }
    }
}

@Composable
private fun CalendarRowItem(
    cal: CalendarRow,
    hidden: Set<String>,
    defaultCalendarId: String?,
    onToggle: (String) -> Unit,
    onSetDefault: (String?) -> Unit,
) {
    val key = cal.id // accountEmail:calendarId
    val visible = key !in hidden
    val writable = cal.accessRole == "owner" || cal.accessRole == "writer"
    val isImport = cal.calendarId.contains("@import.calendar.google.com")
    val isReadonly = cal.accessRole == "reader" || cal.accessRole == "freeBusyReader"
    val isDefault = defaultCalendarId != null && cal.calendarId == defaultCalendarId

    Row(
        Modifier.fillMaxWidth().clickable { onToggle(key) }.padding(horizontal = 20.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // Swatch: filled when visible, outline when hidden.
        Box(
            Modifier.size(12.dp).clip(RoundedCornerShape(3.dp))
                .background(if (visible) parseCalColor(cal.color) else androidx.compose.ui.graphics.Color.Transparent)
                .then(if (!visible) Modifier.androidxBorder(parseCalColor(cal.color)) else Modifier),
        )
        Text(
            cal.name,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            color = if (visible) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (isImport) Icon(Icons.Filled.RssFeed, "Imported ICS", Modifier.size(13.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        else if (isReadonly) Icon(Icons.Filled.Person, "Read-only", Modifier.size(13.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)

        if (writable) {
            IconButton(onClick = { onSetDefault(if (isDefault) null else cal.calendarId) }, modifier = Modifier.size(28.dp)) {
                Icon(
                    if (isDefault) Icons.Filled.Star else Icons.Outlined.StarBorder,
                    "Default calendar", Modifier.size(15.dp),
                    tint = if (isDefault) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Icon(
            if (visible) Icons.Outlined.Visibility else Icons.Outlined.VisibilityOff,
            if (visible) "Visible" else "Hidden",
            tint = if (visible) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp),
        )
    }
}

private fun Modifier.androidxBorder(color: androidx.compose.ui.graphics.Color): Modifier =
    this.border(1.dp, color, RoundedCornerShape(3.dp))
