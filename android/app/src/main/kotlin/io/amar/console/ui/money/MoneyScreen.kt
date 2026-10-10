package io.amar.console.ui.money

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Switch
import androidx.compose.material3.TextButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import io.amar.console.ui.theme.accents
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import io.amar.console.data.db.MoneyTxRow
import io.amar.console.data.money.Account
import io.amar.console.data.money.BalanceEntry
import io.amar.console.data.money.LedgerEdit
import io.amar.console.data.money.Budget
import io.amar.console.data.money.MoneyAccounts
import io.amar.console.data.money.MoneyBudgets
import io.amar.console.data.money.MoneyCategories
import io.amar.console.data.money.MoneyCategory
import io.amar.console.data.money.MoneyRule
import io.amar.console.data.money.MoneyScenarios
import io.amar.console.data.money.Scenario
import io.amar.console.data.money.MoneyLedger
import io.amar.console.data.money.MoneyFormat
import io.amar.console.data.money.MoneyRepository
import io.amar.console.data.money.NetWorthPoint
import io.amar.console.data.money.OverrideEdit
import io.amar.console.data.money.TxOverride
import io.amar.console.data.money.Runway
import io.amar.console.ui.cal.showDateTimePicker
import io.amar.console.ui.components.EmptyState
import io.amar.console.ui.components.PaneTopBar
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val GREEN: Color @Composable @ReadOnlyComposable get() = MaterialTheme.accents.green
private val RED: Color @Composable @ReadOnlyComposable get() = MaterialTheme.accents.red
private val AMBER: Color @Composable @ReadOnlyComposable get() = MaterialTheme.accents.amber
private val LIQUID_BLUE = Color(0xFF3B82F6)
private val INVEST_VIOLET = Color(0xFFA78BFA)

