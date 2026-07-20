package io.amar.console.ui.mail

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.amar.console.data.mail.MailFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Snooze picker sheet (mobile). Presets Later today / Tomorrow / Next week
 * (with shortcut hints + computed labels), then a custom Monday-based month
 * calendar with hour/minute selectors — port of SnoozePicker.tsx +
 * DateTimePicker.tsx. Confirm disabled until a day is picked.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SnoozePickerSheet(onSnooze: (Long) -> Unit, onDismiss: () -> Unit) {
    var showCustom by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Text(
                "Snooze until",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            if (!showCustom) {
                SnoozeOption("Later today", "1", timeLabel(MailFormat.laterToday())) { onSnooze(MailFormat.laterToday()) }
                SnoozeOption("Tomorrow", "2", "8:00 AM") { onSnooze(MailFormat.tomorrow()) }
                SnoozeOption("Next week", "3", "Mon, 8:00 AM") { onSnooze(MailFormat.nextWeek()) }
                Box(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).size(height = 1.dp, width = 1.dp).background(MaterialTheme.colorScheme.outlineVariant))
                Row(
                    Modifier.fillMaxWidth().clickable { showCustom = true }.padding(horizontal = 16.dp, vertical = 12.dp),
                ) { Text("Pick date & time", style = MaterialTheme.typography.bodyMedium) }
            } else {
                DateTimePicker(onSelect = onSnooze)
            }
        }
    }
}

@Composable
private fun SnoozeOption(label: String, shortcut: String, description: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(shortcut, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(width = 16.dp, height = 16.dp))
            Text(label, style = MaterialTheme.typography.bodyMedium)
        }
        Text(description, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private val DAY_HEADERS = listOf("Mo", "Tu", "We", "Th", "Fr", "Sa", "Su")

/** Monday-based month calendar + hour/minute selectors; Snooze disabled until a day chosen. */
@Composable
fun DateTimePicker(onSelect: (Long) -> Unit) {
    val nowCal = remember { Calendar.getInstance() }
    var viewYear by remember { mutableStateOf(nowCal.get(Calendar.YEAR)) }
    var viewMonth by remember { mutableStateOf(nowCal.get(Calendar.MONTH)) }
    var selectedDay by remember { mutableStateOf<Int?>(null) }
    var hour by remember { mutableStateOf(8) }
    var minute by remember { mutableStateOf(0) }

    val now = System.currentTimeMillis()
    val todayY = nowCal.get(Calendar.YEAR); val todayM = nowCal.get(Calendar.MONTH); val todayD = nowCal.get(Calendar.DAY_OF_MONTH)

    val firstDay = Calendar.getInstance().apply { clear(); set(viewYear, viewMonth, 1) }.get(Calendar.DAY_OF_WEEK) // Sun=1
    val blanks = ((firstDay - 1) + 6) % 7 // Monday-based leading blanks
    val daysInMonth = Calendar.getInstance().apply { clear(); set(viewYear, viewMonth, 1) }.getActualMaximum(Calendar.DAY_OF_MONTH)

    fun isPast(day: Int): Boolean {
        val end = Calendar.getInstance().apply { clear(); set(viewYear, viewMonth, day, 23, 59, 59) }.timeInMillis
        return end < now
    }

    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        // Month nav
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            IconButton(onClick = {
                if (viewMonth == 0) { viewMonth = 11; viewYear-- } else viewMonth--
                selectedDay = null
            }) { Icon(Icons.Filled.ChevronLeft, "Previous month", modifier = Modifier.size(18.dp)) }
            Text(
                SimpleDateFormat("MMMM yyyy", Locale.getDefault()).format(
                    Calendar.getInstance().apply { clear(); set(viewYear, viewMonth, 1) }.time
                ),
                style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium,
            )
            IconButton(onClick = {
                if (viewMonth == 11) { viewMonth = 0; viewYear++ } else viewMonth++
                selectedDay = null
            }) { Icon(Icons.Filled.ChevronRight, "Next month", modifier = Modifier.size(18.dp)) }
        }
        // Day-of-week headers
        Row(Modifier.fillMaxWidth()) {
            for (d in DAY_HEADERS) Text(d, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
        // Day grid
        val cells = List(blanks) { null } + (1..daysInMonth).map { it }
        LazyVerticalGrid(columns = GridCells.Fixed(7), modifier = Modifier.fillMaxWidth().padding(top = 2.dp)) {
            items(cells.size) { idx ->
                val day = cells[idx]
                if (day == null) {
                    Box(Modifier.size(34.dp))
                } else {
                    val past = isPast(day)
                    val selected = day == selectedDay
                    val isToday = viewYear == todayY && viewMonth == todayM && day == todayD
                    Box(
                        Modifier.size(34.dp).padding(2.dp).clip(CircleShape)
                            .background(if (selected) MaterialTheme.colorScheme.primary else androidx.compose.ui.graphics.Color.Transparent)
                            .clickable(enabled = !past) { selectedDay = day },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            day.toString(),
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = if (isToday && !selected) FontWeight.Bold else FontWeight.Normal,
                            color = when {
                                selected -> MaterialTheme.colorScheme.onPrimary
                                past -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
                                isToday -> MaterialTheme.colorScheme.primary
                                else -> MaterialTheme.colorScheme.onSurface
                            },
                        )
                    }
                }
            }
        }
        // Time selectors
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            NumberDropdown((0..23).toList(), hour) { hour = it }
            Text(":", color = MaterialTheme.colorScheme.onSurfaceVariant)
            NumberDropdown(listOf(0, 15, 30, 45), minute) { minute = it }
        }
        // Confirm
        androidx.compose.material3.Button(
            enabled = selectedDay != null,
            onClick = {
                val d = selectedDay ?: return@Button
                val ts = Calendar.getInstance().apply { clear(); set(viewYear, viewMonth, d, hour, minute, 0) }.timeInMillis
                onSelect(ts)
            },
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        ) { Text("Snooze") }
    }
}

@Composable
private fun NumberDropdown(options: List<Int>, value: Int, onSelect: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }) { Text(String.format(Locale.UK, "%02d", value)) }
        androidx.compose.material3.DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (o in options) androidx.compose.material3.DropdownMenuItem(
                text = { Text(String.format(Locale.UK, "%02d", o)) },
                onClick = { onSelect(o); open = false },
            )
        }
    }
}

private fun timeLabel(ts: Long): String = SimpleDateFormat("h:mm a", Locale.UK).format(Date(ts))
