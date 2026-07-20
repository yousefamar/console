package io.amar.console.ui.cal

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.amar.console.data.cal.DAY_MS
import io.amar.console.data.cal.addMonthsClamped
import io.amar.console.data.cal.monthGridDays
import io.amar.console.data.cal.startOfDay
import java.util.Calendar

/**
 * Mini month/date-jump picker (42-cell Monday-start grid). Chevrons jump to the
 * prev/next month; tapping any day navigates the main view to it. Selected =
 * accent fill, today = bold, out-of-month = dimmed. Ports the sidebar mini
 * picker from CalendarSidebar.tsx.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MiniMonthPickerSheet(
    initialMs: Long,
    onPick: (Long) -> Unit,
    onDismiss: () -> Unit,
) {
    var monthAnchor by remember { mutableLongStateOf(initialMs) }
    val cal = Calendar.getInstance().apply { timeInMillis = monthAnchor }
    val days = monthGridDays(cal.get(Calendar.YEAR), cal.get(Calendar.MONTH))
    val today = startOfDay(System.currentTimeMillis())
    val selected = startOfDay(initialMs)

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { monthAnchor = addMonthsClamped(monthAnchor, -1) }) {
                    Icon(Icons.Filled.ChevronLeft, "Previous month")
                }
                Text(monthLabel(monthAnchor), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f), textAlign = TextAlign.Center)
                IconButton(onClick = { monthAnchor = addMonthsClamped(monthAnchor, 1) }) {
                    Icon(Icons.Filled.ChevronRight, "Next month")
                }
            }
            Row(Modifier.padding(vertical = 2.dp)) {
                for (d in listOf("M", "T", "W", "T", "F", "S", "S")) {
                    Text(d, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
                }
            }
            for (week in 0 until 6) {
                Row(Modifier.padding(vertical = 1.dp)) {
                    for (dow in 0 until 7) {
                        val dayMs = days[week * 7 + dow]
                        val dayCal = Calendar.getInstance().apply { timeInMillis = dayMs }
                        val inMonth = dayCal.get(Calendar.MONTH) == cal.get(Calendar.MONTH)
                        val isSelected = startOfDay(dayMs) == selected
                        val isToday = startOfDay(dayMs) == today
                        Box(
                            Modifier.weight(1f).padding(2.dp), contentAlignment = Alignment.Center,
                        ) {
                            Box(
                                Modifier
                                    .size(30.dp)
                                    .clip(CircleShape)
                                    .background(
                                        when {
                                            isSelected -> MaterialTheme.colorScheme.primary
                                            isToday -> MaterialTheme.colorScheme.surfaceVariant
                                            else -> Color.Transparent
                                        }
                                    )
                                    .clickable { onPick(dayMs) },
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    "${dayCal.get(Calendar.DAY_OF_MONTH)}",
                                    style = MaterialTheme.typography.labelMedium,
                                    fontWeight = if (isToday || isSelected) FontWeight.Bold else FontWeight.Normal,
                                    color = when {
                                        isSelected -> MaterialTheme.colorScheme.onPrimary
                                        !inMonth -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
                                        else -> MaterialTheme.colorScheme.onSurface
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
