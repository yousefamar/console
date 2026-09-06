package io.amar.console.ui.longtail

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.amar.console.data.longtail.COST_DAYS_DEFAULT
import io.amar.console.data.longtail.COST_DAY_OPTIONS
import io.amar.console.data.longtail.CostReport
import io.amar.console.data.longtail.CostStackBy
import io.amar.console.data.longtail.HomeRepository
import io.amar.console.data.longtail.costColorArgb
import io.amar.console.data.longtail.costYTicks
import io.amar.console.data.longtail.fmtCostDay
import io.amar.console.data.longtail.fmtUsd
import io.amar.console.data.longtail.ownerLabel
import io.amar.console.data.longtail.personName
import io.amar.console.data.longtail.series
import io.amar.console.data.longtail.stackCosts
import io.amar.console.data.longtail.totals
import io.amar.console.data.longtail.unattributableRange
import kotlinx.coroutines.launch

/** Cost Explorer settles a few times a day; polling harder just bills more (SPA REFRESH_INTERVAL_MS). */
private const val COSTS_REFRESH_MS = 30 * 60 * 1000L

/**
 * Home → Costs: Bedrock spend per day stacked by person (or model), drawn with
 * a plain Compose Canvas — SPA CostsCard parity. Window + stack-by persist in
 * the same SharedPreferences as the Home sub-tab (the SPA keeps them in
 * localStorage, so device-local is the right tier).
 */
@Composable
internal fun CostsSection(repo: HomeRepository) {
    val state by repo.state.collectAsState()
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val prefs = remember { ctx.getSharedPreferences("home_view", android.content.Context.MODE_PRIVATE) }
    var days by remember {
        mutableIntStateOf(prefs.getInt("costDays", COST_DAYS_DEFAULT).let { if (it in COST_DAY_OPTIONS) it else COST_DAYS_DEFAULT })
    }
    var stackBy by remember {
        mutableStateOf(runCatching { CostStackBy.valueOf(prefs.getString("costStackBy", "OWNER")!!) }.getOrDefault(CostStackBy.OWNER))
    }
    fun setDays(d: Int) { days = d; prefs.edit().putInt("costDays", d).apply() }
    fun setStackBy(s: CostStackBy) { stackBy = s; prefs.edit().putString("costStackBy", s.name).apply() }

    LaunchedEffect(days) {
        repo.refreshCosts(days)
        while (true) { kotlinx.coroutines.delay(COSTS_REFRESH_MS); repo.refreshCosts(days) }
    }

    val report = state.costs
    val reportIsForWindow = report != null && state.costsDays == days

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Bedrock spend", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
            if (report != null && !report.empty && reportIsForWindow) {
                Text(
                    buildString {
                        append(fmtUsd(report.totalUsd))
                        if (report.hasAverage) append("  ·  ${fmtUsd(report.avgPerDayUsd)}/day")
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 8.dp).weight(1f),
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            } else Spacer(Modifier.weight(1f))
            IconButton(onClick = { scope.launch { repo.refreshCosts(days, force = true) } }, enabled = !state.costsLoading, modifier = Modifier.size(28.dp)) {
                Icon(Icons.Filled.Refresh, "Force a fresh Cost Explorer query (~\$0.01)", modifier = Modifier.size(16.dp))
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            ChipToggle("person", stackBy == CostStackBy.OWNER) { setStackBy(CostStackBy.OWNER) }
            ChipToggle("model", stackBy == CostStackBy.MODEL) { setStackBy(CostStackBy.MODEL) }
            Spacer(Modifier.weight(1f))
            for (d in COST_DAY_OPTIONS) ChipToggle("${d}d", d == days) { setDays(d) }
        }

        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            val err = state.costsError
            when {
                err != null && report == null -> {
                    Text("Cost Explorer unavailable", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                    Text(err, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp))
                }
                report == null -> Text(
                    if (state.costsLoading) "Querying AWS…" else "No data.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(12.dp),
                )
                report.empty -> Text(
                    "No Bedrock spend in the last $days days.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(12.dp),
                )
                else -> CostBody(report, stackBy, loadingNewWindow = !reportIsForWindow && state.costsLoading)
            }
        }
    }
}

@Composable
private fun ChipToggle(label: String, selected: Boolean, onClick: () -> Unit) {
    Text(
        label,
        style = MaterialTheme.typography.labelSmall,
        color = if (selected) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(if (selected) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 4.dp),
    )
}

