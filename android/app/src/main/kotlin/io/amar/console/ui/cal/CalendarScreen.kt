package io.amar.console.ui.cal

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.amar.console.data.cal.CalendarRepository
import io.amar.console.data.db.CalEventRow
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Agenda view over the cached window (offline-first; week/day grids later).
 * Day-grouped upcoming events, swipe weeks via chevrons, create via FAB
 * (queued offline with a temp id), long-press delete.
 */
@Composable
fun CalendarScreen(repo: CalendarRepository) {
    var weekOffset by remember { mutableStateOf(0) }
    val (rangeStart, rangeEnd) = remember(weekOffset) { weekRange(weekOffset) }
    val events by repo.observeEvents(rangeStart, rangeEnd).collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var showCreate by remember { mutableStateOf(false) }
    var deleteTarget by remember { mutableStateOf<CalEventRow?>(null) }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = { weekOffset-- }) { Icon(Icons.Filled.ChevronLeft, "Previous week") }
                Text(
                    weekLabel(rangeStart),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { weekOffset = 0 }) { Text("Today") }
                IconButton(onClick = { weekOffset++ }) { Icon(Icons.Filled.ChevronRight, "Next week") }
            }

            val byDay = events.groupBy { dayKey(it.startTime) }.toSortedMap()
            if (events.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        "Nothing this week",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    for ((day, dayEvents) in byDay) {
                        item(key = "day-$day") {
                            Text(
                                dayLabel(dayEvents.first().startTime),
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                            )
                        }
                        for (event in dayEvents.sortedBy { it.startTime }) {
                            item(key = event.compoundKey) {
                                EventRow(event, onLongPress = { deleteTarget = event })
                            }
                        }
                    }
                }
            }
        }
        FloatingActionButton(
            onClick = { showCreate = true },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        ) { Icon(Icons.Filled.Add, "Create event") }
    }

    if (showCreate) {
        CreateEventDialog(
            repo = repo,
            onDismiss = { showCreate = false },
        )
    }
    deleteTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("Delete event?") },
            text = { Text(target.summary) },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch { repo.deleteEvent(target.compoundKey) }
                    deleteTarget = null
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleteTarget = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun EventRow(event: CalEventRow, onLongPress: () -> Unit) {
    val pending = event.eventId.startsWith("~")
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onLongPress) // tap = actions (delete confirm) for v1
            .padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.width(52.dp)) {
            if (event.isAllDay) {
                Text("all day", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Text(timeShort(event.startTime), style = MaterialTheme.typography.labelMedium)
                Text(timeShort(event.endTime), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Box(
            Modifier
                .size(width = 3.dp, height = 34.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(if (pending) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary),
        )
        Column(Modifier.weight(1f)) {
            Text(
                event.summary + if (pending) " 🕓" else "",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            event.location?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun CreateEventDialog(repo: CalendarRepository, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val calendars by repo.observeCalendars().collectAsState(initial = emptyList())
    var summary by remember { mutableStateOf("") }
    var startMs by remember { mutableLongStateOf(nextHour()) }
    var durationMin by remember { mutableStateOf("60") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New event") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = summary, onValueChange = { summary = it },
                    label = { Text("Title") }, singleLine = true,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { startMs -= 30 * 60 * 1000 }) { Text("−30m") }
                    Text(SimpleDateFormat("EEE d MMM HH:mm", Locale.UK).format(Date(startMs)))
                    TextButton(onClick = { startMs += 30 * 60 * 1000 }) { Text("+30m") }
                }
                OutlinedTextField(
                    value = durationMin, onValueChange = { durationMin = it },
                    label = { Text("Duration (min)") }, singleLine = true,
                )
                Text(
                    "Queued offline — lands in Google Calendar when connected.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val primary = calendars.firstOrNull { it.calendarId == it.accountEmail } ?: calendars.firstOrNull()
                    if (primary != null && summary.isNotBlank()) {
                        val dur = (durationMin.toLongOrNull() ?: 60L) * 60 * 1000
                        scope.launch {
                            repo.createEvent(primary.accountEmail, primary.calendarId, summary.trim(), startMs, startMs + dur)
                        }
                    }
                    onDismiss()
                },
                enabled = summary.isNotBlank() && calendars.isNotEmpty(),
            ) { Text("Create") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

private fun weekRange(offset: Int): Pair<Long, Long> {
    val cal = Calendar.getInstance()
    cal.firstDayOfWeek = Calendar.MONDAY
    cal.set(Calendar.DAY_OF_WEEK, Calendar.MONDAY)
    cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0); cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
    cal.add(Calendar.WEEK_OF_YEAR, offset)
    val start = cal.timeInMillis
    cal.add(Calendar.DAY_OF_YEAR, 7)
    return start to cal.timeInMillis
}

private fun weekLabel(startMs: Long): String =
    "Week of " + SimpleDateFormat("d MMM", Locale.UK).format(Date(startMs))

private fun dayKey(ms: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(ms))
private fun dayLabel(ms: Long): String = SimpleDateFormat("EEEE d MMMM", Locale.UK).format(Date(ms))
private fun timeShort(ms: Long): String = SimpleDateFormat("HH:mm", Locale.UK).format(Date(ms))

private fun nextHour(): Long {
    val cal = Calendar.getInstance()
    cal.add(Calendar.HOUR_OF_DAY, 1)
    cal.set(Calendar.MINUTE, 0); cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
    return cal.timeInMillis
}
