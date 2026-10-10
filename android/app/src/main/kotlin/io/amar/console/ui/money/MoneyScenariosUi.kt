package io.amar.console.ui.money

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.money.MoneyCategory
import io.amar.console.data.money.MoneyFormat
import io.amar.console.data.money.MoneyRepository
import io.amar.console.data.money.MoneyScenarios
import io.amar.console.data.money.Scenario
import io.amar.console.data.money.ScenarioDelta
import io.amar.console.data.money.SharedTabBalance
import io.amar.console.data.money.StreamRef
import io.amar.console.ui.cal.showDateTimePicker
import io.amar.console.ui.theme.accents
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.abs
import kotlin.math.roundToInt

private val GREEN: Color @Composable @ReadOnlyComposable get() = MaterialTheme.accents.green
private val RED: Color @Composable @ReadOnlyComposable get() = MaterialTheme.accents.red

// ---------------------------------------------------------------------- //
// Shared tabs (SPA SharedTabPanel, Cashflow tab)

/** What each counterparty owes on shared spend, net of what they sent back. Tap a row for the working. */
@Composable
internal fun SharedTabsSection(tabs: List<SharedTabBalance>) {
    var open by rememberSaveable { mutableStateOf<String?>(null) }
    SectionTitle("Shared tabs")
    if (tabs.isEmpty()) {
        Hint("No shared-tab activity yet.")
        return
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (b in tabs) {
            val isOpen = open == b.counterparty
            val tone = when {
                b.netOwedToYouPence > 0 -> GREEN
                b.netOwedToYouPence < 0 -> RED
                else -> MaterialTheme.colorScheme.onSurfaceVariant
            }
            Column(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(6.dp))) {
                Row(
                    Modifier.fillMaxWidth().clickable { open = if (isOpen) null else b.counterparty }.padding(horizontal = 10.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        if (isOpen) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowRight, null,
                        Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(b.counterparty, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(b.summary, style = MaterialTheme.typography.labelMedium, color = tone)
                }
                if (isOpen) Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp).padding(bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    TabLine("Their share (you covered)", MoneyFormat.fmtPence(b.theyOwePence, abs = true))
                    TabLine("Their reimbursements to you", MoneyFormat.fmtPence(b.theyPaidPence, abs = true))
                    TabLine("Net", MoneyFormat.fmtPence(b.netOwedToYouPence, abs = true), tone)
                    Text(
                        "Activity ${b.oldestSharedDate ?: "—"} → ${b.latestSharedDate ?: "—"}",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (b.sampleShared.isNotEmpty()) {
                        SampleHeader("RECENT SHARED EXPENSES (${b.sampleShared.size})")
                        for (s in b.sampleShared) SampleRow(
                            s.date, s.merchant,
                            "gross ${MoneyFormat.fmtPence(s.grossPence, abs = true)}",
                            "+${MoneyFormat.fmtPence(s.theirSharePence, abs = true)}", GREEN,
                        )
                    }
                    if (b.sampleReimbursements.isNotEmpty()) {
                        SampleHeader("RECENT REIMBURSEMENTS FROM THEM (${b.sampleReimbursements.size})")
                        for (r in b.sampleReimbursements) SampleRow(
                            r.date, r.note.ifBlank { "—" }, null,
                            "-${MoneyFormat.fmtPence(r.amountPence, abs = true)}", RED,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TabLine(label: String, value: String, color: Color = MaterialTheme.colorScheme.onSurface) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodySmall, color = color)
    }
}

@Composable
private fun SampleHeader(text: String) {
    Text(text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
}

/** One `AnnotatedString`-free row: the long text takes the weight, the figures keep their width. */
@Composable
private fun SampleRow(date: String, label: String, middle: String?, amount: String, amountColor: Color) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(date, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(label, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (middle != null) Text(middle, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        Text(amount, style = MaterialTheme.typography.bodySmall, color = amountColor, maxLines = 1)
    }
}

// ---------------------------------------------------------------------- //
// Scenarios (SPA ScenariosView)

/** Which scenario editor is up. */
internal sealed interface ScenarioSheet {
    object New : ScenarioSheet

    /** Keyed by id, not a snapshot, so a reconcile landing under it re-renders from state. */
    data class Edit(val id: String) : ScenarioSheet
}

internal fun MoneyRepository.State.scenarioFor(sheet: ScenarioSheet.Edit): Scenario? =
    scenarios.firstOrNull { it.id == sheet.id }

/** The comparison chart over the saved scenarios, then one row per scenario (tap to edit). */
@Composable
internal fun ScenariosSection(state: MoneyRepository.State, onOpen: (Scenario) -> Unit) {
    val comparison = remember(state.trajectory, state.scenarioOverlays, state.scenarios, state.projection) { state.comparison }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        if (comparison.isEmpty) Hint("No projection data yet.", padded = false)
        else ComparisonChart(comparison)

        if (state.scenarios.isEmpty()) Hint("No scenarios yet.", padded = false)
        state.scenarios.forEachIndexed { i, s ->
            Row(
                Modifier.fillMaxWidth().clickable { onOpen(s) }.padding(vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(8.dp).background(Color(MoneyScenarios.colorFor(i)), CircleShape))
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(s.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val sub = listOfNotNull(MoneyScenarios.deltaCount(s), s.description).joinToString(" · ")
                    Text(sub, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                MoneyScenarios.endLabel(state.scenarioOverlays[s.id])?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
                }
            }
        }
    }
}

/**
 * Liquid balance per month, baseline + every scenario, with the emergency
 * floor dashed. A phone has no hover: tap the chart to pick a month and the
 * legend below reads each line's value there (it starts on the last month).
 */
@Composable
private fun ComparisonChart(c: MoneyScenarios.Comparison) {
    var picked by rememberSaveable { mutableStateOf<Int?>(null) }
    val n = c.months.size
    val sel = (picked ?: (n - 1)).coerceIn(0, n - 1)
    val grid = MaterialTheme.colorScheme.outlineVariant
    val faint = MaterialTheme.colorScheme.onSurfaceVariant
    val red = RED
    val lo = c.minPence
    val hi = if (c.maxPence == lo) lo + 1 else c.maxPence

    Text(MoneyFormat.fmtPence(hi), style = MaterialTheme.typography.labelSmall, color = faint)
    Canvas(
        Modifier.fillMaxWidth().height(180.dp).pointerInput(n) {
            detectTapGestures { p ->
                picked = if (n <= 1) 0 else (p.x / size.width * (n - 1)).roundToInt().coerceIn(0, n - 1)
            }
        },
    ) {
        val w = size.width
        val h = size.height
        fun x(i: Int) = if (n <= 1) 0f else w * i / (n - 1)
        fun y(v: Long) = h - ((v - lo).toFloat() / (hi - lo).toFloat()).coerceIn(0f, 1f) * (h - 2f) - 1f
        drawLine(grid, Offset(0f, h - 1f), Offset(w, h - 1f), strokeWidth = 1f)
        drawLine(grid, Offset(0f, 1f), Offset(w, 1f), strokeWidth = 1f)
        if (lo < 0 && hi > 0) drawLine(faint, Offset(0f, y(0)), Offset(w, y(0)), strokeWidth = 1f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 6f)))
        drawLine(red, Offset(0f, y(c.emergencyPence)), Offset(w, y(c.emergencyPence)), strokeWidth = 2f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 8f)))
        drawLine(grid, Offset(x(sel), 0f), Offset(x(sel), h), strokeWidth = 2f)
        // Scenarios first so the baseline is drawn over them.
        for (s in c.series.asReversed()) {
            val path = Path()
            var pen = false
            s.values.forEachIndexed { i, v ->
                if (v == null) { pen = false; return@forEachIndexed }
                if (pen) path.lineTo(x(i), y(v)) else { path.moveTo(x(i), y(v)); pen = true }
            }
            drawPath(path, Color(s.color), style = Stroke(width = if (s.id == MoneyScenarios.BASELINE) 5f else 3.5f))
        }
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(MoneyFormat.fmtPence(lo), style = MaterialTheme.typography.labelSmall, color = faint)
        Text("emergency floor ${MoneyFormat.fmtPence(c.emergencyPence, abs = true)}", style = MaterialTheme.typography.labelSmall, color = red)
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        for (i in listOf(0, n / 2, n - 1).distinct()) {
            Text(MoneyFormat.fmtMonthShort(c.months[i]), style = MaterialTheme.typography.labelSmall, color = faint)
        }
    }
    Text(
        MoneyFormat.fmtMonthLong(c.months[sel]),
        style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium,
        modifier = Modifier.padding(top = 8.dp, bottom = 2.dp),
    )
    for (s in c.series) {
        Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).background(Color(s.color), CircleShape))
            Spacer(Modifier.width(8.dp))
            Text(s.name, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(s.values.getOrNull(sel)?.let { MoneyFormat.fmtPence(it) } ?: "—", style = MaterialTheme.typography.bodySmall)
        }
    }
    Spacer(Modifier.height(6.dp))
}

// ---------------------------------------------------------------------- //
// Editor

/** A delta plus a key that survives removals above it (the fields hold their own text). */
private data class DraftDelta(val key: Int, val delta: ScenarioDelta)

/**
 * The phone's twin of the SPA's `ScenarioEditor`: name, description, an ordered
 * list of deltas and the six "add" buttons. Nothing is written until Save — a
 * new scenario that is cancelled leaves nothing behind.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ScenarioEditorSheet(
    scenario: Scenario?,
    streams: List<StreamRef>,
    categories: List<MoneyCategory>,
    onSave: (Scenario) -> Unit,
    onClone: (() -> Unit)?,
    onDelete: (() -> Unit)?,
    onCancel: () -> Unit,
) {
    val sheetKey = scenario?.id
    val initial = remember(sheetKey) { MoneyScenarios.draftOf(scenario) }
    var name by remember(sheetKey) { mutableStateOf(initial.name) }
    var description by remember(sheetKey) { mutableStateOf(initial.description) }
    var deltas by remember(sheetKey) { mutableStateOf(initial.deltas.mapIndexed { i, d -> DraftDelta(i, d) }) }
    var nextKey by remember(sheetKey) { mutableStateOf(initial.deltas.size) }
    val draft = MoneyScenarios.Draft(name, description, deltas.map { it.delta })
    val problem = MoneyScenarios.validate(draft)
    val expense = remember(categories) { categories.filter { it.kind == "expense" } }
    val live = remember(streams) { MoneyScenarios.pickableStreams(streams) }

    fun add(d: ScenarioDelta) { deltas = deltas + DraftDelta(nextKey, d); nextKey += 1 }

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (scenario == null) "New scenario" else "Edit scenario",
                style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f),
            )
            if (onClone != null) TextButton(onClick = onClone) { Text("Clone") }
            if (onDelete != null) IconButton(onClick = onDelete, modifier = Modifier.size(28.dp)) {
                Icon(Icons.Filled.Delete, "Delete", Modifier.size(16.dp), tint = RED)
            }
        }
        OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(description, { description = it }, label = { Text("Description") }, singleLine = true, modifier = Modifier.fillMaxWidth())

        Text("DELTAS", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        for (d in deltas) key(d.key) {
            DeltaCard(
                delta = d.delta,
                streams = streams,
                expense = expense,
                onChange = { edited -> deltas = deltas.map { if (it.key == d.key) it.copy(delta = edited) else it } },
                onRemove = { deltas = deltas.filterNot { it.key == d.key } },
            )
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            AddChip("+ One-off") { add(MoneyScenarios.newOneOff()) }
            AddChip("+ Modify stream", enabled = live.isNotEmpty()) { add(MoneyScenarios.newModifyStream(live.first().id)) }
            AddChip("+ End stream", enabled = live.isNotEmpty()) { add(MoneyScenarios.newTerminateStream(live.first().id)) }
            AddChip("+ New stream") { add(MoneyScenarios.newAddStream()) }
            AddChip("+ Category multiplier", enabled = expense.isNotEmpty()) { add(MoneyScenarios.newCategoryAdjust(expense.first().id)) }
            AddChip("+ Investment growth") { add(MoneyScenarios.newInvestmentGrowth()) }
        }

        problem?.let { Hint(it, padded = false) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { onSave(MoneyScenarios.toScenario(draft, scenario)) }, enabled = problem == null) { Text("Save") }
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}

@Composable
private fun AddChip(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    FilterChip(selected = false, enabled = enabled, onClick = onClick, label = { Text(label, style = MaterialTheme.typography.labelSmall) })
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DeltaCard(
    delta: ScenarioDelta,
    streams: List<StreamRef>,
    expense: List<MoneyCategory>,
    onChange: (ScenarioDelta) -> Unit,
    onRemove: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(6.dp)).padding(start = 10.dp, top = 6.dp, bottom = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            when (delta.kind) {
                MoneyScenarios.ONE_OFF -> {
                    DeltaLabel("One-off")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        DateButton(delta.str("date")) { onChange(delta.with("date", JsonPrimitive(it))) }
                        AmountField("£ (+ in, − out)", MoneyScenarios.penceToText(delta.long("amountPence")), signed = true) {
                            onChange(delta.with("amountPence", JsonPrimitive(MoneyScenarios.poundsToSignedPence(it) ?: 0L)))
                        }
                    }
                    PlainField("Note", delta.str("note") ?: "") { onChange(delta.with("note", JsonPrimitive(it))) }
                }
                MoneyScenarios.MODIFY_STREAM -> {
                    DeltaLabel("Modify stream")
                    StreamPicker(streams, delta.str("streamId")) { onChange(delta.with("streamId", JsonPrimitive(it))) }
                    val patch = delta.obj("patch")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        AmountField("New £ (blank = unchanged)", MoneyScenarios.penceToText((patch?.get("amountPence") as? JsonPrimitive)?.content?.toLongOrNull()), signed = false) {
                            val p = MoneyScenarios.poundsToSignedPence(it)
                            onChange(delta.withIn("patch", "amountPence", p?.let { v -> JsonPrimitive(abs(v)) }))
                        }
                        DateButton(
                            (patch?.get("startDate") as? JsonPrimitive)?.content, placeholder = "From (unchanged)",
                            onClear = { onChange(delta.withIn("patch", "startDate", null)) },
                        ) { onChange(delta.withIn("patch", "startDate", JsonPrimitive(it))) }
                    }
                }
                MoneyScenarios.TERMINATE_STREAM -> {
                    DeltaLabel("End stream")
                    StreamPicker(streams, delta.str("streamId")) { onChange(delta.with("streamId", JsonPrimitive(it))) }
                    DateButton(delta.str("date")) { onChange(delta.with("date", JsonPrimitive(it))) }
                }
                MoneyScenarios.ADD_STREAM -> {
                    DeltaLabel("New stream (monthly)")
                    val s = delta.obj("stream")
                    fun sv(k: String) = (s?.get(k) as? JsonPrimitive)?.content
                    PlainField("Name", sv("name") ?: "") { onChange(delta.withIn("stream", "name", JsonPrimitive(it))) }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (k in listOf("income" to "Income", "expense" to "Expense")) FilterChip(
                            selected = sv("kind") == k.first,
                            onClick = { onChange(delta.withIn("stream", "kind", JsonPrimitive(k.first))) },
                            label = { Text(k.second, style = MaterialTheme.typography.labelSmall) },
                        )
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        AmountField("£ a month", MoneyScenarios.penceToText(sv("amountPence")?.toLongOrNull()), signed = false) {
                            onChange(delta.withIn("stream", "amountPence", JsonPrimitive(abs(MoneyScenarios.poundsToSignedPence(it) ?: 0L))))
                        }
                        DateButton(sv("startDate")) { onChange(delta.withIn("stream", "startDate", JsonPrimitive(it))) }
                    }
                }
                MoneyScenarios.CATEGORY_ADJUST -> {
                    DeltaLabel("Category multiplier")
                    val current = delta.str("categoryId")
                    MenuPicker(
                        label = expense.firstOrNull { it.id == current }?.label ?: current ?: "Pick a category",
                        options = expense.map { it.id to it.label },
                    ) { onChange(delta.with("categoryId", JsonPrimitive(it))) }
                    NumberField("× (0.7 = −30%, 1.3 = +30%)", MoneyScenarios.formatNumber(delta.double("multiplier") ?: 1.0)) {
                        onChange(delta.with("multiplier", JsonPrimitive(MoneyScenarios.parseNumber(it) ?: 1.0)))
                    }
                }
                MoneyScenarios.INVESTMENT_GROWTH -> {
                    DeltaLabel("Investment growth")
                    NumberField("% a year", MoneyScenarios.formatNumber(delta.double("annualPct") ?: 0.0)) {
                        onChange(delta.with("annualPct", JsonPrimitive(MoneyScenarios.parseNumber(it) ?: 0.0)))
                    }
                }
                // A kind this build does not know: kept as it is, removable.
                else -> DeltaLabel(delta.kind)
            }
        }
        IconButton(onClick = onRemove, modifier = Modifier.size(32.dp)) {
            Icon(Icons.Filled.Close, "Remove", Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun DeltaLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
}

/** Holds its own text so `12.` or `-` can be typed; reports every change. */
@Composable
private fun AmountField(label: String, initial: String, signed: Boolean, onText: (String) -> Unit) {
    var text by remember { mutableStateOf(initial) }
    OutlinedTextField(
        text, { text = it; onText(it) },
        label = { Text(label, style = MaterialTheme.typography.labelSmall) },
        isError = text.isNotBlank() && MoneyScenarios.poundsToSignedPence(text) == null,
        singleLine = true,
        // A phone's decimal pad has no minus key, so a signed amount takes the full keyboard.
        keyboardOptions = KeyboardOptions(keyboardType = if (signed) KeyboardType.Text else KeyboardType.Decimal),
        modifier = Modifier.width(190.dp),
    )
}

@Composable
private fun NumberField(label: String, initial: String, onText: (String) -> Unit) {
    var text by remember { mutableStateOf(initial) }
    OutlinedTextField(
        text, { text = it; onText(it) },
        label = { Text(label, style = MaterialTheme.typography.labelSmall) },
        isError = MoneyScenarios.parseNumber(text) == null,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        modifier = Modifier.fillMaxWidth().padding(end = 4.dp),
    )
}

@Composable
private fun PlainField(label: String, initial: String, onText: (String) -> Unit) {
    var text by remember { mutableStateOf(initial) }
    OutlinedTextField(
        text, { text = it; onText(it) },
        label = { Text(label, style = MaterialTheme.typography.labelSmall) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth().padding(end = 4.dp),
    )
}

@Composable
private fun DateButton(date: String?, placeholder: String = "Pick a date", onClear: (() -> Unit)? = null, onPick: (String) -> Unit) {
    val context = LocalContext.current
    val zone = ZoneId.systemDefault()
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = {
            val start = runCatching { LocalDate.parse(date) }.getOrNull() ?: LocalDate.now(zone)
            showDateTimePicker(context, start.atStartOfDay(zone).toInstant().toEpochMilli(), dateOnly = true) { ms ->
                onPick(Instant.ofEpochMilli(ms).atZone(zone).toLocalDate().toString())
            }
        }) { Text(date ?: placeholder) }
        if (date != null && onClear != null) IconButton(onClick = onClear, modifier = Modifier.size(24.dp)) {
            Icon(Icons.Filled.Close, "Clear date", Modifier.size(13.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun StreamPicker(streams: List<StreamRef>, current: String?, onPick: (String) -> Unit) {
    val options = remember(streams, current) { MoneyScenarios.pickableStreams(streams, current) }
    val now = streams.firstOrNull { it.id == current }
    MenuPicker(
        label = now?.let { "${it.name} · ${MoneyFormat.fmtPence(it.amountPence, abs = true)}" } ?: "Unknown stream",
        options = options.map { it.id to "${it.name} · ${it.kind} ${MoneyFormat.fmtPence(it.amountPence, abs = true)}" },
        onPick = onPick,
    )
}

@Composable
private fun MenuPicker(label: String, options: List<Pair<String, String>>, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }, enabled = options.isNotEmpty()) {
            Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(Icons.Filled.KeyboardArrowDown, null, Modifier.size(16.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for ((id, text) in options) DropdownMenuItem(
                text = { Text(text) },
                onClick = { open = false; onPick(id) },
            )
        }
    }
}
