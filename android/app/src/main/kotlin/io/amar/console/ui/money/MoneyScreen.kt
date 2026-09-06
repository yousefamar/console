package io.amar.console.ui.money

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import io.amar.console.data.db.MoneyTxRow
import io.amar.console.data.money.MoneyCategory
import io.amar.console.data.money.MoneyFormat
import io.amar.console.data.money.MoneyRepository
import io.amar.console.data.money.NetWorthPoint
import io.amar.console.data.money.Runway
import io.amar.console.ui.components.EmptyState
import io.amar.console.ui.components.PaneTopBar
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val GREEN = Color(0xFF4ADE80)
private val RED = Color(0xFFF87171)
private val AMBER = Color(0xFFFACC15)
private val LIQUID_BLUE = Color(0xFF3B82F6)
private val INVEST_VIOLET = Color(0xFFA78BFA)

/**
 * Money L1 — read-only mirror of the SPA Money tab's Cashflow / Net worth /
 * Transactions views: RunwayCard (5 tiles), 12-month net-worth chart, recent
 * transactions grouped by day. Tap a transaction for its detail sheet.
 * Budgets / scenarios / category editing stay SPA-only (BACKLOG Open).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MoneyScreen(repo: MoneyRepository, onGrid: () -> Unit = {}) {
    val state by repo.state.collectAsState()
    val txns by repo.observeTransactions(200).collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var detail by remember { mutableStateOf<MoneyTxRow?>(null) }

    // Hydrate the cached blobs synchronously-ish, then refresh from the hub.
    LaunchedEffect(Unit) {
        repo.hydrate()
        runCatching { repo.reconcile() }
    }

    val subtitle = remember(state.status, state.lastReconcileAt, state.loading, state.error) {
        buildString {
            state.status?.let { s ->
                if (s.transactionCount > 0) append("${s.transactionCount} tx")
                if (!s.connected && s.hasCredentials) { if (isNotEmpty()) append(" · "); append("Monzo offline") }
            }
            when {
                state.loading -> { if (isNotEmpty()) append(" · "); append("syncing…") }
                state.error != null -> { if (isNotEmpty()) append(" · "); append("cached") }
                state.lastReconcileAt != null -> { if (isNotEmpty()) append(" · "); append("synced ${relativeTime(state.lastReconcileAt!!)}") }
            }
        }.ifEmpty { "Runway · net worth · transactions" }
    }

    Column(Modifier.fillMaxSize()) {
        PaneTopBar(
            title = "Money",
            subtitle = subtitle,
            onGrid = onGrid,
            actions = {
                if (state.loading) {
                    CircularProgressIndicator(Modifier.size(18.dp).padding(end = 4.dp), strokeWidth = 2.dp)
                } else {
                    IconButton(onClick = { scope.launch { runCatching { repo.reconcile() } } }) {
                        Icon(Icons.Filled.Refresh, "Refresh", modifier = Modifier.size(20.dp))
                    }
                }
            },
        )

        val nothing = state.hydrated && state.projection == null && state.netWorthHistory.isEmpty() && txns.isEmpty()
        if (nothing) {
            EmptyState(
                Icons.Outlined.AccountBalanceWallet,
                if (state.loading) "Loading…" else "No money data",
                state.error ?: "Link Monzo + add accounts in the web app's Money tab.",
            )
            return@Column
        }

        val cats = remember(state.categories) { state.categoriesById }
        val groups = remember(txns) { groupByDay(txns) }

        LazyColumn(Modifier.fillMaxSize()) {
            item(key = "runway") {
                SectionTitle("Runway")
                val p = state.projection
                if (p == null) {
                    Hint("No runway data yet — add at least one account in Net Worth (web).")
                } else {
                    RunwayCard(p.runway, MoneyFormat.emergencyHint(state.emergencyFund))
                }
            }
            item(key = "networth") {
                SectionTitle("Net worth", trailing = "12 months")
                NetWorthSection(state.netWorthHistory, state.projection?.runway)
            }
            item(key = "tx-head") {
                SectionTitle("Recent transactions", trailing = if (txns.isNotEmpty()) "${txns.size}" else null)
                if (txns.isEmpty()) Hint(if (state.loading) "Loading…" else "No transactions cached yet.")
            }
            for (g in groups) {
                item(key = "day-${g.key}") { DayHeader(g.label) }
                items(g.rows, key = { it.id }) { tx ->
                    TransactionRow(tx, cats[tx.categoryId], onClick = { detail = tx })
                }
            }
            item(key = "foot") { Spacer(Modifier.height(24.dp)) }
        }
    }

    detail?.let { tx ->
        ModalBottomSheet(onDismissRequest = { detail = null }) {
            TransactionDetail(tx, cats = state.categoriesById)
        }
    }
}

// ---------------------------------------------------------------------- //
// Runway

@Composable
private fun RunwayCard(r: Runway, emergencyHint: String) {
    val burning = r.monthlyBurnPence < 0
    val tone = MoneyFormat.runwayTone(r)
    val runwayColor = when (tone) {
        MoneyFormat.RunwayTone.GOOD -> GREEN
        MoneyFormat.RunwayTone.BAD -> RED
        MoneyFormat.RunwayTone.WARN -> AMBER
        MoneyFormat.RunwayTone.NEUTRAL -> MaterialTheme.colorScheme.onSurface
    }
    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Metric("Liquid", MoneyFormat.fmtPence(r.liquidPence, abs = true), "Cash + bank + Monzo", Modifier.weight(1f))
            Metric("Investments", MoneyFormat.fmtPence(r.investmentPence, abs = true), "ISA + GIA + held-by-others", Modifier.weight(1f))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Metric(
                "Monthly net", MoneyFormat.fmtPence(r.monthlyBurnPence, showSign = true), "avg over last 3 mo",
                Modifier.weight(1f),
                valueColor = if (burning) RED else GREEN,
                icon = if (burning) Icons.Filled.ArrowDownward else Icons.Filled.ArrowUpward,
            )
            Metric("Emergency fund", MoneyFormat.fmtPence(r.emergencyFundPence, abs = true), emergencyHint, Modifier.weight(1f))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Metric(
                "Runway", MoneyFormat.runwayMonthsLabel(r), MoneyFormat.runwayDateLabel(r),
                Modifier.weight(1f),
                valueColor = runwayColor,
                icon = if (tone == MoneyFormat.RunwayTone.BAD || tone == MoneyFormat.RunwayTone.WARN) Icons.Filled.Warning else null,
            )
            Metric("Total", MoneyFormat.fmtPence(r.totalPence, abs = true), "liquid + investments", Modifier.weight(1f))
        }
    }
}

@Composable
private fun Metric(
    label: String,
    value: String,
    hint: String?,
    modifier: Modifier = Modifier,
    valueColor: Color = MaterialTheme.colorScheme.onSurface,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
) {
    Column(modifier) {
        Text(label.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            if (icon != null) Icon(icon, null, Modifier.size(13.dp), tint = valueColor)
            Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Medium, color = valueColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (hint != null) Text(hint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ---------------------------------------------------------------------- //
// Net worth

@Composable
private fun NetWorthSection(history: List<NetWorthPoint>, runway: Runway?) {
    val latest = history.lastOrNull()
    val liquid = runway?.liquidPence ?: latest?.liquidPence ?: 0
    val investment = runway?.investmentPence ?: latest?.investmentPence ?: 0
    val total = runway?.totalPence ?: latest?.totalPence ?: 0
    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Metric("Liquid", MoneyFormat.fmtPence(liquid, abs = true), null, Modifier.weight(1f), valueColor = LIQUID_BLUE)
            Metric("Investments", MoneyFormat.fmtPence(investment, abs = true), null, Modifier.weight(1f), valueColor = INVEST_VIOLET)
            Metric("Total", MoneyFormat.fmtPence(total, abs = true), null, Modifier.weight(1f))
        }
        if (history.size < 2) {
            Hint("No history yet — add balance entries (web).", padded = false)
        } else {
            NetWorthChart(history, Modifier.fillMaxWidth().height(120.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(MoneyFormat.fmtMonthShort(history.first().date), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(MoneyFormat.fmtMonthShort(history.last().date), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** Stacked area: investments on top of liquid (SPA NetWorthView AreaChart). */