@Composable
private fun CostBody(report: CostReport, stackBy: CostStackBy, loadingNewWindow: Boolean) {
    val series = report.series(stackBy)
    Column(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
        if (loadingNewWindow) {
            Text("Querying AWS…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp))
        }
        CostChart(report, stackBy, Modifier.fillMaxWidth().height(200.dp).padding(horizontal = 8.dp, vertical = 6.dp))
        // Legend — series in stacking order, labels resolved to people.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            LegendFlow(series.map { k -> (if (stackBy == CostStackBy.OWNER) report.personName(k) else k) to Color(costColorArgb(k, series)) })
        }

        BreakdownTable(
            title = "By person",
            order = report.owners,
            totals = report.totals(CostStackBy.OWNER),
            total = report.totalUsd,
            colorOf = if (stackBy == CostStackBy.OWNER) ({ k -> Color(costColorArgb(k, report.owners)) }) else null,
            labelOf = { report.ownerLabel(it) },
        )
        BreakdownTable(
            title = "By model",
            order = report.models,
            totals = report.totals(CostStackBy.MODEL),
            total = report.totalUsd,
            colorOf = if (stackBy == CostStackBy.MODEL) ({ k -> Color(costColorArgb(k, report.models)) }) else null,
            labelOf = { it },
        )

        val note = MaterialTheme.typography.labelSmall
        val noteColor = MaterialTheme.colorScheme.onSurfaceVariant
        if (report.regionAttributedUsd.isNotEmpty()) {
            Text(
                "~ = attributed by region rather than by the owner tag. Those workloads are the only Bedrock consumer in their region, so the split is exact even for days before they had a tagged inference profile.",
                style = note, color = noteColor, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            )
        }
        if ((report.totalByOwner["untagged"] ?: 0.0) > 0) {
            Text(
                "untagged = everything before ${fmtCostDay(report.ownerTagEpoch)}, when the owner tag was activated in Billing (cost-allocation tags don't backfill), plus any request that bypassed the per-person inference profiles. Everything this hub spawns is now tagged, so later untagged spend originates outside it.",
                style = note, color = noteColor, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            )
        }
    }
}

/** Legend entries wrapping onto multiple lines without FlowRow (kept simple:
 *  a Column of Rows filled greedily by character budget). */
