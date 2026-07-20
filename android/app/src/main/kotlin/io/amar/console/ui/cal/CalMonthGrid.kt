package io.amar.console.ui.cal

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.outlined.CheckBoxOutlineBlank
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.cal.DAY_MS
import io.amar.console.data.cal.hasReminder
import io.amar.console.data.cal.isAccepted
import io.amar.console.data.cal.monthGridDays
import io.amar.console.data.cal.parseEventDetails
import io.amar.console.data.db.CalEventRow
import io.amar.console.data.db.CalendarRow
import java.util.Calendar

private const val LANE_CAP = 4       // pills shown before "+N more"

/**
 * Month view: 6-week Monday-anchored grid with spillover, per-day event pills
 * (time prefix + task/bell icons), today highlight, "+N more" → day view, and
 * tap-empty-cell → create 09:00–10:00 that day.
 */
@Composable
fun CalMonthGrid(
    events: List<CalEventRow>,
    calByKey: Map<String, CalendarRow>,
    calDefaults: Map<String, List<Int>>,
    monthAnchorMs: Long,               // any instant within the displayed month
    onOpen: (CalEventRow) -> Unit,
    onCreateAt: (Long) -> Unit,        // day-start ms; caller sets 09:00–10:00
    onJumpToDay: (Long) -> Unit,
) {
    val anchor = Calendar.getInstance().apply { timeInMillis = monthAnchorMs }
    val displayMonth = anchor.get(Calendar.MONTH)
    val days = monthGridDays(anchor.get(Calendar.YEAR), displayMonth)
    val today = System.currentTimeMillis()

    // Exclude working-location events (SPA parity).
    val visible = events.filter { parseEventDetails(it.rawJson).eventType != "workingLocation" }

    Column(Modifier.fillMaxSize()) {
        // Day-name header (single letters — mobile).
        Row(Modifier.fillMaxWidth()) {
            for (label in listOf("M", "T", "W", "T", "F", "S", "S")) {
                Text(
                    label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    modifier = Modifier.weight(1f).padding(vertical = 4.dp),
                )
            }
        }
        // 6 rows.
        for (week in 0 until 6) {
            Row(Modifier.fillMaxWidth().weight(1f)) {
                for (dow in 0 until 7) {
                    val dayMs = days[week * 7 + dow]
                    val dayEvents = visible.filter { it.startTime < dayMs + DAY_MS && it.endTime > dayMs }
                        .sortedWith(compareBy({ !it.isAllDay }, { it.startTime }))
                    MonthCell(
                        dayMs = dayMs,
                        inDisplayMonth = Calendar.getInstance().apply { timeInMillis = dayMs }.get(Calendar.MONTH) == displayMonth,
                        isToday = today in dayMs until (dayMs + DAY_MS),
                        events = dayEvents,
                        calByKey = calByKey,
                        calDefaults = calDefaults,
                        onOpen = onOpen,
                        onCreateAt = onCreateAt,
                        onJumpToDay = onJumpToDay,
                        modifier = Modifier.weight(1f).fillMaxSize(),
                    )
                }
            }
        }
    }
}

@Composable
private fun MonthCell(
    dayMs: Long,
    inDisplayMonth: Boolean,
    isToday: Boolean,
    events: List<CalEventRow>,
    calByKey: Map<String, CalendarRow>,
    calDefaults: Map<String, List<Int>>,
    onOpen: (CalEventRow) -> Unit,
    onCreateAt: (Long) -> Unit,
    onJumpToDay: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    val dayNum = Calendar.getInstance().apply { timeInMillis = dayMs }.get(Calendar.DAY_OF_MONTH)
    val overflow = (events.size - LANE_CAP).coerceAtLeast(0)
    Column(
        modifier
            .heightIn(min = 70.dp)
            .border(0.5.dp, MaterialTheme.colorScheme.surfaceVariant)
            .background(if (isToday) MaterialTheme.colorScheme.primary.copy(alpha = 0.05f) else Color.Transparent)
            .clickable { onCreateAt(dayMs) }
            .padding(2.dp),
    ) {
        // Day number: today → filled circle.
        Box(Modifier.padding(bottom = 1.dp)) {
            if (isToday) {
                Box(
                    Modifier.size(18.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("$dayNum", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimary)
                }
            } else {
                Text(
                    "$dayNum",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (inDisplayMonth) MaterialTheme.colorScheme.onSurface
                    else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                )
            }
        }
        for (e in events.take(LANE_CAP)) {
            MonthPill(e, calByKey, calDefaults, onOpen)
        }
        if (overflow > 0) {
            Text(
                "+$overflow more",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.clickable { onJumpToDay(dayMs) }.padding(start = 2.dp),
            )
        }
    }
}

@Composable
private fun MonthPill(
    e: CalEventRow,
    calByKey: Map<String, CalendarRow>,
    calDefaults: Map<String, List<Int>>,
    onOpen: (CalEventRow) -> Unit,
) {
    val details = parseEventDetails(e.rawJson)
    val accepted = isAccepted(details)
    val color = parseCalColor(calByKey[calKeyOf(e)]?.color)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 0.5.dp)
            .clip(RoundedCornerShape(3.dp))
            .background(if (accepted) color.copy(alpha = 0.3f) else Color.Transparent)
            .then(if (!accepted) Modifier.border(0.5.dp, color.copy(alpha = 0.7f), RoundedCornerShape(3.dp)) else Modifier)
            .clickable { onOpen(e) }
            .padding(horizontal = 2.dp, vertical = 0.5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(1.dp),
    ) {
        if (details.isTask) Icon(Icons.Outlined.CheckBoxOutlineBlank, null, Modifier.size(7.dp))
        if (!e.isAllDay) {
            Text(timeShort(e.startTime), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
        Text(e.summary, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (hasReminder(details.reminders, calDefaults[e.calendarId] ?: emptyList())) {
            Icon(Icons.Filled.Notifications, null, Modifier.size(7.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