@Composable
private fun NetWorthChart(history: List<NetWorthPoint>, modifier: Modifier) {
    val grid = MaterialTheme.colorScheme.outlineVariant
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val n = history.size
        val maxTotal = (history.maxOf { it.liquidPence + it.investmentPence }.coerceAtLeast(1L)).toFloat()
        val minY = 0f
        fun x(i: Int) = if (n == 1) 0f else w * i / (n - 1)
        fun y(v: Long) = h - ((v.toFloat() - minY) / (maxTotal - minY)).coerceIn(0f, 1f) * (h - 2f)

        // Gridlines at 0 / 50 / 100 %.
        for (f in listOf(0f, 0.5f, 1f)) {
            val yy = h - f * (h - 2f)
            drawLine(grid, androidx.compose.ui.geometry.Offset(0f, yy), androidx.compose.ui.geometry.Offset(w, yy), strokeWidth = 1f)
        }

        // Total (liquid + investment) area in violet, liquid area in blue on top.
        val totalPath = Path().apply {
            moveTo(x(0), h)
            history.forEachIndexed { i, p -> lineTo(x(i), y(p.liquidPence + p.investmentPence)) }
            lineTo(x(n - 1), h); close()
        }
        drawPath(totalPath, INVEST_VIOLET.copy(alpha = 0.25f))
        val liquidPath = Path().apply {
            moveTo(x(0), h)
            history.forEachIndexed { i, p -> lineTo(x(i), y(p.liquidPence)) }
            lineTo(x(n - 1), h); close()
        }
        drawPath(liquidPath, LIQUID_BLUE.copy(alpha = 0.35f))

        val totalLine = Path().apply {
            history.forEachIndexed { i, p -> val px = x(i); val py = y(p.liquidPence + p.investmentPence); if (i == 0) moveTo(px, py) else lineTo(px, py) }
        }
        drawPath(totalLine, INVEST_VIOLET, style = Stroke(width = 2.5f))
        val liquidLine = Path().apply {
            history.forEachIndexed { i, p -> val px = x(i); val py = y(p.liquidPence); if (i == 0) moveTo(px, py) else lineTo(px, py) }
        }
        drawPath(liquidLine, LIQUID_BLUE, style = Stroke(width = 2.5f))
    }
}

