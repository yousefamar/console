package io.amar.console.ui.cal

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.outlined.CalendarViewDay
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material.icons.outlined.ViewAgenda
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.cal.CalendarRepository
import io.amar.console.data.cal.parseEventDetails
import io.amar.console.data.cal.stripHtml
import io.amar.console.data.db.CalEventRow
import io.amar.console.data.db.CalendarRow
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Calendar pane: Agenda (day-grouped list) ↔ Day (24h grid) views over the
 * cached −30d..+90d window. Tap = detail bottom sheet (attendees, RSVP, Meet
 * link, edit/delete); create/edit dialogs with date+time pickers; per-calendar
 * colors + a visibility sheet; delete = immediate with a 5s undo snackbar.
 */

private const val PREFS = "console.cal"
private const val PREF_VIEW = "viewMode"           // "agenda" | "day"
private const val PREF_HIDDEN = "hiddenCalendars"  // Set<accountEmail:calendarId>

private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

@Composable
fun CalendarScreen(repo: CalendarRepository, onGrid: () -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val calendars by repo.observeCalendars().collectAsState(initial = emptyList())

    var viewMode by remember { mutableStateOf(prefs(context).getString(PREF_VIEW, "agenda") ?: "agenda") }
    var hiddenCals by remember {
        mutableStateOf(prefs(context).getStringSet(PREF_HIDDEN, emptySet())?.toSet() ?: emptySet())
    }
    var weekOffset by remember { mutableIntStateOf(0) }
    var dayOffset by remember { mutableIntStateOf(0) }
    var showCreate by remember { mutableStateOf(false) }
    var showVisibility by remember { mutableStateOf(false) }
    var detailKey by remember { mutableStateOf<String?>(null) }
    var editTarget by remember { mutableStateOf<CalEventRow?>(null) }
    var undoRow by remember { mutableStateOf<CalEventRow?>(null) }

    val calByKey = remember(calendars) { calendars.associateBy { "${it.accountEmail}:${it.calendarId}" } }
    fun isVisible(e: CalEventRow) = "${e.accountEmail}:${e.calendarId}" !in hiddenCals
    fun colorOf(e: CalEventRow): Color = parseCalColor(calByKey["${e.accountEmail}:${e.calendarId}"]?.color)

    val (rangeStart, rangeEnd) = remember(viewMode, weekOffset, dayOffset) {
        if (viewMode == "day") dayRange(dayOffset) else weekRange(weekOffset)
    }
    val allEvents by repo.observeEvents(rangeStart, rangeEnd).collectAsState(initial = emptyList())
    val events = remember(allEvents, hiddenCals) { allEvents.filter { isVisible(it) } }

    fun deleteWithUndo(row: CalEventRow) {
        scope.launch {
            repo.deleteEvent(row.compoundKey)
            undoRow = row
            delay(5000)
            if (undoRow?.compoundKey == row.compoundKey) undoRow = null
        }
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = { if (viewMode == "day") dayOffset-- else weekOffset-- }) {
                    Icon(Icons.Filled.ChevronLeft, "Previous")
                }
                Text(
                    if (viewMode == "day") dayNavLabel(dayOffset) else weekLabel(rangeStart),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                TextButton(onClick = { weekOffset = 0; dayOffset = 0 }) { Text("Today") }
                IconButton(onClick = { showVisibility = true }) {
                    Icon(Icons.Outlined.Visibility, "Calendar visibility")
                }
                IconButton(onClick = {
                    viewMode = if (viewMode == "day") "agenda" else "day"
                    prefs(context).edit().putString(PREF_VIEW, viewMode).apply()
                }) {
                    Icon(
                        if (viewMode == "day") Icons.Outlined.ViewAgenda else Icons.Outlined.CalendarViewDay,
                        if (viewMode == "day") "Agenda view" else "Day view",
                    )
                }
                IconButton(onClick = { if (viewMode == "day") dayOffset++ else weekOffset++ }) {
                    Icon(Icons.Filled.ChevronRight, "Next")
                }
            }

            if (viewMode == "day") {
                DayGrid(
                    events = events,
                    dayStart = rangeStart,
                    colorOf = ::colorOf,
                    onOpen = { detailKey = it.compoundKey },
                )
            } else {
                AgendaList(
                    events = events,
                    colorOf = ::colorOf,
                    onOpen = { detailKey = it.compoundKey },
                )
            }
        }
        FloatingActionButton(
            onClick = { showCreate = true },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        ) { Icon(Icons.Filled.Add, "Create event") }

        undoRow?.let { row ->
            Snackbar(
                modifier = Modifier.align(Alignment.BottomCenter).padding(8.dp),
                action = {
                    TextButton(onClick = {
                        scope.launch { repo.undoDelete(row) }
                        undoRow = null
                    }) { Text("Undo") }
                },
            ) { Text("Deleted \"${row.summary}\"") }
        }
    }

    if (showCreate) {
        EventFormDialog(
            title = "New event",
            calendars = calendars,
            initial = null,
            onDismiss = { showCreate = false },
            onSubmit = { calKey, summary, start, end, allDay, location ->
                showCreate = false
                val cal = calByKey[calKey] ?: return@EventFormDialog
                scope.launch {
                    repo.createEvent(cal.accountEmail, cal.calendarId, summary, start, end, allDay, location)
                }
            },
        )
    }

    editTarget?.let { target ->
        EventFormDialog(
            title = "Edit event",
            calendars = calendars,
            initial = target,
            onDismiss = { editTarget = null },
            onSubmit = { _, summary, start, end, _, location ->
                editTarget = null
                scope.launch { repo.updateEvent(target.compoundKey, summary, start, end, location) }
            },
        )
    }

    detailKey?.let { key ->
        // Re-resolve live so RSVP flips reflect immediately.
        val event = allEvents.firstOrNull { it.compoundKey == key }
        if (event == null) {
            detailKey = null
        } else {
            EventDetailSheet(
                event = event,
                calendar = calByKey["${event.accountEmail}:${event.calendarId}"],
                onDismiss = { detailKey = null },
                onRsvp = { status -> scope.launch { repo.rsvp(event.compoundKey, status) } },
                onEdit = { detailKey = null; editTarget = event },
                onDelete = { detailKey = null; deleteWithUndo(event) },
            )
        }
    }

    if (showVisibility) {
        CalendarVisibilitySheet(
            calendars = calendars,
            hidden = hiddenCals,
            onToggle = { calKey ->
                hiddenCals = if (calKey in hiddenCals) hiddenCals - calKey else hiddenCals + calKey
                prefs(context).edit().putStringSet(PREF_HIDDEN, hiddenCals).apply()
            },
            onDismiss = { showVisibility = false },
        )
    }
}

