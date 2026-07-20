package io.amar.console.ui.cal

import android.content.Context
import androidx.browser.customtabs.CustomTabsIntent
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Flight
import androidx.compose.material.icons.outlined.CalendarViewMonth
import androidx.compose.material.icons.outlined.CalendarViewWeek
import androidx.compose.material.icons.outlined.ViewDay
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.core.HubConfig
import io.amar.console.data.cal.CalendarRepository
import io.amar.console.data.cal.DAY_MS
import io.amar.console.data.cal.FlightsRepository
import io.amar.console.data.cal.addMonthsClamped
import io.amar.console.data.cal.parseEventDetails
import io.amar.console.data.cal.startOfDay
import io.amar.console.data.cal.startOfWeek
import io.amar.console.data.db.CalEventRow
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Calendar

private const val PREFS = "console.cal"
private const val PREF_VIEW = "viewMode"                // "month" | "week" | "day" (local only)

private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

/**
 * Calendar pane — full multi-view surface: Month (6×7 grid), Week (7-col time
 * grid) and Day (1-col) with now-line, drag-to-create/move, all-day + working
 * -location rows, detail sheet (RSVP/reminders/join/delete), event form
 * (guests + Meet + move), overlays (Meetup/OutdoorLads), account management +
 * mini-month jump + default-calendar star + flights.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun CalendarScreen(repo: CalendarRepository, onGrid: () -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val flights = remember(repo) { repo.flights }
    val calendars by repo.observeCalendars().collectAsState(initial = emptyList())
    val accounts by repo.observeAccounts().collectAsState(initial = emptyList())
    val calDefaults by repo.observeCalendarDefaults().collectAsState(initial = emptyMap())
    val flightWatchlists by flights.watchlists.collectAsState(initial = emptyList())

    var viewMode by remember { mutableStateOf(prefs(context).getString(PREF_VIEW, "week") ?: "week") }
    // Visibility + default calendar are hub-synced (cross-device). visibleIds
    // null = not-yet-loaded → treat all calendars visible (first-load default).
    val visibleIds by repo.visibleIds.collectAsState(initial = null)
    val defaultCalId by repo.defaultCalendarId.collectAsState(initial = null)

    // currentDate anchor (local midnight of the focused day).
    var anchorMs by remember { mutableLongStateOf(startOfDay(System.currentTimeMillis())) }

    var showVisibility by remember { mutableStateOf(false) }
    var showMiniMonth by remember { mutableStateOf(false) }
    var showFlights by remember { mutableStateOf(false) }
    var detailKey by remember { mutableStateOf<String?>(null) }
    var editTarget by remember { mutableStateOf<CalEventRow?>(null) }
    var formPrefill by remember { mutableStateOf<Pair<Long, Long>?>(null) }
    var showCreate by remember { mutableStateOf(false) }
    var undoRow by remember { mutableStateOf<CalEventRow?>(null) }
    var recurringEdit by remember { mutableStateOf<GridEdit?>(null) }
    var locationPick by remember { mutableStateOf<Pair<CalEventRow?, Long>?>(null) }

    val calByKey = remember(calendars) { calendars.associateBy { it.id } }
    // First-seen overlays default visible even against a saved allow-list.
    androidx.compose.runtime.LaunchedEffect(calendars, visibleIds) {
        val overlayIds = calendars.filter {
            it.accessRole == "reader" && (it.calendarId == "meetup" || it.calendarId == "outdoorlads")
        }.map { it.id }.toSet()
        if (overlayIds.isNotEmpty()) repo.ensureOverlaysVisible(overlayIds)
    }
    // null visibleIds → all visible (first load). Otherwise it's the allow-list.
    fun isVisible(e: CalEventRow) = visibleIds?.contains("${e.accountEmail}:${e.calendarId}") ?: true
    val hiddenCals = remember(visibleIds, calendars) {
        val vis = visibleIds ?: return@remember emptySet()
        calendars.map { it.id }.filter { it !in vis }.toSet()
    }

    // Fetch range covers the whole visible view (month grid spans 6 weeks).
    val (rangeStart, rangeEnd) = remember(viewMode, anchorMs) {
        when (viewMode) {
            "day" -> startOfDay(anchorMs) to (startOfDay(anchorMs) + DAY_MS)
            "week" -> startOfWeek(anchorMs) to (startOfWeek(anchorMs) + 7 * DAY_MS)
            else -> {
                val ws = startOfWeek(firstOfMonth(anchorMs))
                (ws - 7 * DAY_MS) to (ws + 49 * DAY_MS)
            }
        }
    }
    val allEvents by repo.observeEvents(rangeStart - DAY_MS, rangeEnd + DAY_MS).collectAsState(initial = emptyList())
    val events = remember(allEvents, visibleIds) { allEvents.filter { isVisible(it) } }

    fun deleteWithUndo(row: CalEventRow) {
        scope.launch {
            repo.deleteEvent(row.compoundKey)
            undoRow = row
            delay(5000)
            if (undoRow?.compoundKey == row.compoundKey) undoRow = null
        }
    }

    fun applyEdit(edit: GridEdit) {
        val e = edit.event ?: return
        val details = parseEventDetails(e.rawJson)
        if (details.isRecurring) { recurringEdit = edit; return }
        scope.launch {
            repo.updateEvent(e.compoundKey, e.summary, edit.startMs, edit.endMs, e.location)
        }
    }

    fun openOAuth() {
        val url = "${HubConfig.hubBase}/auth/google/start?callback=app"
        runCatching { CustomTabsIntent.Builder().build().launchUrl(context, android.net.Uri.parse(url)) }
        scope.launch {
            val email = repo.pollForNewAccount()
            if (email != null) repo.getAccounts()
        }
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            // Header: nav + label + M/W/D toggle + flights + visibility.
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onGrid) { Icon(Icons.Filled.CalendarMonth, "App grid", Modifier.size(20.dp)) }
                IconButton(onClick = {
                    anchorMs = when (viewMode) {
                        "day" -> anchorMs - DAY_MS
                        "week" -> anchorMs - 7 * DAY_MS
                        else -> addMonthsClamped(anchorMs, -1)
                    }
                }) { Icon(Icons.Filled.ChevronLeft, "Previous") }
                Text(
                    headerLabel(viewMode, anchorMs),
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f).clickable { showMiniMonth = true },
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                IconButton(onClick = {
                    anchorMs = when (viewMode) {
                        "day" -> anchorMs + DAY_MS
                        "week" -> anchorMs + 7 * DAY_MS
                        else -> addMonthsClamped(anchorMs, 1)
                    }
                }) { Icon(Icons.Filled.ChevronRight, "Next") }
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp).padding(bottom = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                TextButton(onClick = { anchorMs = startOfDay(System.currentTimeMillis()) }) { Text("Today") }
                ViewChip("M", Icons.Outlined.CalendarViewMonth, viewMode == "month") { setView(context, "month") { viewMode = it } }
                ViewChip("W", Icons.Outlined.CalendarViewWeek, viewMode == "week") { setView(context, "week") { viewMode = it } }
                ViewChip("D", Icons.Outlined.ViewDay, viewMode == "day") { setView(context, "day") { viewMode = it } }
                Box(Modifier.weight(1f))
                IconButton(onClick = { showFlights = true }) {
                    Box {
                        Icon(Icons.Filled.Flight, "Flights", Modifier.size(20.dp))
                        if (flightWatchlists.isNotEmpty()) {
                            Text(
                                "${flightWatchlists.size}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.align(Alignment.TopEnd),
                            )
                        }
                    }
                }
                IconButton(onClick = { showVisibility = true }) { Icon(Icons.Outlined.Visibility, "Calendars", Modifier.size(20.dp)) }
            }

            var refreshing by remember { mutableStateOf(false) }
            androidx.compose.material3.pulltorefresh.PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    refreshing = true
                    scope.launch { runCatching { repo.reconcile() }; refreshing = false }
                },
                modifier = Modifier.weight(1f),
            ) {
            when (viewMode) {
                "month" -> CalMonthGrid(
                    events = events, calByKey = calByKey, calDefaults = calDefaults,
                    monthAnchorMs = anchorMs,
                    onOpen = { detailKey = it.compoundKey },
                    onCreateAt = { dayMs ->
                        val start = dayMs + 9 * 60 * 60 * 1000
                        formPrefill = start to (start + 60 * 60 * 1000)
                        showCreate = true
                    },
                    onJumpToDay = { day -> anchorMs = startOfDay(day); setView(context, "day") { viewMode = it } },
                )
                else -> {
                    val weekStart = if (viewMode == "day") startOfDay(anchorMs) else startOfWeek(anchorMs)
                    CalTimeGrid(
                        events = events, calByKey = calByKey, calDefaults = calDefaults,
                        weekStartMs = weekStart, numCols = if (viewMode == "day") 1 else 7,
                        onOpen = { detailKey = it.compoundKey },
                        onEdit = { edit ->
                            if (edit.kind == GridEdit.Kind.CREATE) {
                                formPrefill = edit.startMs to edit.endMs; showCreate = true
                            } else applyEdit(edit)
                        },
                        onLocationClick = { loc, day -> locationPick = loc to day },
                    )
                }
            }
            }
        }

        FloatingActionButton(
            onClick = { formPrefill = null; showCreate = true },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        ) { Icon(Icons.Filled.Add, "Create event") }

        undoRow?.let { row ->
            Snackbar(
                modifier = Modifier.align(Alignment.BottomCenter).padding(8.dp),
                action = {
                    TextButton(onClick = { scope.launch { repo.undoDelete(row) }; undoRow = null }) { Text("Undo") }
                },
            ) { Text("Deleted \"${row.summary}\"") }
        }
    }

    // ---- Create / edit form ---- //
    if (showCreate || editTarget != null) {
        val target = editTarget
        EventFormDialog(
            repo = repo,
            calendars = calendars,
            initial = target,
            defaultCalendarId = defaultCalId,
            prefillStart = formPrefill?.first,
            prefillEnd = formPrefill?.second,
            onDismiss = { showCreate = false; editTarget = null; formPrefill = null },
            onSubmit = { r ->
                showCreate = false; editTarget = null; formPrefill = null
                scope.launch {
                    if (target == null) {
                        repo.createEvent(
                            r.accountEmail, r.calendarId, r.summary, r.startMs, r.endMs, r.allDay,
                            r.location, r.description, r.guests,
                        )
                    } else {
                        repo.updateEvent(
                            target.compoundKey, r.summary, r.startMs, r.endMs, r.location, r.description,
                            r.guests, targetAccountEmail = r.accountEmail, targetCalendarId = r.calendarId,
                            scope = r.recurringScope,
                        )
                    }
                }
            },
        )
    }

    // ---- Detail sheet ---- //
    detailKey?.let { key ->
        val event = allEvents.firstOrNull { it.compoundKey == key }
        if (event == null) detailKey = null
        else EventDetailSheet(
            event = event,
            calendar = calByKey["${event.accountEmail}:${event.calendarId}"],
            calendarDefaults = calDefaults[event.calendarId] ?: emptyList(),
            onDismiss = { detailKey = null },
            onRsvp = { status -> scope.launch { repo.rsvp(event.compoundKey, status) } },
            onSetReminder = { minutes -> scope.launch { repo.setReminder(event.compoundKey, minutes) } },
            onEdit = { detailKey = null; editTarget = event },
            onDelete = { detailKey = null; deleteWithUndo(event) },
        )
    }

    // ---- Recurring edit scope dialog (drag move/resize of a recurring event) ---- //
    recurringEdit?.let { edit ->
        val e = edit.event!!
        RecurringScopeDialog(
            oldStart = e.startTime, oldEnd = e.endTime, newStart = edit.startMs, newEnd = edit.endMs,
            onCancel = { recurringEdit = null },
            onConfirm = { chosenScope ->
                recurringEdit = null
                scope.launch { repo.updateEvent(e.compoundKey, e.summary, edit.startMs, edit.endMs, e.location, scope = chosenScope) }
            },
        )
    }

    // ---- Working-location picker ---- //
    locationPick?.let { (loc, day) ->
        val knownOffices = events
            .mapNotNull { parseEventDetails(it.rawJson).workingLocation }
            .filter { it.type == "officeLocation" }
            .mapNotNull { it.label }
            .distinct().sorted()
        LocationPickerSheet(
            dayStartMs = day, currentEvent = loc, knownOffices = knownOffices,
            onDismiss = { locationPick = null },
            onPick = { type, label ->
                locationPick = null
                val account = loc?.accountEmail ?: accounts.firstOrNull { it.isPrimary }?.email ?: accounts.firstOrNull()?.email
                if (account != null) scope.launch {
                    repo.updateWorkingLocation(account, day, type, label, loc?.eventId)
                }
            },
        )
    }

    if (showVisibility) {
        CalendarSidebarSheet(
            calendars = calendars, accounts = accounts, hidden = hiddenCals, defaultCalendarId = defaultCalId,
            onToggle = { calKey ->
                // Toggle within the visible allow-list (all-visible when null).
                val current = visibleIds ?: calendars.map { it.id }.toSet()
                repo.setVisibleIds(if (calKey in current) current - calKey else current + calKey)
            },
            onSetDefault = { calId -> repo.setDefaultCalendar(calId) },
            onAddAccount = { showVisibility = false; openOAuth() },
            onRemoveAccount = { email -> scope.launch { repo.removeAccount(email); repo.getAccounts() } },
            onDismiss = { showVisibility = false },
        )
    }

    if (showMiniMonth) {
        MiniMonthPickerSheet(
            initialMs = anchorMs,
            onPick = { day -> anchorMs = startOfDay(day); showMiniMonth = false },
            onDismiss = { showMiniMonth = false },
        )
    }

    if (showFlights) {
        FlightsSheet(repo = flights, onDismiss = { showFlights = false })
    }
}

@Composable
private fun ViewChip(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, active: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .background(if (active) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent, RoundedCornerShape(6.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.labelMedium, fontWeight = if (active) FontWeight.Bold else FontWeight.Normal)
    }
}

@Composable
private fun RecurringScopeDialog(
    oldStart: Long, oldEnd: Long, newStart: Long, newEnd: Long,
    onCancel: () -> Unit, onConfirm: (String) -> Unit,
) {
    var scope by remember { mutableStateOf("single") }
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("Edit recurring event") },
        text = {
            Column {
                Row {
                    Text(
                        "${timeShort(oldStart)}–${timeShort(oldEnd)}",
                        style = MaterialTheme.typography.bodySmall,
                        textDecoration = TextDecoration.LineThrough,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text("  →  ${timeShort(newStart)}–${timeShort(newEnd)}", style = MaterialTheme.typography.bodySmall)
                }
                androidx.compose.foundation.layout.Spacer(Modifier.size(12.dp))
                ScopeRadio("This event", scope == "single") { scope = "single" }
                ScopeRadio("All events", scope == "all") { scope = "all" }
            }
        },
        confirmButton = { TextButton(onClick = { onConfirm(scope) }) { Text("Save event") } },
        dismissButton = { TextButton(onClick = onCancel) { Text("Discard change") } },
    )
}

@Composable
private fun ScopeRadio(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.material3.RadioButton(selected = selected, onClick = onClick)
        Text(label, style = MaterialTheme.typography.bodyMedium)
    }
}

private fun headerLabel(viewMode: String, anchorMs: Long): String = when (viewMode) {
    "day" -> dayNavLabel(startOfDay(anchorMs))
    "week" -> weekRangeLabel(startOfWeek(anchorMs))
    else -> monthLabel(anchorMs)
}

private fun setView(context: Context, v: String, apply: (String) -> Unit) {
    prefs(context).edit().putString(PREF_VIEW, v).apply()
    apply(v)
}

private fun firstOfMonth(ms: Long): Long {
    val c = Calendar.getInstance().apply { timeInMillis = ms }
    c.set(Calendar.DAY_OF_MONTH, 1)
    c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0)
    return c.timeInMillis
}
