package io.amar.console.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** Bottom-sheet snooze picker (SPA SnoozePicker parity) — ONE picker for every
 *  snoozable surface (chat rooms, Inbox items of any source). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SnoozeSheet(onDismiss: () -> Unit, onPick: (Long) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val timeFmt = remember { SimpleDateFormat("HH:mm", Locale.UK) }
    val laterToday = remember { io.amar.console.data.chat.SnoozeTimes.laterToday() }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Text("Snooze until", style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
        SnoozeOption("Later today", timeFmt.format(Date(laterToday))) { onPick(laterToday) }
        SnoozeOption("Tomorrow", "8:00") { onPick(io.amar.console.data.chat.SnoozeTimes.tomorrowMorning()) }
        SnoozeOption("Next week", "Mon 8:00") { onPick(io.amar.console.data.chat.SnoozeTimes.nextWeekMonday()) }
        androidx.compose.material3.HorizontalDivider(
            Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            color = MaterialTheme.colorScheme.outline,
        )
        SnoozeOption("Pick date & time", "") {
            val cal = Calendar.getInstance()
            android.app.DatePickerDialog(
                context,
                { _, y, m, d ->
                    android.app.TimePickerDialog(
                        context,
                        { _, h, min ->
                            cal.set(y, m, d, h, min, 0)
                            cal.set(Calendar.MILLISECOND, 0)
                            onPick(cal.timeInMillis)
                        },
                        cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE), true,
                    ).show()
                },
                cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH),
            ).show()
        }
        androidx.compose.foundation.layout.Spacer(Modifier.size(24.dp))
    }
}

@Composable
private fun SnoozeOption(label: String, description: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        if (description.isNotEmpty()) {
            Text(description, style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
