package io.amar.console.ui.cal

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.outlined.CheckBoxOutlineBlank
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.amar.console.data.cal.DAY_MS
import io.amar.console.data.cal.LaneInfo
import io.amar.console.data.cal.MergedEvent
import io.amar.console.data.cal.QUARTER_MS
import io.amar.console.data.cal.hasReminder
import io.amar.console.data.cal.isAccepted
import io.amar.console.data.cal.mergeDuplicates
import io.amar.console.data.cal.packAllDayBars
import io.amar.console.data.cal.packLanes
import io.amar.console.data.cal.parseEventDetails
import io.amar.console.data.cal.snapToQuarter
import io.amar.console.data.db.CalEventRow
import io.amar.console.data.db.CalendarRow

/** A pending drag-to-create/move/resize selection surfaced to the caller. */
data class GridEdit(
    val kind: Kind,
    val event: CalEventRow?,          // null for create
    val startMs: Long,
    val endMs: Long,
) {
    enum class Kind { CREATE, MOVE, RESIZE }
}

private const val HOUR_DP = 56          // dp-per-hour
private const val GUTTER_DP = 44
private const val ALLDAY_ROW_DP = 20

/**
 * The 7-column week grid (or 1-column day grid). 24 hourly rows, now-line,
 * all-day spanning bars, working-location row, variable-width lane packing,
 * cross-calendar duplicate merge, and long-press drag to create/move/resize
 * with 15-min snapping.
 */