/**
 * Money L1 — read-only mirror of the SPA Money tab's Cashflow / Net worth /
 * Transactions views: RunwayCard (5 tiles), per-category Budgets for the
 * current month, 12-month net-worth chart, recent transactions grouped by day.
 * Tap a transaction or a budget for its sheet; the manual-account ledger lives
 * under Net worth; Categories + Rules fold below Budgets (see MoneyTaxonomy.kt);
 * shared tabs and the foldable what-if Scenarios live in MoneyScenariosUi.kt.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MoneyScreen(repo: MoneyRepository, onGrid: () -> Unit = {}) {
    val state by repo.state.collectAsState()
    val txns by repo.observeTransactions(200).collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    // The sheet tracks the id, not a snapshot, so an override edit re-renders it from Room.
    var detailId by remember { mutableStateOf<String?>(null) }
    // One open ledger at a time (SPA NetWorthView). Saveable: opening a tx sheet
    // or leaving for another route must not collapse it.
    var openLedger by rememberSaveable { mutableStateOf<String?>(null) }
    // Non-null while the balance form is up: the account, and the entry being edited.
    var balanceTarget by rememberSaveable(stateSaver = BalanceTargetSaver) { mutableStateOf<BalanceTarget?>(null) }
    // Budget sheets key on the CATEGORY, not the budget id: a create shows under
    // a temp id until the hub mints the real one, and the category survives that swap.
    var budgetSheet by remember { mutableStateOf<BudgetSheet?>(null) }
    var confirmDeleteBudget by remember { mutableStateOf<Budget?>(null) }
    // Taxonomy sections fold (edited rarely; the daily surfaces stay above the fold). Saveable:
    // opening an editor or a tx sheet must not re-collapse them.
    var categoriesOpen by rememberSaveable { mutableStateOf(false) }
    var rulesOpen by rememberSaveable { mutableStateOf(false) }
    var showArchived by rememberSaveable { mutableStateOf(false) }
    var taxonomySheet by remember { mutableStateOf<TaxonomySheet?>(null) }
    var confirmDeleteCategory by remember { mutableStateOf<MoneyCategory?>(null) }
    var confirmDeleteRule by remember { mutableStateOf<MoneyRule?>(null) }
    // Account editor: keyed by id, so a reconcile under an open sheet re-renders it.
    var accountSheet by remember { mutableStateOf<AccountSheet?>(null) }
    var confirmDeleteAccount by remember { mutableStateOf<Account?>(null) }
    var scenariosOpen by rememberSaveable { mutableStateOf(false) }
    var scenarioSheet by remember { mutableStateOf<ScenarioSheet?>(null) }
    var confirmDeleteScenario by remember { mutableStateOf<Scenario?>(null) }

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
            item(key = "budgets") {
                val rows = state.budgetRows
                val available = remember(state.categories, state.budgets) {
                    MoneyBudgets.availableCategories(state.categories, state.budgets)
                }
                SectionTitle(
                    "Budgets",
                    trailing = state.budgetMonth?.let { MoneyFormat.fmtMonthLong(it) },
                    action = if (available.isEmpty()) null else ({
                        IconButton(onClick = { budgetSheet = BudgetSheet.Add }, modifier = Modifier.size(24.dp)) {
                            Icon(Icons.Filled.Add, "Add budget", Modifier.size(17.dp), tint = MaterialTheme.colorScheme.primary)
                        }
                    }),
                )
                BudgetsSection(rows) { row -> budgetSheet = BudgetSheet.Edit(row.budget.categoryId) }
            }
            item(key = "monthly") { MonthlySpendSection(state.monthly, cats) }
            item(key = "shared") { SharedTabsSection(state.sharedTabs) }
            item(key = "scenarios") {
                FoldableTitle(
                    "Scenarios", trailing = "${state.scenarios.size}",
                    expanded = scenariosOpen, onToggle = { scenariosOpen = !scenariosOpen },
                    onAdd = { scenarioSheet = ScenarioSheet.New },
                )
                if (scenariosOpen) ScenariosSection(state) { s -> scenarioSheet = ScenarioSheet.Edit(s.id) }
            }
            item(key = "categories") {
                val live = state.liveCategories.size
                FoldableTitle(
                    "Categories", trailing = "$live",
                    expanded = categoriesOpen, onToggle = { categoriesOpen = !categoriesOpen },
                    onAdd = { taxonomySheet = TaxonomySheet.NewCategory },
                )
                if (categoriesOpen) CategoriesSection(
                    categories = state.categories,
                    showArchived = showArchived,
                    onToggleArchived = { showArchived = it },
                    onEdit = { c -> taxonomySheet = TaxonomySheet.EditCategory(c.id) },
                )
            }
            item(key = "rules") {
                FoldableTitle(
                    "Rules", trailing = "${state.rules.size}",
                    expanded = rulesOpen, onToggle = { rulesOpen = !rulesOpen },
                    onAdd = { taxonomySheet = TaxonomySheet.NewRule },
                )
                if (rulesOpen) RulesSection(state.rules, cats) { r -> taxonomySheet = TaxonomySheet.EditRule(r.id) }
            }
            item(key = "networth") {
                SectionTitle("Net worth", trailing = "12 months")
                NetWorthSection(state.netWorthHistory, state.projection?.runway)
                AccountsBlock(
                    state = state,
                    openLedger = openLedger,
                    onToggle = { id -> openLedger = if (openLedger == id) null else id },
                    onLog = { acc -> balanceTarget = BalanceTarget(acc.id, null) },
                    onEditEntry = { acc, e -> balanceTarget = BalanceTarget(acc.id, e.id) },
                    onEditAccount = { acc -> accountSheet = AccountSheet.Edit(acc.id) },
                    onAddAccount = { accountSheet = AccountSheet.New },
                )
            }
            item(key = "tx-head") {
                SectionTitle("Recent transactions", trailing = if (txns.isNotEmpty()) "${txns.size}" else null)
                if (txns.isEmpty()) Hint(if (state.loading) "Loading…" else "No transactions cached yet.")
            }
            for (g in groups) {
                item(key = "day-${g.key}") { DayHeader(g.label) }
                items(g.rows, key = { it.id }) { tx ->
                    TransactionRow(tx, cats[tx.categoryId], onClick = { detailId = tx.id })
                }
            }
            item(key = "foot") { Spacer(Modifier.height(24.dp)) }
        }
    }

    balanceTarget?.let { target -> state.accounts.firstOrNull { it.id == target.accountId } }?.let { acc ->
        val entry = balanceTarget?.entryId?.let { id -> acc.ledger.firstOrNull { it.id == id } }
        ModalBottomSheet(onDismissRequest = { balanceTarget = null }) {
            BalanceSheet(
                account = acc,
                entry = entry,
                // The screen's scope, not the sheet's: the write must outlive the dismiss.
                onSubmit = { edit ->
                    balanceTarget = null
                    scope.launch { runCatching { repo.applyBalanceEdit(acc.id, edit) } }
                },
                onCancel = { balanceTarget = null },
            )
        }
    }

    detailId?.let { id -> txns.firstOrNull { it.id == id } }?.let { tx ->
        ModalBottomSheet(onDismissRequest = { detailId = null }) {
            TransactionDetail(
                tx,
                cats = state.categoriesById,
                categories = state.liveCategories,
                override = state.overrides[tx.id],
                // The screen's scope, not the sheet's: the write must outlive a dismiss.
                onEdit = { edit -> scope.launch { runCatching { repo.applyOverride(tx.id, edit) } } },
            )
        }
    }

    budgetSheet?.let { sheet ->
        ModalBottomSheet(onDismissRequest = { budgetSheet = null }) {
            when (sheet) {
                BudgetSheet.Add -> BudgetAddSheet(
                    categories = MoneyBudgets.availableCategories(state.categories, state.budgets),
                    // The screen's scope, not the sheet's: the write must outlive the dismiss.
                    onSave = { catId, pence ->
                        scope.launch { runCatching { repo.upsertBudget(catId, pence) } }
                        budgetSheet = null
                    },
                )
                is BudgetSheet.Edit -> {
                    val row = state.budgetRows.firstOrNull { it.budget.categoryId == sheet.categoryId }
                    if (row == null) {
                        Hint("That budget is gone.")
                        LaunchedEffect(sheet) { budgetSheet = null }
                    } else {
                        BudgetEditSheet(
                            row = row,
                            onSave = { pence ->
                                scope.launch { runCatching { repo.upsertBudget(row.budget.categoryId, pence, row.budget.id) } }
                                budgetSheet = null
                            },
                            onDelete = { confirmDeleteBudget = row.budget; budgetSheet = null },
                        )
                    }
                }
            }
        }
    }

    taxonomySheet?.let { sheet ->
        ModalBottomSheet(onDismissRequest = { taxonomySheet = null }) {
            // The screen's scope, not the sheet's: every write must outlive the dismiss.
            when (sheet) {
                TaxonomySheet.NewCategory -> CategoryEditorSheet(
                    category = null,
                    onSave = { c -> scope.launch { runCatching { repo.upsertCategory(c) } }; taxonomySheet = null },
                    onDelete = null,
                    onCancel = { taxonomySheet = null },
                )
                is TaxonomySheet.EditCategory -> {
                    val c = state.categoryFor(sheet)
                    if (c == null) {
                        Hint("That category is gone.")
                        LaunchedEffect(sheet) { taxonomySheet = null }
                    } else CategoryEditorSheet(
                        category = c,
                        onSave = { edited -> scope.launch { runCatching { repo.upsertCategory(edited) } }; taxonomySheet = null },
                        onDelete = if (MoneyCategories.canDelete(c)) ({ confirmDeleteCategory = c; taxonomySheet = null }) else null,
                        onCancel = { taxonomySheet = null },
                    )
                }
                TaxonomySheet.NewRule -> RuleEditorSheet(
                    rule = null,
                    categories = state.liveCategories,
                    onSave = { r -> scope.launch { runCatching { repo.upsertRule(r) } }; taxonomySheet = null },
                    onDelete = null,
                    onCancel = { taxonomySheet = null },
                )
                is TaxonomySheet.EditRule -> {
                    val r = state.ruleFor(sheet)
                    if (r == null) {
                        Hint("That rule is gone.")
                        LaunchedEffect(sheet) { taxonomySheet = null }
                    } else RuleEditorSheet(
                        rule = r,
                        categories = state.liveCategories,
                        onSave = { edited -> scope.launch { runCatching { repo.upsertRule(edited) } }; taxonomySheet = null },
                        onDelete = { confirmDeleteRule = r; taxonomySheet = null },
                        onCancel = { taxonomySheet = null },
                    )
                }
            }
        }
    }

    accountSheet?.let { sheet ->
        ModalBottomSheet(onDismissRequest = { accountSheet = null }) {
            // The screen's scope, not the sheet's: the write must outlive the dismiss.
            when (sheet) {
                AccountSheet.New -> AccountEditorSheet(
                    account = null,
                    onSave = { a -> scope.launch { runCatching { repo.upsertAccount(a) } }; accountSheet = null },
                    onDelete = null,
                    onCancel = { accountSheet = null },
                )
                is AccountSheet.Edit -> {
                    val acc = state.accountFor(sheet)
                    if (acc == null) {
                        Hint("That account is gone.")
                        LaunchedEffect(sheet) { accountSheet = null }
                    } else AccountEditorSheet(
                        account = acc,
                        onSave = { edited -> scope.launch { runCatching { repo.upsertAccount(edited) } }; accountSheet = null },
                        onDelete = if (MoneyAccounts.canDelete(acc)) ({ confirmDeleteAccount = acc; accountSheet = null }) else null,
                        onCancel = { accountSheet = null },
                    )
                }
            }
        }
    }

    scenarioSheet?.let { sheet ->
        ModalBottomSheet(onDismissRequest = { scenarioSheet = null }) {
            // The screen's scope, not the sheet's: the write must outlive the dismiss.
            when (sheet) {
                ScenarioSheet.New -> ScenarioEditorSheet(
                    scenario = null,
                    streams = state.streams,
                    categories = state.liveCategories,
                    onSave = { s -> scope.launch { runCatching { repo.upsertScenario(s) } }; scenarioSheet = null; scenariosOpen = true },
                    onClone = null,
                    onDelete = null,
                    onCancel = { scenarioSheet = null },
                )
                is ScenarioSheet.Edit -> {
                    val sc = state.scenarioFor(sheet)
                    if (sc == null) {
                        Hint("That scenario is gone.")
                        LaunchedEffect(sheet) { scenarioSheet = null }
                    } else ScenarioEditorSheet(
                        scenario = sc,
                        streams = state.streams,
                        categories = state.liveCategories,
                        onSave = { edited -> scope.launch { runCatching { repo.upsertScenario(edited) } }; scenarioSheet = null },
                        onClone = { scope.launch { runCatching { repo.upsertScenario(MoneyScenarios.cloneOf(sc)) } }; scenarioSheet = null },
                        onDelete = { confirmDeleteScenario = sc; scenarioSheet = null },
                        onCancel = { scenarioSheet = null },
                    )
                }
            }
        }
    }

    confirmDeleteScenario?.let { sc ->
        AlertDialog(
            onDismissRequest = { confirmDeleteScenario = null },
            title = { Text("Delete ${sc.name}?") },
            text = { Text(MoneyScenarios.deltaCount(sc)) },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch { runCatching { repo.deleteScenario(sc) } }
                    confirmDeleteScenario = null
                }) { Text("Delete", color = RED) }
            },
            dismissButton = { TextButton(onClick = { confirmDeleteScenario = null }) { Text("Cancel") } },
        )
    }

    confirmDeleteAccount?.let { acc ->
        AlertDialog(
            onDismissRequest = { confirmDeleteAccount = null },
            title = { Text("Delete ${acc.name}?") },
            text = {
                Text(
                    buildString {
                        append("Its balance history is lost.")
                        if (acc.ledger.isNotEmpty()) append(" ${acc.ledger.size} reading(s) go with it.")
                        append(" Any stream paid from it keeps running, unlinked from an account.")
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch { runCatching { repo.deleteAccount(acc) } }
                    confirmDeleteAccount = null
                }) { Text("Delete", color = RED) }
            },
            dismissButton = { TextButton(onClick = { confirmDeleteAccount = null }) { Text("Cancel") } },
        )
    }

    confirmDeleteCategory?.let { c ->
        val dependants = remember(c.id, state.rules, state.budgets) { MoneyCategories.cascadeOf(c.id, state.rules, state.budgets) }
        AlertDialog(
            onDismissRequest = { confirmDeleteCategory = null },
            title = { Text("Delete ${c.label}?") },
            text = {
                Text(
                    buildString {
                        append("Transactions in it become uncategorised.")
                        if (dependants.rules.isNotEmpty()) append(" ${dependants.rules.size} rule(s) pointing here go too.")
                        if (dependants.budgets.isNotEmpty()) append(" Its budget goes too.")
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch { runCatching { repo.deleteCategory(c) } }
                    confirmDeleteCategory = null
                }) { Text("Delete", color = RED) }
            },
            dismissButton = { TextButton(onClick = { confirmDeleteCategory = null }) { Text("Cancel") } },
        )
    }

    confirmDeleteRule?.let { r ->
        AlertDialog(
            onDismissRequest = { confirmDeleteRule = null },
            title = { Text("Delete rule?") },
            text = { Text(MoneyCategories.ruleTitle(r)) },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch { runCatching { repo.deleteRule(r) } }
                    confirmDeleteRule = null
                }) { Text("Delete", color = RED) }
            },
            dismissButton = { TextButton(onClick = { confirmDeleteRule = null }) { Text("Cancel") } },
        )
    }

    confirmDeleteBudget?.let { b ->
        val name = state.categoriesById[b.categoryId]?.name ?: b.categoryId
        AlertDialog(
            onDismissRequest = { confirmDeleteBudget = null },
            title = { Text("Delete the $name budget?") },
            text = { Text("The target goes away. Transactions and their categories are untouched.") },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch { runCatching { repo.deleteBudget(b) } }
                    confirmDeleteBudget = null
                }) { Text("Delete", color = RED) }
            },
            dismissButton = { TextButton(onClick = { confirmDeleteBudget = null }) { Text("Cancel") } },
        )
    }
}

// ---------------------------------------------------------------------- //
// Budgets

private sealed interface BudgetSheet {
    data object Add : BudgetSheet
    data class Edit(val categoryId: String) : BudgetSheet
}

@Composable
private fun BudgetsSection(rows: List<MoneyBudgets.Row>, onRow: (MoneyBudgets.Row) -> Unit) {
    if (rows.isEmpty()) {
        Hint("No budgets yet — add one to track a category against a monthly target.")
        return
    }
    val totals = remember(rows) { MoneyBudgets.totals(rows) }
    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Metric("Total target", MoneyFormat.fmtPence(totals.targetPence, abs = true), null, Modifier.weight(1f))
            Metric("Spent", MoneyFormat.fmtPence(totals.spentPence, abs = true), null, Modifier.weight(1f))
            Metric(
                "Projected", MoneyFormat.fmtPence(totals.projectedPence, abs = true), "end of month", Modifier.weight(1f),
                valueColor = if (totals.overspending) RED else MaterialTheme.colorScheme.onSurface,
            )
        }
        for (row in rows) BudgetRow(row, onClick = { onRow(row) })
    }
}

@Composable
private fun BudgetRow(row: MoneyBudgets.Row, onClick: () -> Unit) {
    val catColor = parseCatColor(row.category?.color)
    val fill = when {
        row.overspending -> RED
        row.over -> AMBER
        else -> catColor ?: GREEN
    }
    Column(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 2.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(catColor ?: MaterialTheme.colorScheme.onSurfaceVariant))
            Text(row.label, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                "${MoneyFormat.fmtPence(row.spentPence, abs = true)} / ${MoneyFormat.fmtPence(row.targetPence, abs = true)}",
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        BudgetBar(row, fill)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                if (row.remainingPence >= 0) "${MoneyFormat.fmtPence(row.remainingPence, abs = true)} left"
                else "${MoneyFormat.fmtPence(row.remainingPence, abs = true)} over",
                style = MaterialTheme.typography.labelSmall,
                color = if (row.remainingPence < 0) RED else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "proj. ${MoneyFormat.fmtPence(row.projectedPence, abs = true)}",
                style = MaterialTheme.typography.labelSmall,
                color = if (row.overspending) RED else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * SPA bar: a faded underlay to the projected fraction, the spent fill over it,
 * and a red band for the projected overshoot past target. Fractions are
 * clamped in [MoneyBudgets.Row]; a zero one is skipped (`fillMaxWidth(0f)`
 * draws nothing anyway, but a 0-width Box still measures).
 */