// ------------------------------------------------------------------ //
// Agenda view

@Composable
private fun AgendaList(
    events: List<CalEventRow>,
    colorOf: (CalEventRow) -> Color,
    onOpen: (CalEventRow) -> Unit,
) {
    val byDay = events.groupBy { dayKey(it.startTime) }.toSortedMap()
    if (events.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Nothing this week", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
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
                    EventRow(event, colorOf(event), onClick = { onOpen(event) })
                }
            }
        }
    }
}

@Composable
private fun EventRow(event: CalEventRow, color: Color, onClick: () -> Unit) {
    val pending = event.eventId.startsWith("~")
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
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
                .background(if (pending) MaterialTheme.colorScheme.onSurfaceVariant else color),
        )
        Column(Modifier.weight(1f)) {
            Text(
                event.summary + if (pending) " 🕓" else "",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            event.location?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

// ------------------------------------------------------------------ //
// Day view: 24h vertical grid, 1dp per minute.

private const val MINUTE_DP = 1f

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DayGrid(
    events: List<CalEventRow>,
    dayStart: Long,
    colorOf: (CalEventRow) -> Color,
    onOpen: (CalEventRow) -> Unit,
) {
    val dayEnd = dayStart + 24L * 60 * 60 * 1000
    val allDay = events.filter { it.isAllDay }
    val timed = events.filter { !it.isAllDay }
    val now = System.currentTimeMillis()
    val isToday = now in dayStart until dayEnd
    val lanes = remember(timed) { assignLanes(timed.sortedBy { it.startTime }) }
    val maxLane = (lanes.values.maxOrNull() ?: 0) + 1

    Column(Modifier.fillMaxSize()) {
        // All-day chips pinned above the grid.
        for (e in allDay) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 2.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(colorOf(e).copy(alpha = 0.25f))
                    .clickable { onOpen(e) }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(8.dp).clip(RoundedCornerShape(2.dp)).background(colorOf(e)))
                Spacer(Modifier.width(6.dp))
                Text(e.summary, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Box(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
        ) {
            Box(Modifier.fillMaxWidth().height((24 * 60 * MINUTE_DP).dp)) {
                // Hour lines + labels.
                for (h in 0..23) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .offset(y = (h * 60 * MINUTE_DP).dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Text(
                            "%02d:00".format(h),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.width(44.dp).padding(start = 6.dp),
                        )
                        HorizontalDivider(
                            Modifier.weight(1f).padding(top = 7.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant,
                        )
                    }
                }
                // Event blocks (lane-split when overlapping).
                for (e in timed) {
                    val startMin = ((maxOf(e.startTime, dayStart) - dayStart) / 60000L).toInt()
                    val endMin = ((minOf(e.endTime, dayEnd) - dayStart) / 60000L).toInt()
                    val heightMin = maxOf(endMin - startMin, 24)
                    val lane = lanes[e.compoundKey] ?: 0
                    val color = colorOf(e)
                    androidx.compose.ui.layout.Layout(
                        content = {
                            Column(
                                Modifier
                                    .fillMaxSize()
                                    .padding(horizontal = 1.dp)
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(color.copy(alpha = 0.3f))
                                    .clickable { onOpen(e) }
                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                            ) {
                                Text(
                                    e.summary,
                                    style = MaterialTheme.typography.labelMedium,
                                    fontWeight = FontWeight.Medium,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    "${timeShort(e.startTime)}–${timeShort(e.endTime)}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                )
                            }
                        },
                        modifier = Modifier.offset(y = (startMin * MINUTE_DP).dp),
                    ) { measurables, constraints ->
                        val gutter = (44 * density).toInt()
                        val usable = constraints.maxWidth - gutter
                        val w = usable / maxLane
                        val hPx = (heightMin * MINUTE_DP * density).toInt()
                        val placeable = measurables.first().measure(
                            androidx.compose.ui.unit.Constraints.fixed(w, hPx)
                        )
                        layout(constraints.maxWidth, hPx) {
                            placeable.place(gutter + lane * w, 0)
                        }
                    }
                }
                // Now line.
                if (isToday) {
                    val nowMin = ((now - dayStart) / 60000L).toInt()
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .offset(y = (nowMin * MINUTE_DP).dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier
                                .padding(start = 40.dp)
                                .size(8.dp)
                                .clip(RoundedCornerShape(4.dp))
                                .background(MaterialTheme.colorScheme.error),
                        )
                        HorizontalDivider(
                            Modifier.weight(1f),
                            thickness = 2.dp,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
        }
    }
}

/** Greedy lane assignment for overlapping timed events (sorted by start). */
internal fun assignLanes(sorted: List<CalEventRow>): Map<String, Int> {
    val laneEnds = mutableListOf<Long>()
    val out = mutableMapOf<String, Int>()
    for (e in sorted) {
        val lane = laneEnds.indexOfFirst { it <= e.startTime }
        if (lane >= 0) {
            laneEnds[lane] = e.endTime
            out[e.compoundKey] = lane
        } else {
            laneEnds.add(e.endTime)
            out[e.compoundKey] = laneEnds.size - 1
        }
    }
    return out
}

// ------------------------------------------------------------------ //
// Detail bottom sheet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EventDetailSheet(
    event: CalEventRow,
    calendar: CalendarRow?,
    onDismiss: () -> Unit,
    onRsvp: (String) -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    val context = LocalContext.current
    val details = remember(event.rawJson) { parseEventDetails(event.rawJson) }
    val calColor = parseCalColor(calendar?.color)
    val isWritable = calendar?.accessRole == "owner" || calendar?.accessRole == "writer"
    val self = details.selfAttendee

    fun openUrl(url: String) {
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))) }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
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
                if (event.isAllDay) dayLabel(event.startTime) + " · all day"
                else "${dayLabel(event.startTime)} · ${timeShort(event.startTime)}–${timeShort(event.endTime)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            event.location?.let {
                Spacer(Modifier.height(4.dp))
                Text("📍 $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            details.description?.let { desc ->
                Spacer(Modifier.height(8.dp))
                Text(
                    stripHtml(desc),
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 8,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (details.attendees.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Text("ATTENDEES", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                for (a in details.attendees.take(8)) {
                    Row(
                        Modifier.padding(vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Box(
                            Modifier.size(7.dp).clip(RoundedCornerShape(4.dp)).background(rsvpDotColor(a.responseStatus))
                        )
                        Text(
                            a.displayName ?: a.email,
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        if (a.organizer) {
                            Text("(organizer)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                if (details.attendees.size > 8) {
                    Text("+${details.attendees.size - 8} more", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
            Row(
                Modifier.fillMaxWidth().padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                details.hangoutLink?.let { link ->
                    TextButton(onClick = { openUrl(link) }) {
                        Icon(Icons.Outlined.Videocam, null, Modifier.size(16.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Join")
                    }
                }
                details.htmlLink?.let { link ->
                    TextButton(onClick = { openUrl(link) }) {
                        Icon(Icons.Outlined.OpenInNew, null, Modifier.size(16.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("GCal")
                    }
                }
                Spacer(Modifier.weight(1f))
                if (isWritable) {
                    TextButton(onClick = onEdit, enabled = !event.eventId.startsWith("~")) {
                        Icon(Icons.Filled.Edit, null, Modifier.size(16.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Edit")
                    }
                    TextButton(onClick = onDelete) {
                        Icon(Icons.Filled.Delete, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.error)
                        Spacer(Modifier.width(4.dp))
                        Text("Delete", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }
}

@Composable
private fun RsvpChip(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, active: Boolean, onClick: () -> Unit) {
    val bg = if (active) MaterialTheme.colorScheme.primaryContainer else Color.Transparent
    Row(
        Modifier
            .clip(RoundedCornerShape(16.dp))
            .background(bg)
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
private fun rsvpDotColor(status: String): Color = when (status) {
    "accepted" -> Color(0xFF4ADE80)
    "tentative" -> Color(0xFFFACC15)
    "declined" -> Color(0xFFF87171)
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

// ------------------------------------------------------------------ //
// Calendar visibility sheet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CalendarVisibilitySheet(
    calendars: List<CalendarRow>,
    hidden: Set<String>,
    onToggle: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(
            "Calendars",
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
        )
        for (cal in calendars.sortedBy { it.name }) {
            val key = "${cal.accountEmail}:${cal.calendarId}"
            val visible = key !in hidden
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { onToggle(key) }
                    .padding(horizontal = 20.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(parseCalColor(cal.color)))
                Text(
                    cal.name,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = if (visible) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Icon(
                    if (visible) Icons.Outlined.Visibility else Icons.Outlined.VisibilityOff,
                    if (visible) "Visible" else "Hidden",
                    tint = if (visible) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

// ------------------------------------------------------------------ //
// Create / edit form dialog

@Composable
private fun EventFormDialog(
    title: String,
    calendars: List<CalendarRow>,
    initial: CalEventRow?,
    onDismiss: () -> Unit,
    onSubmit: (calKey: String, summary: String, startMs: Long, endMs: Long, allDay: Boolean, location: String?) -> Unit,
) {
    val context = LocalContext.current
    val writable = remember(calendars) {
        calendars.filter { it.accessRole == "owner" || it.accessRole == "writer" }
    }
    var summary by remember { mutableStateOf(initial?.summary ?: "") }
    var location by remember { mutableStateOf(initial?.location ?: "") }
    var allDay by remember { mutableStateOf(initial?.isAllDay ?: false) }
    var startMs by remember { mutableLongStateOf(initial?.startTime ?: nextHour()) }
    var endMs by remember { mutableLongStateOf(initial?.endTime ?: (nextHour() + 60 * 60 * 1000)) }
    var selectedCal by remember {
        mutableStateOf(
            initial?.let { "${it.accountEmail}:${it.calendarId}" }
                ?: writable.firstOrNull { it.calendarId == it.accountEmail }?.let { "${it.accountEmail}:${it.calendarId}" }
                ?: writable.firstOrNull()?.let { "${it.accountEmail}:${it.calendarId}" }
                ?: "",
        )
    }
    var showCalPicker by remember { mutableStateOf(false) }
    val editing = initial != null

    fun pickDateTime(current: Long, dateOnly: Boolean, onPicked: (Long) -> Unit) {
        val cal = Calendar.getInstance().apply { timeInMillis = current }
        android.app.DatePickerDialog(
            context,
            { _, y, m, d ->
                if (dateOnly) {
                    cal.set(y, m, d)
                    cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
                    onPicked(cal.timeInMillis)
                } else {
                    android.app.TimePickerDialog(
                        context,
                        { _, h, min ->
                            cal.set(y, m, d, h, min, 0)
                            cal.set(Calendar.MILLISECOND, 0)
                            onPicked(cal.timeInMillis)
                        },
                        cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE), true,
                    ).show()
                }
            },
            cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH),
        ).show()
    }

    val dtFmt = remember { SimpleDateFormat("EEE d MMM HH:mm", Locale.UK) }
    val dFmt = remember { SimpleDateFormat("EEE d MMM", Locale.UK) }
    fun fmt(ms: Long) = if (allDay) dFmt.format(Date(ms)) else dtFmt.format(Date(ms))

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = summary, onValueChange = { summary = it },
                    label = { Text("Title") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (!editing) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("All day", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                        Switch(checked = allDay, onCheckedChange = { allDay = it })
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Starts", style = MaterialTheme.typography.labelMedium, modifier = Modifier.width(52.dp))
                    TextButton(onClick = {
                        pickDateTime(startMs, allDay) { picked ->
                            val dur = endMs - startMs
                            startMs = picked
                            endMs = picked + dur
                        }
                    }) { Text(fmt(startMs)) }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Ends", style = MaterialTheme.typography.labelMedium, modifier = Modifier.width(52.dp))
                    TextButton(onClick = {
                        pickDateTime(endMs, allDay) { picked ->
                            if (picked > startMs) endMs = picked
                        }
                    }) { Text(fmt(endMs)) }
                }
                OutlinedTextField(
                    value = location, onValueChange = { location = it },
                    label = { Text("Location") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (!editing && writable.size > 1) {
                    val cal = writable.firstOrNull { "${it.accountEmail}:${it.calendarId}" == selectedCal }
                    Row(
                        Modifier.fillMaxWidth().clickable { showCalPicker = !showCalPicker },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(parseCalColor(cal?.color)))
                        Text(cal?.name ?: "Pick calendar", style = MaterialTheme.typography.bodyMedium)
                    }
                    if (showCalPicker) {
                        Column {
                            for (c in writable) {
                                val key = "${c.accountEmail}:${c.calendarId}"
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .clickable { selectedCal = key; showCalPicker = false }
                                        .padding(vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(parseCalColor(c.color)))
                                    Text(c.name, style = MaterialTheme.typography.bodySmall)
                                    if (key == selectedCal) Icon(Icons.Filled.Check, null, Modifier.size(14.dp))
                                }
                            }
                        }
                    }
                }
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
                    onSubmit(selectedCal, summary.trim(), startMs, endMs, allDay, location.trim().ifEmpty { null })
                },
                enabled = summary.isNotBlank() && (editing || selectedCal.isNotEmpty()) && endMs > startMs,
            ) { Text(if (editing) "Save" else "Create") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// ------------------------------------------------------------------ //
// Helpers

/** "#9fe1e7" → Color; null/garbage → theme-ish blue. */
internal fun parseCalColor(hex: String?): Color {
    if (hex == null) return Color(0xFF3B82F6)
    return runCatching {
        Color(android.graphics.Color.parseColor(hex))
    }.getOrDefault(Color(0xFF3B82F6))
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

private fun dayRange(offset: Int): Pair<Long, Long> {
    val cal = Calendar.getInstance()
    cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0); cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
    cal.add(Calendar.DAY_OF_YEAR, offset)
    val start = cal.timeInMillis
    cal.add(Calendar.DAY_OF_YEAR, 1)
    return start to cal.timeInMillis
}

private fun weekLabel(startMs: Long): String =
    "Week of " + SimpleDateFormat("d MMM", Locale.UK).format(Date(startMs))

private fun dayNavLabel(offset: Int): String {
    val (start, _) = dayRange(offset)
    return when (offset) {
        0 -> "Today · " + SimpleDateFormat("EEE d MMM", Locale.UK).format(Date(start))
        else -> SimpleDateFormat("EEEE d MMM", Locale.UK).format(Date(start))
    }
}

private fun dayKey(ms: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(ms))
private fun dayLabel(ms: Long): String = SimpleDateFormat("EEEE d MMMM", Locale.UK).format(Date(ms))
private fun timeShort(ms: Long): String = SimpleDateFormat("HH:mm", Locale.UK).format(Date(ms))

private fun nextHour(): Long {
    val cal = Calendar.getInstance()
    cal.add(Calendar.HOUR_OF_DAY, 1)
    cal.set(Calendar.MINUTE, 0); cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
    return cal.timeInMillis
}