@Composable
private fun LegendFlow(entries: List<Pair<String, Color>>) {
    val rows = remember(entries) {
        val out = mutableListOf<MutableList<Pair<String, Color>>>()
        var budget = 0
        for (e in entries) {
            val cost = e.first.length + 3
            if (out.isEmpty() || budget + cost > 44) { out.add(mutableListOf(e)); budget = cost } else { out.last().add(e); budget += cost }
        }
        out
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        for (row in rows) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                for ((label, color) in row) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Box(Modifier.size(8.dp).clip(RoundedCornerShape(1.dp)).background(color))
                        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

@Composable
private fun CostChart(report: CostReport, stackBy: CostStackBy, modifier: Modifier) {
    val stack = remember(report, stackBy) { stackCosts(report, stackBy) }
    val series = report.series(stackBy)
    val ticks = remember(stack.maxUsd) { costYTicks(stack.maxUsd) }
    val yMax = ticks.lastOrNull()?.takeIf { it > 0 } ?: stack.maxUsd
    val preEpoch = remember(report, stackBy) { unattributableRange(report, stackBy) }
    val measurer = rememberTextMeasurer()
    val axisColor = MaterialTheme.colorScheme.outlineVariant
    val labelColor = MaterialTheme.colorScheme.onSurfaceVariant
    val labelStyle = TextStyle(fontSize = 9.sp, color = labelColor)
    val colors = remember(series) { series.associateWith { Color(costColorArgb(it, series)) } }

    Canvas(modifier) {
        val n = stack.days.size
        if (n == 0) return@Canvas
        // Y-axis label gutter sized to the widest tick label.
        val tickLabels = ticks.map { measurer.measure(fmtUsd(it), labelStyle) }
        val gutter = (tickLabels.maxOfOrNull { it.size.width } ?: 0) + 6.dp.toPx()
        val xLabelH = 12.dp.toPx()
        val plotLeft = gutter
        val plotRight = size.width - 4.dp.toPx()
        val plotTop = 4.dp.toPx()
        val plotBottom = size.height - xLabelH
        val plotW = plotRight - plotLeft
        val plotH = plotBottom - plotTop
        if (plotW <= 0 || plotH <= 0) return@Canvas
        fun yOf(usd: Double): Float = (plotBottom - (usd / yMax) * plotH).toFloat()
        val slot = plotW / n
        val barW = (slot * 0.72f).coerceAtLeast(1f)

        // Pre-epoch shade: days with no per-person attribution.
        preEpoch?.let { r ->
            val x0 = plotLeft + r.first * slot
            val x1 = plotLeft + (r.last + 1) * slot
            drawRect(labelColor.copy(alpha = 0.08f), Offset(x0, plotTop), Size(x1 - x0, plotH))
            val lbl = measurer.measure("no attribution", labelStyle)
            if (lbl.size.width < x1 - x0) drawText(lbl, topLeft = Offset(x0 + 3.dp.toPx(), plotTop + 2.dp.toPx()))
        }

        // Gridlines + y labels.
        val dash = PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 4.dp.toPx()))
        ticks.forEachIndexed { i, t ->
            val y = yOf(t)
            drawLine(axisColor, Offset(plotLeft, y), Offset(plotRight, y), strokeWidth = 1f, pathEffect = if (i == 0) null else dash)
            val lbl = tickLabels[i]
            drawText(lbl, topLeft = Offset(plotLeft - lbl.size.width - 4.dp.toPx(), y - lbl.size.height / 2f))
        }

        // Stacked bars.
        stack.segments.forEachIndexed { i, segs ->
            val x = plotLeft + i * slot + (slot - barW) / 2f
            for (s in segs) {
                if (s.to <= s.from) continue
                val top = yOf(s.to)
                val bottom = yOf(s.from)
                drawRect(colors[s.key] ?: Color.Gray, Offset(x, top), Size(barW, (bottom - top).coerceAtLeast(0.5f)))
            }
        }

        // Average line over complete days.
        if (report.hasAverage && report.avgPerDayUsd > 0 && report.avgPerDayUsd <= yMax) {
            val y = yOf(report.avgPerDayUsd)
            drawLine(labelColor, Offset(plotLeft, y), Offset(plotRight, y), strokeWidth = 1f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx())))
            val lbl = measurer.measure("avg ${fmtUsd(report.avgPerDayUsd)}/day", labelStyle)
            drawText(lbl, topLeft = Offset(plotRight - lbl.size.width - 2.dp.toPx(), (y - lbl.size.height - 1.dp.toPx()).coerceAtLeast(plotTop)))
        }

        // X labels: as many dates as fit without overlap (min gap ~18dp, SPA minTickGap).
        val sample = measurer.measure(fmtCostDay(stack.days.first().date), labelStyle)
        val every = Math.ceil(((sample.size.width + 18.dp.toPx()) / slot).toDouble()).toInt().coerceAtLeast(1)
        for (i in 0 until n step every) {
            val lbl = measurer.measure(fmtCostDay(stack.days[i].date), labelStyle)
            val cx = plotLeft + i * slot + slot / 2f
            val x = (cx - lbl.size.width / 2f).coerceIn(plotLeft, plotRight - lbl.size.width)
            drawText(lbl, topLeft = Offset(x, plotBottom + 2.dp.toPx()))
        }
        drawLine(axisColor, Offset(plotLeft, plotTop), Offset(plotLeft, plotBottom), strokeWidth = 1f)
    }
}

@Composable
private fun BreakdownTable(
    title: String,
    order: List<String>,
    totals: Map<String, Double>,
    total: Double,
    colorOf: ((String) -> Color)?,
    labelOf: (String) -> String,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
        Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 2.dp))
        for (k in order) {
            val v = totals[k] ?: 0.0
            val pct = if (total > 0) v / total * 100 else 0.0
            Row(Modifier.fillMaxWidth().padding(vertical = 1.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (colorOf != null) Box(Modifier.size(8.dp).clip(RoundedCornerShape(1.dp)).background(colorOf(k)))
                Text(
                    labelOf(k), style = MaterialTheme.typography.bodySmall,
                    color = if (k == "untagged") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text("${Math.round(pct)}%", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(fmtUsd(v), style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(64.dp), textAlign = androidx.compose.ui.text.style.TextAlign.End)
            }
        }
    }
}