@Composable
private fun BudgetBar(row: MoneyBudgets.Row, fill: Color) {
    val projectedFrac = row.projectedPct.coerceAtMost(1.0).toFloat()
    val spentFrac = row.pct.coerceAtMost(1.0).toFloat()
    val overshoot = (row.projectedPct - 1.0).coerceIn(0.0, 0.5).toFloat()
    Box(
        Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant),
    ) {
        if (projectedFrac > 0f) Box(
            Modifier.fillMaxWidth(projectedFrac).fillMaxHeight()
                .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f)),
        )
        if (spentFrac > 0f) Box(Modifier.fillMaxWidth(spentFrac).fillMaxHeight().background(fill))
        if (overshoot > 0f) Box(
            Modifier.align(Alignment.CenterEnd).fillMaxWidth(overshoot).fillMaxHeight()
                .background(RED.copy(alpha = 0.35f)),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BudgetAddSheet(categories: List<MoneyCategory>, onSave: (String, Long) -> Unit) {
    var picked by remember { mutableStateOf<String?>(null) }
    var pounds by remember { mutableStateOf("") }
    val pence = MoneyBudgets.poundsToPence(pounds)
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("New budget", style = MaterialTheme.typography.titleMedium)
        if (categories.isEmpty()) {
            Hint("Every expense category already has a budget.", padded = false)
            return@Column
        }
        Text("CATEGORY", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (c in categories) FilterChip(
                selected = c.id == picked,
                onClick = { picked = c.id },
                label = { Text("${c.emoji} ${c.name}".trim(), style = MaterialTheme.typography.labelSmall) },
            )
        }
        PoundsField(pounds, onChange = { pounds = it })
        Button(onClick = { picked?.let { c -> pence?.let { onSave(c, it) } } }, enabled = picked != null && pence != null) {
            Text("Save budget")
        }
    }
}

