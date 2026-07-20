package io.amar.console.ui.cal

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.cal.CalendarRepository
import io.amar.console.data.cal.parseEventDetails
import io.amar.console.data.db.CalEventRow
import io.amar.console.data.db.CalendarRow
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** Result of the event form: the caller performs the create/update. */
data class EventFormResult(
    val accountEmail: String,
    val calendarId: String,
    val summary: String,
    val startMs: Long,
    val endMs: Long,
    val allDay: Boolean,
    val location: String?,
    val description: String?,
    val guests: List<String>,
    val recurringScope: String,       // single | all (edit of a recurring event)
)

@Composable
fun EventFormDialog(
    repo: CalendarRepository,
    calendars: List<CalendarRow>,
    initial: CalEventRow?,
    defaultCalendarId: String?,
    prefillStart: Long? = null,
    prefillEnd: Long? = null,
    onDismiss: () -> Unit,
    onSubmit: (EventFormResult) -> Unit,
) {
    val context = LocalContext.current
    val writable = remember(calendars) {
        calendars.filter { it.accessRole == "owner" || it.accessRole == "writer" }
    }
    val editing = initial != null
    val initialDetails = remember(initial?.rawJson) { initial?.let { parseEventDetails(it.rawJson) } }
    val isRecurring = initialDetails?.isRecurring == true

    var summary by remember { mutableStateOf(initial?.summary ?: "") }
    var location by remember { mutableStateOf(initial?.location ?: "") }
    var description by remember { mutableStateOf(initialDetails?.description ?: "") }
    var allDay by remember { mutableStateOf(initial?.isAllDay ?: false) }
    var startMs by remember { mutableLongStateOf(initial?.startTime ?: prefillStart ?: nextHour()) }
    var endMs by remember { mutableLongStateOf(initial?.endTime ?: prefillEnd ?: ((prefillStart ?: nextHour()) + 60 * 60 * 1000)) }
    // Guests: pre-fill existing attendees excluding self, "Name <email>, " joined.
    var guests by remember {
        mutableStateOf(
            initialDetails?.attendees.orEmpty()
                .filterNot { it.self }
                .joinToString(", ") { a -> if (a.displayName.isNullOrBlank()) a.email else "${a.displayName} <${a.email}>" }
        )
    }
    var selectedCal by remember {
        mutableStateOf(
            initial?.let { calKeyOf(it) }
                ?: defaultCalendarId?.let { def -> writable.firstOrNull { it.calendarId == def }?.let { calKeyOf(it) } }
                ?: writable.firstOrNull { it.calendarId == it.accountEmail }?.let { calKeyOf(it) }
                ?: writable.firstOrNull()?.let { calKeyOf(it) }
                ?: "",
        )
    }
    var showCalPicker by remember { mutableStateOf(false) }
    var scope by remember { mutableStateOf("single") }

    // Contact autocomplete against the current guests token.
    var suggestions by remember { mutableStateOf<List<CalendarRepository.Contact>>(emptyList()) }
    val currentToken = guests.substringAfterLast(",").trim()
    LaunchedEffect(currentToken) {
        if (currentToken.length < 2 || currentToken.contains("<")) { suggestions = emptyList(); return@LaunchedEffect }
        delay(150)
        suggestions = repo.searchContacts(currentToken).take(6)
    }

    fun pickDateTime(current: Long, dateOnly: Boolean, onPicked: (Long) -> Unit) =
        showDateTimePicker(context, current, dateOnly, onPicked)

    val dtFmt = remember { SimpleDateFormat("EEE d MMM HH:mm", Locale.UK) }
    val dFmt = remember { SimpleDateFormat("EEE d MMM", Locale.UK) }
    fun fmt(ms: Long) = if (allDay) dFmt.format(Date(ms)) else dtFmt.format(Date(ms))

    val selCal = writable.firstOrNull { calKeyOf(it) == selectedCal }
    val guestList = guests.split(",").map { it.trim() }.filter { it.isNotEmpty() }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (editing) "Edit event" else "New event") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = summary, onValueChange = { summary = it },
                    label = { Text("Title") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("All day", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    Switch(checked = allDay, onCheckedChange = { allDay = it })
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Starts", style = MaterialTheme.typography.labelMedium, modifier = Modifier.width(52.dp))
                    TextButton(onClick = {
                        pickDateTime(startMs, allDay) { picked ->
                            val dur = endMs - startMs
                            startMs = picked
                            endMs = picked + dur // preserve duration; bumps end if it fell earlier
                        }
                    }) { Text(fmt(startMs)) }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Ends", style = MaterialTheme.typography.labelMedium, modifier = Modifier.width(52.dp))
                    TextButton(onClick = {
                        pickDateTime(endMs, allDay) { picked -> if (picked > startMs) endMs = picked }
                    }) { Text(fmt(endMs)) }
                }
                OutlinedTextField(
                    value = location, onValueChange = { location = it },
                    label = { Text("Location") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = guests, onValueChange = { guests = it },
                    label = { Text("Guests") },
                    placeholder = { Text("Name <email>, …") },
                    modifier = Modifier.fillMaxWidth(),
                )
                if (suggestions.isNotEmpty()) {
                    Column(Modifier.heightIn(max = 140.dp).verticalScroll(rememberScrollState())) {
                        for (c in suggestions) {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        val prefix = guests.substringBeforeLast(",", "")
                                        val token = if (c.name.isNotBlank()) "${c.name} <${c.email}>" else c.email
                                        guests = (if (prefix.isBlank()) "" else "$prefix, ") + token + ", "
                                        suggestions = emptyList()
                                    }
                                    .padding(vertical = 6.dp, horizontal = 4.dp),
                            ) {
                                Text(
                                    if (c.name.isNotBlank()) "${c.name} · ${c.email}" else c.email,
                                    style = MaterialTheme.typography.bodySmall,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
                if (guestList.isNotEmpty()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Videocam, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.width(4.dp))
                        Text("Google Meet will be added", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                OutlinedTextField(
                    value = description, onValueChange = { description = it },
                    label = { Text("Description") }, modifier = Modifier.fillMaxWidth(),
                    minLines = 2, maxLines = 4,
                )
                // Calendar picker (only when >1 writable, or moving in edit mode).
                if (writable.size > 1) {
                    Row(
                        Modifier.fillMaxWidth().clickable { showCalPicker = !showCalPicker },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(parseCalColor(selCal?.color)))
                        Text(selCal?.name ?: "Pick calendar", style = MaterialTheme.typography.bodyMedium)
                    }
                    if (showCalPicker) {
                        Column {
                            for (c in writable) {
                                val key = calKeyOf(c)
                                Row(
                                    Modifier.fillMaxWidth().clickable { selectedCal = key; showCalPicker = false }.padding(vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(parseCalColor(c.color)))
                                    Text(c.name, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                                    if (key == defaultCalendarId?.let { "${c.accountEmail}:$it" }) Icon(Icons.Filled.Star, "Default", Modifier.size(12.dp), tint = MaterialTheme.colorScheme.primary)
                                    if (key == selectedCal) Icon(Icons.Filled.Check, null, Modifier.size(14.dp))
                                }
                            }
                        }
                    }
                }
                // Recurring edit scope.
                if (editing && isRecurring) {
                    Text("This is a recurring event", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ScopeChip("This event", scope == "single") { scope = "single" }
                        ScopeChip("All events", scope == "all") { scope = "all" }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val cal = writable.firstOrNull { calKeyOf(it) == selectedCal } ?: return@Button
                    onSubmit(
                        EventFormResult(
                            accountEmail = cal.accountEmail,
                            calendarId = cal.calendarId,
                            summary = summary.trim(),
                            startMs = startMs, endMs = endMs, allDay = allDay,
                            location = location.trim().ifEmpty { null },
                            description = description.trim().ifEmpty { null },
                            guests = guestList,
                            recurringScope = scope,
                        )
                    )
                },
                enabled = summary.isNotBlank() && selectedCal.isNotEmpty() && (allDay || endMs > startMs),
            ) { Text(if (editing) "Save changes" else "Create event") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun ScopeChip(label: String, active: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .clip(RoundedCornerShape(16.dp))
            .background(if (active) MaterialTheme.colorScheme.primaryContainer else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) { Text(label, style = MaterialTheme.typography.labelMedium) }
}

/** Native date-then-time picker (or date-only for all-day). */
fun showDateTimePicker(context: Context, current: Long, dateOnly: Boolean, onPicked: (Long) -> Unit) {
    val cal = Calendar.getInstance().apply { timeInMillis = current }
    android.app.DatePickerDialog(
        context,
        { _, y, m, d ->
            if (dateOnly) {
                cal.set(y, m, d); cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
                onPicked(cal.timeInMillis)
            } else {
                android.app.TimePickerDialog(
                    context,
                    { _, h, min ->
                        cal.set(y, m, d, h, min, 0); cal.set(Calendar.MILLISECOND, 0)
                        onPicked(cal.timeInMillis)
                    },
                    cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE), true,
                ).show()
            }
        },
        cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH),
    ).show()
}