// ---------------------------------------------------------------------- //
// Transactions

private data class DayGroup(val key: String, val label: String, val rows: List<MoneyTxRow>)

private fun groupByDay(txns: List<MoneyTxRow>): List<DayGroup> {
    val now = System.currentTimeMillis()
    val out = ArrayList<DayGroup>()
    var curKey: String? = null
    var cur = ArrayList<MoneyTxRow>()
    for (tx in txns) {
        val k = MoneyFormat.dayKey(tx.createdAt)
        if (k != curKey) {
            if (curKey != null) out.add(DayGroup(curKey, MoneyFormat.dayLabel(cur.first().createdAt, now), cur))
            curKey = k; cur = ArrayList()
        }
        cur.add(tx)
    }
    if (curKey != null && cur.isNotEmpty()) out.add(DayGroup(curKey, MoneyFormat.dayLabel(cur.first().createdAt, now), cur))
    return out
}

@Composable
private fun DayHeader(label: String) {
    Text(
        label,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

@Composable
private fun TransactionRow(tx: MoneyTxRow, cat: MoneyCategory?, onClick: () -> Unit) {
    val declined = tx.declineReason != null
    val faded = declined || tx.ignored || tx.isTransfer
    val name = MoneyFormat.displayName(tx)
    val ref = MoneyFormat.reference(tx)
    val alpha = if (faded) 0.5f else 1f
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        TxGlyph(tx, cat, alpha)
        Column(Modifier.weight(1f)) {
            Text(name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha))
            val sub = when {
                declined -> "Declined"
                ref.isNotEmpty() -> ref
                cat != null -> cat.name
                tx.settled.isEmpty() -> "Pending"
                else -> null
            }
            if (sub != null) Text(
                sub, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = if (declined) RED else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha),
            )
        }
        Text(
            MoneyFormat.rowAmount(tx.amount),
            style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium,
            color = (if (tx.amount < 0) MaterialTheme.colorScheme.onSurface else GREEN).copy(alpha = alpha),
        )
    }
}