@Composable
private fun BudgetEditSheet(row: MoneyBudgets.Row, onSave: (Long) -> Unit, onDelete: () -> Unit) {
    var pounds by remember(row.budget.id) { mutableStateOf(MoneyBudgets.penceToPounds(row.targetPence)) }
    val pence = MoneyBudgets.poundsToPence(pounds)
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(row.label.ifBlank { "Budget" }, style = MaterialTheme.typography.titleMedium)
        Text(
            "${MoneyFormat.fmtPence(row.spentPence, abs = true)} spent this month · projected ${MoneyFormat.fmtPence(row.projectedPence, abs = true)}",
            style = MaterialTheme.typography.labelSmall,
            color = if (row.overspending) RED else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        PoundsField(pounds, onChange = { pounds = it })
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { pence?.let(onSave) }, enabled = pence != null && pence != row.targetPence) { Text("Save") }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onDelete) {
                Icon(Icons.Filled.Delete, null, Modifier.size(15.dp), tint = RED)
                Spacer(Modifier.width(4.dp))
                Text("Delete", color = RED, style = MaterialTheme.typography.labelMedium)
            }
        }
        if (row.budget.isLocal) Hint("Not synced yet — it will reach the hub on the next connection.", padded = false)
    }
}

@Composable
private fun PoundsField(value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text("Monthly target (£)") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        modifier = Modifier.fillMaxWidth(),
    )
}

