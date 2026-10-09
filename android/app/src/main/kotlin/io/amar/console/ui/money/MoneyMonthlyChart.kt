package io.amar.console.ui.money

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.money.MoneyCategory
import io.amar.console.data.money.MoneyFormat
import io.amar.console.data.money.MoneyMonthly
import io.amar.console.data.money.MonthlySpend
import java.util.Locale

private val FALLBACK = Color(0xFF94A3B8)

/**
 * SPA `MonthlySpendChart` (Cashflow tab) on the phone: stacked bars per month by
 * category (£ or % of month), a 6/12/24/36-month window, tap a bar for that
 * month's breakdown (defaults to the newest month), then the trailing 3-month
 * average the projection's variable-spend forecast uses.
 */
@Composable
internal fun MonthlySpendSection(monthly: List<MonthlySpend>, cats: Map<String, MoneyCategory>) {
    var windowMonths by rememberSaveable { mutableStateOf(MoneyMonthly.DEFAULT_WINDOW) }
    var percent by rememberSaveable { mutableStateOf(false) }
    var selectedMonth by rememberSaveable { mutableStateOf<String?>(null) }

    SectionTitle("Monthly spend")
    val chart = remember(monthly, windowMonths) { MoneyMonthly.chart(monthly, windowMonths) }
    if (chart.rows.isEmpty()) {
        Hint("No spend history yet.")
        return
    }
    val selected = chart.rows.firstOrNull { it.month == selectedMonth } ?: chart.rows.last()
    val colors = remember(chart.categoryIds, cats) {
        chart.categoryIds.associateWith { parseCatColor(cats[it]?.color) ?: FALLBACK }
    }
    fun label(id: String) = cats[id]?.let { "${it.emoji} ${it.name}".trim() } ?: id

    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            FilterChip(selected = !percent, onClick = { percent = false }, label = { Text("£") })
            FilterChip(selected = percent, onClick = { percent = true }, label = { Text("%") })
            Spacer(Modifier.width(6.dp))
            for (n in MoneyMonthly.WINDOWS) {
                FilterChip(selected = windowMonths == n, onClick = { windowMonths = n }, label = { Text("${n}m") })
            }
        }
        val maxTotal = chart.rows.maxOf { it.totalPence }.coerceAtLeast(1L)
        Text(
            if (percent) "100%" else MoneyFormat.fmtPence(maxTotal, abs = true),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        StackedBars(
            chart = chart,
            colors = colors,
            percent = percent,
            selectedMonth = selected.month,
            onSelect = { selectedMonth = it },
        )
        // First / middle / last month under the bars — 36 labels would collide.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            val idx = listOf(0, chart.rows.size / 2, chart.rows.size - 1).distinct()
            for (i in idx) {
                Text(
                    MoneyFormat.fmtMonthShort(chart.rows[i].month),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Row(Modifier.padding(top = 8.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(MoneyFormat.fmtMonthLong(selected.month), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
            Text(MoneyFormat.fmtPence(selected.totalPence, abs = true), style = MaterialTheme.typography.labelMedium)
        }
        val rows = MoneyMonthly.breakdown(selected)
        if (rows.isEmpty()) Hint("No spend this month.", padded = false)
        for ((id, pence) in rows) {
            CategoryAmountRow(
                color = colors[id] ?: FALLBACK,
                label = label(id),
                amount = MoneyFormat.fmtPence(pence, abs = true),
                share = String.format(Locale.UK, "%.0f%%", selected.percent(id)),
            )
        }

        val forecast = remember(monthly) { MoneyMonthly.forecastRows(MoneyMonthly.trailingAverage(monthly)) }
        if (forecast.isNotEmpty()) {
            val total = forecast.sumOf { it.second }
            Text(
                "TRAILING 3-MO AVG (PROJECTION FORECAST) · ${MoneyFormat.fmtPence(total, abs = true)}/mo",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp, bottom = 2.dp),
            )
            for ((id, pence) in forecast) {
                CategoryAmountRow(
                    color = parseCatColor(cats[id]?.color) ?: FALLBACK,
                    label = label(id),
                    amount = MoneyFormat.fmtPence(pence, abs = true),
                    share = null,
                )
            }
        }
    }
}

@Composable
private fun StackedBars(
    chart: MoneyMonthly.Chart,
    colors: Map<String, Color>,
    percent: Boolean,
    selectedMonth: String,
    onSelect: (String) -> Unit,
) {
    val grid = MaterialTheme.colorScheme.outlineVariant
    val n = chart.rows.size
    val maxTotal = chart.rows.maxOf { it.totalPence }.coerceAtLeast(1L).toFloat()
    Canvas(
        Modifier
            .fillMaxWidth()
            .height(180.dp)
            .pointerInput(chart, n) {
                detectTapGestures { p ->
                    val i = (p.x / size.width * n).toInt().coerceIn(0, n - 1)
                    onSelect(chart.rows[i].month)
                }
            },
    ) {
        val w = size.width
        val h = size.height
        for (f in listOf(0f, 0.5f, 1f)) {
            val y = h - f * (h - 1f)
            drawLine(grid, Offset(0f, y), Offset(w, y), strokeWidth = 1f)
        }
        val slot = w / n
        val barW = (slot * 0.72f).coerceAtLeast(1f)
        chart.rows.forEachIndexed { i, row ->
            val dim = row.month != selectedMonth
            val x = i * slot + (slot - barW) / 2
            var top = h
            // Bottom-up in the chart's order: the biggest category sits on the axis.
            for (id in chart.categoryIds) {
                val v = row.byCategory[id] ?: 0L
                if (v <= 0) continue
                val frac = if (percent) row.percent(id).toFloat() / 100f else v / maxTotal
                val segH = frac * (h - 1f)
                top -= segH
                val c = colors[id] ?: FALLBACK
                drawRect(c.copy(alpha = if (dim) 0.45f else 0.9f), Offset(x, top), Size(barW, segH))
            }
        }
    }
}

@Composable
private fun CategoryAmountRow(color: Color, label: String, amount: String, share: String?) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).background(color, CircleShape))
        Spacer(Modifier.width(8.dp))
        Text(label, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (share != null) {
            Text(share, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = 8.dp))
        }
        Text(amount, style = MaterialTheme.typography.bodySmall)
    }
}