@Composable
private fun TxGlyph(tx: MoneyTxRow, cat: MoneyCategory?, alpha: Float, size: androidx.compose.ui.unit.Dp = 36.dp) {
    Box(
        Modifier.size(size).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = alpha)),
        contentAlignment = Alignment.Center,
    ) {
        when {
            tx.merchantLogo != null -> AsyncImage(
                model = tx.merchantLogo, contentDescription = null,
                modifier = Modifier.size(size).clip(CircleShape),
                alpha = alpha,
            )
            tx.merchantEmoji != null -> Text(tx.merchantEmoji, style = MaterialTheme.typography.bodyLarge)
            cat != null && cat.emoji.isNotEmpty() -> Text(cat.emoji, style = MaterialTheme.typography.bodyLarge)
            else -> Text(tx.monzoCategory.take(1).uppercase(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun TransactionDetail(tx: MoneyTxRow, cats: Map<String, MoneyCategory>) {
    val cat = cats[tx.categoryId]
    val zone = ZoneId.systemDefault()
    val createdLabel = if (tx.createdAt > 0) Instant.ofEpochMilli(tx.createdAt).atZone(zone).format(DateTimeFormatter.ofPattern("EEE d MMM yyyy · HH:mm", MoneyFormat.MONTH_LOCALE)) else tx.created
    val settledLabel = when {
        tx.declineReason != null -> "Declined — ${tx.declineReason}"
        tx.settled.isEmpty() -> "Pending"
        else -> runCatching { "Settled ${Instant.parse(tx.settled).atZone(zone).format(DateTimeFormatter.ofPattern("d MMM", MoneyFormat.MONTH_LOCALE))}" }.getOrDefault("Settled")
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TxGlyph(tx, cat, 1f, size = 44.dp)
            Column(Modifier.weight(1f)) {
                Text(MoneyFormat.displayName(tx), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(createdLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(
                MoneyFormat.rowAmount(tx.amount), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Medium,
                color = if (tx.amount < 0) MaterialTheme.colorScheme.onSurface else GREEN,
            )
        }
        Text(
            settledLabel, style = MaterialTheme.typography.labelSmall,
            color = when {
                tx.declineReason != null -> RED
                tx.settled.isEmpty() -> AMBER
                else -> MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
        HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
        DetailRow("Category", if (cat != null) "${cat.emoji} ${cat.name}".trim() else "Uncategorised")
        if (tx.isTransfer) DetailRow("Transfer", "yes — excluded from spend")
        if (tx.ignored) DetailRow("Ignored", "yes — excluded from spend")
        DetailRow("Monzo category", tx.monzoCategory.replace('_', ' '))
        if (!tx.counterpartyName.isNullOrBlank()) DetailRow("Counterparty", tx.counterpartyName)
        DetailRow("Description", tx.description)
        if (!tx.notes.isNullOrBlank()) DetailRow("Notes", tx.notes)
        if (tx.currency != "GBP") DetailRow("Currency", tx.currency)
        Text(
            "Recategorise / ignore / mark transfer in the web app's Money tab.",
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(110.dp))
        Text(value, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
    }
}

// ---------------------------------------------------------------------- //
// Bits

@Composable
private fun SectionTitle(title: String, trailing: String? = null) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(top = 14.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
        if (trailing != null) Text(trailing, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun Hint(text: String, padded: Boolean = true) {
    Text(
        text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = if (padded) Modifier.padding(horizontal = 12.dp, vertical = 8.dp) else Modifier,
    )
}

private fun relativeTime(ms: Long): String {
    val d = (System.currentTimeMillis() - ms) / 1000
    return when {
        d < 60 -> "just now"
        d < 3600 -> "${d / 60}m ago"
        d < 86400 -> "${d / 3600}h ago"
        else -> "${d / 86400}d ago"
    }
}