/** Category hex (`#a78bfa`) → Color; null when absent or unparseable. */
internal fun parseCatColor(hex: String?): Color? {
    if (hex.isNullOrBlank()) return null
    return runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrNull()
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

// ---------------------------------------------------------------------- //
// Accounts + the manual balance ledger

/** Which account's balance form is up, and the entry it edits (null = a new reading). */
data class BalanceTarget(val accountId: String, val entryId: String?)

/** `rememberSaveable` needs a saver: the pair survives as two strings. */
private val BalanceTargetSaver = androidx.compose.runtime.saveable.listSaver<BalanceTarget?, String>(
    save = { t -> if (t == null) emptyList() else listOf(t.accountId, t.entryId ?: "") },
    restore = { l -> l.getOrNull(0)?.let { BalanceTarget(it, l.getOrNull(1)?.takeIf { e -> e.isNotEmpty() }) } },
)

/**
 * The accounts list under the chart. Only Monzo auto-syncs, so a manual
 * account expands to its balance ledger — the dated readings that ARE its
 * balance — with "Log balance" to add today's. Tapping the name edits the
 * account itself; the chevron is the ledger (SPA NetWorthView, same split).
 */
@Composable
private fun AccountsBlock(
    state: MoneyRepository.State,
    openLedger: String?,
    onToggle: (String) -> Unit,
    onLog: (Account) -> Unit,
    onEditEntry: (Account, BalanceEntry) -> Unit,
    onEditAccount: (Account) -> Unit,
    onAddAccount: () -> Unit,
) {
    val groups = remember(state.accounts) { MoneyAccounts.grouped(state.accounts) }
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (groups.isEmpty()) {
            Hint(if (state.loading) "Loading accounts…" else "No accounts yet.")
        }
        for ((label, rows) in groups) {
            Text(
                label.uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            )
            for (acc in rows) {
                AccountRow(
                    account = acc,
                    balance = state.balanceOf(acc),
                    expanded = openLedger == acc.id,
                    onToggle = { onToggle(acc.id) },
                    onEdit = { onEditAccount(acc) },
                )
                if (openLedger == acc.id && acc.isManual) {
                    LedgerList(acc, onLog = { onLog(acc) }, onEditEntry = { e -> onEditEntry(acc, e) })
                }
            }
        }
        TextButton(onClick = onAddAccount, modifier = Modifier.padding(horizontal = 8.dp)) {
            Icon(Icons.Filled.Add, null, Modifier.size(14.dp))
            Spacer(Modifier.width(6.dp))
            Text("Add account", style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
private fun AccountRow(
    account: Account,
    balance: Long?,
    expanded: Boolean,
    onToggle: () -> Unit,
    onEdit: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (account.isManual) {
            Icon(
                if (expanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowRight,
                if (expanded) "Collapse" else "Expand",
                modifier = Modifier.size(16.dp).clickable(onClick = onToggle),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Spacer(Modifier.width(16.dp))
        }
        Text(account.glyph, style = MaterialTheme.typography.bodyMedium)
        Column(Modifier.weight(1f).clickable(onClick = onEdit)) {
            Text(account.name, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val sub = buildString {
                if (account.type == "monzo") append("Monzo · auto") else append("manual")
                if (account.isExternal) append(" · held externally")
                account.growthPctYoy?.let { append(" · ${MoneyAccounts.formatGrowth(it)}%/yr") }
                account.latestEntry?.let { if (account.isManual) append(" · last ${MoneyLedger.fmtDate(it.date)}") }
            }
            Text(sub, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(
            if (balance == null) "—" else MoneyFormat.fmtPence(balance, abs = true),
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
        )
    }
    HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
}

/** The account's readings, newest first; tap one to edit, long-press is the same. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LedgerList(account: Account, onLog: () -> Unit, onEditEntry: (BalanceEntry) -> Unit) {
    val entries = remember(account.ledger) { MoneyLedger.newestFirst(account.ledger) }
    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f))
            .padding(start = 36.dp, end = 12.dp, top = 6.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (entries.isEmpty()) {
            Text(
                "No readings yet — log today's balance to start.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            for (e in entries) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .combinedClickable(onClick = { onEditEntry(e) }, onLongClick = { onEditEntry(e) })
                        .padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        MoneyLedger.fmtDate(e.date),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.width(88.dp),
                    )
                    Text(MoneyFormat.fmtPence(e.balancePence, abs = true), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                    Text(
                        if (e.isLocal) "syncing…" else e.note.orEmpty(),
                        style = MaterialTheme.typography.labelSmall,
                        color = if (e.isLocal) AMBER else MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        TextButton(onClick = onLog, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
            Icon(Icons.Filled.Add, null, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text("Log balance", style = MaterialTheme.typography.labelMedium)
        }
    }
    HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
}

/** Log or edit one dated reading: date (today by default), balance in pounds, optional note. */
@Composable
private fun BalanceSheet(
    account: Account,
    entry: BalanceEntry?,
    onSubmit: (LedgerEdit) -> Unit,
    onCancel: () -> Unit,
) {
    val context = LocalContext.current
    var date by remember(entry?.id) { mutableStateOf(entry?.date ?: MoneyLedger.today()) }
    var pounds by remember(entry?.id) { mutableStateOf(entry?.let { MoneyLedger.poundsInput(it.balancePence) } ?: "") }
    var note by remember(entry?.id) { mutableStateOf(entry?.note.orEmpty()) }
    val pence = MoneyLedger.parsePounds(pounds)

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            if (entry == null) "Log balance" else "Edit reading",
            style = MaterialTheme.typography.titleMedium,
        )
        Text(
            "${account.glyph} ${account.name}".trim(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(
            Modifier
                .fillMaxWidth()
                .clickable {
                    val millis = runCatching {
                        LocalDate.parse(date).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
                    }.getOrDefault(System.currentTimeMillis())
                    showDateTimePicker(context, millis, dateOnly = true) { picked ->
                        date = Instant.ofEpochMilli(picked).atZone(ZoneId.systemDefault()).toLocalDate().toString()
                    }
                }
                .padding(vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Date", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(110.dp))
            Text(MoneyLedger.fmtDate(date), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
            Text("Change", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
        }
        OutlinedTextField(
            value = pounds,
            onValueChange = { pounds = it },
            label = { Text("Balance (£)") },
            placeholder = { Text("0.00") },
            singleLine = true,
            isError = pounds.isNotBlank() && pence == null,
            supportingText = if (pounds.isNotBlank() && pence == null) {
                { Text("Not a number", color = RED) }
            } else null,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = note,
            onValueChange = { note = it },
            label = { Text("Note (optional)") },
            singleLine = true,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = {
                    val p = pence ?: return@Button
                    onSubmit(
                        if (entry == null) LedgerEdit.Add(date, p, note)
                        else LedgerEdit.Update(entry.id, date, p, note),
                    )
                },
                enabled = pence != null,
            ) { Text(if (entry == null) "Log" else "Save") }
            TextButton(onClick = onCancel) { Text("Cancel") }
            Spacer(Modifier.weight(1f))
            if (entry != null) {
                TextButton(onClick = { onSubmit(LedgerEdit.Delete(entry.id)) }) {
                    Text("Delete", color = RED, style = MaterialTheme.typography.labelMedium)
                }
            }
        }
        Hint("Works offline — the reading is queued and lands on the hub when you're back.", padded = false)
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

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
private fun TransactionDetail(
    tx: MoneyTxRow,
    cats: Map<String, MoneyCategory>,
    categories: List<MoneyCategory>,
    override: TxOverride?,
    onEdit: (OverrideEdit) -> Unit,
) {
    var picking by remember(tx.id) { mutableStateOf(false) }
    val cat = cats[tx.categoryId]
    val zone = ZoneId.systemDefault()
    val createdLabel = if (tx.createdAt > 0) Instant.ofEpochMilli(tx.createdAt).atZone(zone).format(DateTimeFormatter.ofPattern("EEE d MMM yyyy · HH:mm", MoneyFormat.MONTH_LOCALE)) else tx.created
    val settledLabel = when {
        tx.declineReason != null -> "Declined — ${tx.declineReason}"
        tx.settled.isEmpty() -> "Pending"
        else -> runCatching { "Settled ${Instant.parse(tx.settled).atZone(zone).format(DateTimeFormatter.ofPattern("d MMM", MoneyFormat.MONTH_LOCALE))}" }.getOrDefault("Settled")
    }
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
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
        Row(
            Modifier.fillMaxWidth().clickable { picking = !picking },
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Category", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(110.dp))
            Text(
                if (cat != null) "${cat.emoji} ${cat.name}".trim() else "Uncategorised",
                style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f),
            )
            Text(
                if (picking) "Done" else if (override != null) "Overridden · change" else "Change",
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary,
            )
        }
        if (picking) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (c in categories) {
                    FilterChip(
                        selected = c.id == tx.categoryId,
                        onClick = { onEdit(OverrideEdit.SetCategory(c.id)); picking = false },
                        label = { Text("${c.emoji} ${c.name}".trim(), style = MaterialTheme.typography.labelSmall) },
                    )
                }
            }
        }
        SwitchRow("Ignore", "Don't count toward spend", tx.ignored) { onEdit(OverrideEdit.Ignore(it)) }
        SwitchRow("Transfer", "Between my own accounts", tx.isTransfer, enabled = !tx.ignored) { onEdit(OverrideEdit.Transfer(it)) }
        if (override != null) {
            TextButton(onClick = { onEdit(OverrideEdit.Reset) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                Text("Reset to rules", style = MaterialTheme.typography.labelMedium)
            }
        }
        HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
        DetailRow("Monzo category", tx.monzoCategory.replace('_', ' '))
        if (!tx.counterpartyName.isNullOrBlank()) DetailRow("Counterparty", tx.counterpartyName)
        DetailRow("Description", tx.description)
        if (!tx.notes.isNullOrBlank()) DetailRow("Notes", tx.notes)
        if (tx.currency != "GBP") DetailRow("Currency", tx.currency)
    }
}

@Composable
private fun SwitchRow(label: String, hint: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(110.dp))
        Text(hint, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f), color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
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
internal fun SectionTitle(title: String, trailing: String? = null, action: (@Composable () -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(top = 14.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (trailing != null) Text(trailing, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            action?.invoke()
        }
    }
}

@Composable
internal fun Hint(text: String, padded: Boolean = true) {
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