@Composable
fun CalTimeGrid(
    events: List<CalEventRow>,
    calByKey: Map<String, CalendarRow>,
    calDefaults: Map<String, List<Int>>,
    weekStartMs: Long,
    numCols: Int,                     // 7 for week, 1 for day
    onOpen: (CalEventRow) -> Unit,
    onEdit: (GridEdit) -> Unit,
    onLocationClick: (CalEventRow?, Long) -> Unit,
) {
    fun colorHex(e: CalEventRow) = calByKey[calKeyOf(e)]?.color ?: "#3b82f6"
    fun writable(e: CalEventRow): Boolean {
        val r = calByKey[calKeyOf(e)]?.accessRole
        return r == "owner" || r == "writer"
    }

    fun typeOf(e: CalEventRow) = parseEventDetails(e.rawJson).eventType
    val allDay = events.filter { it.isAllDay && typeOf(it) != "workingLocation" }
    val working = events.filter { typeOf(it) == "workingLocation" }
    val timed = events.filter { !it.isAllDay && typeOf(it) != "workingLocation" }

    Column(Modifier.fillMaxSize()) {
        DayHeaderRow(weekStartMs, numCols)
        if (working.isNotEmpty()) WorkingLocationRow(working, weekStartMs, numCols, onLocationClick)
        if (allDay.isNotEmpty()) AllDayBarsRow(allDay, ::colorHex, weekStartMs, numCols, onOpen)

        val scroll = rememberScrollState()
        BoxWithConstraints(
            Modifier.fillMaxSize().verticalScroll(scroll),
        ) {
            val totalWidth = maxWidth
            val colWidth = (totalWidth - GUTTER_DP.dp) / numCols
            val gridHeight = (24 * HOUR_DP).dp
            val minuteDp = HOUR_DP.dp / 60f

            Box(
                Modifier
                    .width(totalWidth)
                    .height(gridHeight)
                    .dragToCreate(weekStartMs, numCols, colWidth, minuteDp, onEdit),
            ) {
                // Hour lines + gutter labels.
                for (h in 0..23) {
                    Row(
                        Modifier.fillMaxWidth().offset(y = (h * HOUR_DP).dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Text(
                            if (h == 0) "" else "%02d:00".format(h),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.width(GUTTER_DP.dp).padding(start = 6.dp),
                        )
                        HorizontalDivider(
                            Modifier.weight(1f).padding(top = 7.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant,
                        )
                    }
                }

                // Per-day lane packing + event blocks.
                for (col in 0 until numCols) {
                    val colStart = weekStartMs + col * DAY_MS
                    val colEnd = colStart + DAY_MS
                    val inCol = timed.filter { it.startTime < colEnd && it.endTime > colStart }
                    val merged = mergeDuplicates(
                        inCol,
                        colorOf = ::colorHex,
                        ownedBy = { it.calendarId == it.accountEmail },
                        acceptedOf = { isAccepted(parseEventDetails(it.rawJson)) },
                    )
                    val lanes = packLanes(merged.map { it.primary })
                    for (m in merged) {
                        val lane = lanes[m.primary.compoundKey] ?: LaneInfo(0, 1)
                        val laneWidth = colWidth / lane.laneCount
                        val x = GUTTER_DP.dp + colWidth * col + laneWidth * lane.lane
                        EventBlock(
                            merged = m,
                            xDp = x,
                            widthDp = laneWidth,
                            colStart = colStart,
                            minuteDp = minuteDp,
                            calDefaults = calDefaults[m.primary.calendarId] ?: emptyList(),
                            writable = writable(m.primary),
                            colWidth = colWidth,
                            numCols = numCols,
                            weekStartMs = weekStartMs,
                            onOpen = onOpen,
                            onEdit = onEdit,
                        )
                    }
                }

                // Now line.
                val now = System.currentTimeMillis()
                if (now in weekStartMs until (weekStartMs + numCols * DAY_MS)) {
                    val col = ((now - weekStartMs) / DAY_MS).toInt()
                    val minInDay = ((now - (weekStartMs + col * DAY_MS)) / 60000L).toInt()
                    Row(
                        Modifier
                            .offset(x = GUTTER_DP.dp + colWidth * col, y = minuteDp * minInDay)
                            .width(colWidth),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(8.dp).clip(RoundedCornerShape(4.dp)).background(MaterialTheme.colorScheme.error))
                        HorizontalDivider(Modifier.weight(1f), thickness = 2.dp, color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }
}

@Composable
private fun DayHeaderRow(weekStartMs: Long, numCols: Int) {
    val today = System.currentTimeMillis()
    Row(Modifier.fillMaxWidth().padding(start = GUTTER_DP.dp)) {
        for (col in 0 until numCols) {
            val dayMs = weekStartMs + col * DAY_MS
            val isToday = today in dayMs until (dayMs + DAY_MS)
            Column(
                Modifier
                    .weight(1f)
                    .background(if (isToday) MaterialTheme.colorScheme.primary.copy(alpha = 0.06f) else Color.Transparent)
                    .padding(vertical = 2.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    fmt(dayMs, "EEE"),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (isToday) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    fmt(dayMs, "d"),
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = if (isToday) FontWeight.Bold else FontWeight.Normal,
                    color = if (isToday) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

@Composable
private fun WorkingLocationRow(
    working: List<CalEventRow>,
    weekStartMs: Long,
    numCols: Int,
    onLocationClick: (CalEventRow?, Long) -> Unit,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(GUTTER_DP.dp), contentAlignment = Alignment.CenterEnd) {
            Icon(Icons.Outlined.LocationOn, "Working location", Modifier.size(12.dp).padding(end = 2.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        for (col in 0 until numCols) {
            val dayMs = weekStartMs + col * DAY_MS
            val loc = working.firstOrNull { it.startTime < dayMs + DAY_MS && it.endTime > dayMs }
            Box(
                Modifier
                    .weight(1f)
                    .clickable { onLocationClick(loc, dayMs) }
                    .padding(horizontal = 3.dp, vertical = 2.dp),
            ) {
                if (loc != null) {
                    Text(
                        workingLocationLabel(loc),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                } else {
                    Text("—", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.3f))
                }
            }
        }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
}

@Composable
private fun AllDayBarsRow(
    allDay: List<CalEventRow>,
    colorHex: (CalEventRow) -> String,
    weekStartMs: Long,
    numCols: Int,
    onOpen: (CalEventRow) -> Unit,
) {
    val bars = packAllDayBars(allDay, weekStartMs, numCols)
    val rows = (bars.maxOfOrNull { it.row } ?: -1) + 1
    Row(Modifier.fillMaxWidth()) {
        Spacer(Modifier.width(GUTTER_DP.dp))
        BoxWithConstraints(Modifier.weight(1f).height((rows * ALLDAY_ROW_DP).dp)) {
            val colWidth = maxWidth / numCols
            for (bar in bars) {
                val details = parseEventDetails(bar.event.rawJson)
                val accepted = isAccepted(details)
                val color = parseCalColor(colorHex(bar.event))
                val span = bar.endCol - bar.startCol + 1
                Box(
                    Modifier
                        .offset(x = colWidth * bar.startCol, y = (bar.row * ALLDAY_ROW_DP).dp)
                        .width(colWidth * span)
                        .height(18.dp)
                        .padding(horizontal = 1.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(if (accepted) color.copy(alpha = 0.3f) else Color.Transparent)
                        .then(if (!accepted) Modifier.border(1.dp, color.copy(alpha = 0.7f), RoundedCornerShape(4.dp)) else Modifier)
                        .clickable { onOpen(bar.event) }
                        .padding(horizontal = 5.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    Text(bar.event.summary, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
}

@Composable
private fun EventBlock(
    merged: MergedEvent,
    xDp: Dp,
    widthDp: Dp,
    colStart: Long,
    minuteDp: Dp,
    calDefaults: List<Int>,
    writable: Boolean,
    colWidth: Dp,
    numCols: Int,
    weekStartMs: Long,
    onOpen: (CalEventRow) -> Unit,
    onEdit: (GridEdit) -> Unit,
) {
    val e = merged.primary
    val colEnd = colStart + DAY_MS
    val startMin = ((maxOf(e.startTime, colStart) - colStart) / 60000L).toInt()
    val endMin = ((minOf(e.endTime, colEnd) - colStart) / 60000L).toInt()
    val heightMin = maxOf(endMin - startMin, 15)
    val details = parseEventDetails(e.rawJson)
    val accepted = merged.accepted
    val color = parseCalColor(merged.colors.firstOrNull())
    val density = LocalDensity.current
    val minutePx = with(density) { minuteDp.toPx() }
    val colWidthPx = with(density) { colWidth.toPx() }

    Box(
        Modifier
            .offset(x = xDp, y = minuteDp * startMin)
            .width(widthDp)
            .height(minuteDp * heightMin)
            .padding(horizontal = 1.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(if (accepted) color.copy(alpha = 0.3f) else Color.Transparent)
            .then(if (!accepted) Modifier.border(1.dp, color.copy(alpha = 0.7f), RoundedCornerShape(4.dp)) else Modifier)
            .pointerInput(e.compoundKey) { detectTapGestures(onTap = { onOpen(e) }) }
            .then(
                if (writable) Modifier.pointerInput(e.compoundKey) {
                    var dx = 0f
                    var dy = 0f
                    detectDragGesturesAfterLongPress(
                        onDragStart = { dx = 0f; dy = 0f },
                        onDragEnd = {
                            val deltaMin = (dy / minutePx).toLong()
                            val colDelta = Math.round(dx / colWidthPx)
                            val timeDelta = snapToQuarter(deltaMin * 60_000L)
                            // Cross-day: shift by whole days from column movement.
                            val curCol = ((e.startTime - weekStartMs) / DAY_MS).toInt()
                            val newCol = (curCol + colDelta).coerceIn(0, numCols - 1)
                            val dayShift = (newCol - curCol) * DAY_MS
                            val total = timeDelta + dayShift
                            if (total != 0L) {
                                onEdit(GridEdit(GridEdit.Kind.MOVE, e, e.startTime + total, e.endTime + total))
                            }
                        },
                    ) { change, delta -> change.consume(); dx += delta.x; dy += delta.y }
                } else Modifier
            ),
    ) {
        Column(Modifier.fillMaxSize().padding(horizontal = 6.dp, vertical = 2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (details.isTask) {
                    Icon(Icons.Outlined.CheckBoxOutlineBlank, "Task", Modifier.size(9.dp))
                    Spacer(Modifier.width(2.dp))
                }
                Text(
                    e.summary,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Medium,
                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (hasReminder(details.reminders, calDefaults)) {
                    Spacer(Modifier.width(2.dp))
                    Icon(Icons.Filled.Notifications, "Reminder", Modifier.size(9.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (heightMin > 30) {
                Text(
                    "${timeShort(e.startTime)}–${timeShort(e.endTime)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
                )
            }
            if (heightMin > 50 && !e.location.isNullOrBlank()) {
                Text(
                    e.location!!, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // Bottom resize handle (writable only) — long-press-drag adjusts end only.
        if (writable) {
            Box(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(8.dp)
                    .pointerInput(e.compoundKey) {
                        var dy = 0f
                        detectDragGesturesAfterLongPress(
                            onDragStart = { dy = 0f },
                            onDragEnd = {
                                val deltaMs = snapToQuarter((dy / minutePx).toLong() * 60_000L)
                                val newEnd = e.endTime + deltaMs
                                // Min height one snap.
                                if (newEnd - e.startTime >= QUARTER_MS && deltaMs != 0L) {
                                    onEdit(GridEdit(GridEdit.Kind.RESIZE, e, e.startTime, newEnd))
                                }
                            },
                        ) { change, delta -> change.consume(); dy += delta.y }
                    },
            )
        }
    }
}

/** Long-press on empty grid → create. Snaps to 15-min; drags < one snap ignored. */
private fun Modifier.dragToCreate(
    weekStartMs: Long,
    numCols: Int,
    colWidth: Dp,
    minuteDp: Dp,
    onEdit: (GridEdit) -> Unit,
): Modifier = this.pointerInput(weekStartMs, numCols) {
    val gutterPx = GUTTER_DP.dp.toPx()
    val colWidthPx = colWidth.toPx()
    val minutePx = minuteDp.toPx()
    var startY = 0f
    var startX = 0f
    var curY = 0f
    detectDragGesturesAfterLongPress(
        onDragStart = { off -> startY = off.y; startX = off.x; curY = off.y },
        onDragEnd = {
            val col = (((startX - gutterPx) / colWidthPx).toInt()).coerceIn(0, numCols - 1)
            val dayStart = weekStartMs + col * DAY_MS
            val startMin = (startY / minutePx).toLong()
            val endMin = (curY / minutePx).toLong()
            val a = snapToQuarter(dayStart + minOf(startMin, endMin) * 60_000L)
            val b = snapToQuarter(dayStart + maxOf(startMin, endMin) * 60_000L)
            if (b - a >= QUARTER_MS) onEdit(GridEdit(GridEdit.Kind.CREATE, null, a, b))
        },
    ) { change, delta -> change.consume(); curY += delta.y }
}

fun workingLocationLabel(e: CalEventRow): String {
    val w = parseEventDetails(e.rawJson).workingLocation
    return when (w?.type) {
        "homeOffice" -> "Home"
        "officeLocation" -> w.label ?: "Office"
        "customLocation" -> w.label ?: "Custom"
        else -> e.summary.takeIf { it.isNotBlank() && it != "(no title)" } ?: "Home"
    }
}

private fun fmt(ms: Long, pattern: String) =
    java.text.SimpleDateFormat(pattern, java.util.Locale.UK).format(java.util.Date(ms))
