package io.amar.console.data.money

import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.MetaRow
import io.amar.console.data.db.MoneyTxRow
import io.amar.console.data.db.OutboxRow
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Money domain — read-only mirror of the SPA Money tab's Cashflow / Net worth /
 * Transactions views. Sources (all hub-computed; the projection engine lives
 * server-side in `server/src/finance/projection.ts`):
 *
 *   /finance/projection            → runway (5 RunwayCard tiles)
 *   /finance/networth/history      → 12-month liquid + investment line
 *   /finance/all                   → categories + emergency-fund setting
 *   /money/transactions?limit=500  → recent transactions (Room-cached)
 *   /finance/categorise?limit=500  → effective category per transaction
 *   /money/status                  → Monzo link state + last sync
 *
 * The hub has no SyncBus service for money (the SPA fetches on mount), so this
 * reconciles on every sync pass + on pane open. Transactions live in Room; the
 * small computed blobs live in the `meta` table so the pane opens offline.
 *
 * Editing: per-transaction overrides (recategorise / ignore / transfer) go
 * through the outbox as `money:override` — optimistic Room write, POST or
 * DELETE `/finance/overrides`, then the hub's re-derived classification is
 * pulled back over the row. Manual-account balance readings go the same way as
 * `money:balance` (`POST/PATCH/DELETE /finance/accounts/:id/balance`): only
 * Monzo auto-syncs, so every other account's balance IS its ledger and logging
 * one happens wherever he is. Per-category budgets ride `money:budget` the
 * same way (POST / DELETE `/finance/budgets`, keyed by categoryId — see
 * [MoneyBudgets]); their monthly actuals come from
 * `/finance/budget-status?month=`. Categories and the auto-categorisation
 * rules ride `money:category` / `money:rule` (POST = upsert with a
 * phone-minted id, DELETE — see [MoneyCategories]), and the accounts
 * themselves ride `money:account` the same way (see [MoneyAccounts]), so a new
 * ISA or a rename no longer needs the laptop. Scenarios are still SPA-only
 * (BACKLOG Open follow-up).
 */
class MoneyRepository(
    private val db: ConsoleDb,
    private val hub: HubClient,
    private val outbox: Outbox? = null,
) {
    companion object {
        const val TX_LIMIT = 500
        const val TYPE_OVERRIDE = "money:override"
        const val TYPE_BALANCE = "money:balance"
        const val TYPE_BUDGET = "money:budget"
        const val TYPE_CATEGORY = "money:category"
        const val TYPE_RULE = "money:rule"
        const val TYPE_ACCOUNT = "money:account"
        private const val META_OVERRIDES = "money:overrides"
        private const val META_RULES = "money:rules"
        private const val META_ACCOUNTS = "money:accounts"
        private const val META_BALANCES = "money:balances"
        private const val META_BUDGETS = "money:budgets"
        private const val META_BUDGET_STATUS = "money:budgetStatus"
        private const val META_BUDGET_MONTH = "money:budgetMonth"
        private const val META_RUNWAY = "money:runway"
        private const val META_NETWORTH = "money:networth"
        private const val META_CATEGORIES = "money:categories"
        private const val META_EMERGENCY = "money:emergencyFund"
        private const val META_LAST_SYNC = "money:lastReconcileAt"
        private const val META_MONTHLY = "money:monthly"
    }

    data class State(
        val projection: ProjectionResult? = null,
        val netWorthHistory: List<NetWorthPoint> = emptyList(),
        /** `/finance/all` → categories, archived INCLUDED (lookups need them; pickers use [liveCategories]). */
        val categories: List<MoneyCategory> = emptyList(),
        /** `/finance/all` → rules, in priority order (optimistic on edit). */
        val rules: List<MoneyRule> = emptyList(),
        /** `/finance/all` → accounts (Monzo + manual, archived included). */
        val accounts: List<Account> = emptyList(),
        /** `/finance/networth` → balance per account id (empty when that route failed). */
        val balances: Map<String, Long> = emptyMap(),
        val emergencyFund: EmergencyFund? = null,
        /** Per-transaction overrides by txId (`GET /finance/overrides`, optimistic on edit). */
        val overrides: Map<String, TxOverride> = emptyMap(),
        /** Per-category monthly targets (`/finance/all` → budgets, optimistic on edit). */
        val budgets: List<Budget> = emptyList(),
        /** This month's actuals per budget (`/finance/budget-status?month=`). */
        val budgetStatus: List<BudgetStatus> = emptyList(),
        /** `YYYY-MM` the status rows describe. */
        val budgetMonth: String? = null,
        /** `/finance/monthly` → per-category spend per month, ascending (cached for offline). */
        val monthly: List<MonthlySpend> = emptyList(),
        val status: MoneyStatus? = null,
        /** Epoch ms of the last successful reconcile (persisted). */
        val lastReconcileAt: Long? = null,
        val loading: Boolean = false,
        /** Last reconcile error, cleared on the next success. */
        val error: String? = null,
        /** True once the meta cache has been read (so "no data" isn't shown pre-load). */
        val hydrated: Boolean = false,
    ) {
        val categoriesById: Map<String, MoneyCategory> get() = categories.associateBy { it.id }

        /** What a picker offers: everything not archived. */
        val liveCategories: List<MoneyCategory> get() = categories.filterNot { it.archived }

        val budgetRows: List<MoneyBudgets.Row> get() = MoneyBudgets.rows(budgets, budgetStatus, categoriesById)

        /** Live accounts in display order, grouped the way the SPA's Net worth view does. */
        fun accountsByLiquidity(liquidity: String): List<Account> = accounts
            .filter { !it.archived && it.liquidity == liquidity }
            .sortedWith(compareBy({ it.sort ?: Int.MAX_VALUE }, { it.name.lowercase() }))

        /**
         * What to show as an account's balance: the hub's own figure when
         * `/finance/networth` answered, else its newest ledger reading (a
         * manual account's ledger is the whole truth, so this works offline).
         */
        fun balanceOf(account: Account): Long? =
            balances[account.id] ?: account.latestEntry?.balancePence
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    fun observeTransactions(limit: Int = TX_LIMIT): Flow<List<MoneyTxRow>> = db.money().observeRecent(limit)

    suspend fun transaction(id: String): MoneyTxRow? = db.money().byId(id)

    /** Load the persisted computed blobs — call once before the first render. */
    suspend fun hydrate() {
        if (_state.value.hydrated) return
        val meta = db.meta()
        val projection = meta.get(META_RUNWAY)?.let { MoneyJson.parseProjection(it) }
        val history = meta.get(META_NETWORTH)?.let { MoneyJson.parseNetWorthHistory(it) } ?: emptyList()
        val cats = meta.get(META_CATEGORIES)?.let { MoneyJson.decodeCategories(it) } ?: emptyList()
        val ef = meta.get(META_EMERGENCY)?.let { MoneyJson.decodeEmergencyFund(it) }
        val last = meta.get(META_LAST_SYNC)?.toLongOrNull()
        val ovs = meta.get(META_OVERRIDES)?.let { MoneyOverrides.parseOverrides(it) }
        val accs = meta.get(META_ACCOUNTS)?.let { MoneyJson.decodeAccounts(it) } ?: emptyList()
        val bals = meta.get(META_BALANCES)?.let { MoneyJson.decodeBalances(it) } ?: emptyMap()
        val buds = meta.get(META_BUDGETS)?.let { MoneyJson.parseBudgets(it) }
        val budStatus = meta.get(META_BUDGET_STATUS)?.let { MoneyJson.parseBudgetStatus(it) }
        val rules = meta.get(META_RULES)?.let { MoneyJson.decodeRules(it) }
        val monthly = meta.get(META_MONTHLY)?.let { MoneyMonthly.parse(it) } ?: emptyList()
        _state.value = _state.value.copy(
            rules = rules ?: _state.value.rules,
            overrides = ovs ?: _state.value.overrides,
            accounts = if (accs.isNotEmpty()) accs else _state.value.accounts,
            balances = if (bals.isNotEmpty()) bals else _state.value.balances,
            budgets = buds ?: _state.value.budgets,
            budgetStatus = budStatus ?: _state.value.budgetStatus,
            budgetMonth = meta.get(META_BUDGET_MONTH) ?: _state.value.budgetMonth,
            monthly = if (monthly.isNotEmpty()) monthly else _state.value.monthly,
            projection = projection ?: _state.value.projection,
            netWorthHistory = if (history.isNotEmpty()) history else _state.value.netWorthHistory,
            categories = if (cats.isNotEmpty()) cats else _state.value.categories,
            emergencyFund = ef ?: _state.value.emergencyFund,
            lastReconcileAt = last ?: _state.value.lastReconcileAt,
            hydrated = true,
        )
    }

    /**
     * Full refresh. Each source is fetched independently so one failing route
     * (e.g. `/finance/networth` needing a live Monzo token) can't blank the
     * others; the first failure is surfaced as [State.error].
     */
    suspend fun reconcile() {
        hydrate()
        _state.value = _state.value.copy(loading = true)
        var firstError: String? = null
        fun noteError(t: Throwable) { if (firstError == null) firstError = t.message ?: t.toString() }

        coroutineScope {
            val txD = async { runCatching { hub.get("/money/transactions?limit=$TX_LIMIT") } }
            val clsD = async { runCatching { hub.get("/finance/categorise?limit=$TX_LIMIT") } }
            val projD = async { runCatching { hub.get("/finance/projection") } }
            val nwD = async { runCatching { hub.get("/finance/networth/history?months=12") } }
            val allD = async { runCatching { hub.get("/finance/all") } }
            val statusD = async { runCatching { hub.get("/money/status") } }
            val ovD = async { runCatching { hub.get("/finance/overrides") } }
            // Per-account balances; needs a live Monzo token, so a failure here
            // must not cost us the accounts list (the ledger fallback covers it).
            val balD = async { runCatching { hub.get("/finance/networth") } }
            val month = MoneyBudgets.currentMonth()
            val bsD = async { runCatching { hub.get("/finance/budget-status?month=$month") } }
            val monthlyD = async { runCatching { hub.get("/finance/monthly") } }

            val txBody = txD.await().onFailure(::noteError).getOrNull()
            val classes = clsD.await().onFailure(::noteError).getOrNull()
                ?.let { MoneyJson.parseClassifications(it) } ?: emptyMap()
            if (txBody != null) {
                val inFlight = inFlightOverrides()
                val rows = MoneyJson.parseTransactions(txBody, classes).map { r ->
                    // An override still in the outbox: keep the optimistic classification.
                    if (r.id !in inFlight) r
                    else db.money().byId(r.id)?.let { cur -> r.copy(categoryId = cur.categoryId, ignored = cur.ignored, isTransfer = cur.isTransfer) } ?: r
                }
                if (rows.isNotEmpty()) {
                    db.money().upsertAll(rows)
                    db.money().trimTo(TX_LIMIT)
                }
            }

            val meta = db.meta()
            projD.await().onFailure(::noteError).getOrNull()?.let { body ->
                MoneyJson.parseProjection(body)?.let { p ->
                    meta.put(MetaRow(META_RUNWAY, MoneyJson.encodeRunway(p)))
                    _state.value = _state.value.copy(projection = p)
                }
            }
            nwD.await().onFailure(::noteError).getOrNull()?.let { body ->
                val pts = MoneyJson.parseNetWorthHistory(body)
                if (pts.isNotEmpty()) {
                    meta.put(MetaRow(META_NETWORTH, MoneyJson.encodeNetWorthHistory(pts)))
                    _state.value = _state.value.copy(netWorthHistory = pts)
                }
            }
            allD.await().onFailure(::noteError).getOrNull()?.let { body ->
                val cats = withInFlightCategories(MoneyJson.parseCategories(body))
                val ef = MoneyJson.parseEmergencyFund(body)
                if (cats.isNotEmpty()) storeCategories(cats)
                if (ef != null) meta.put(MetaRow(META_EMERGENCY, MoneyJson.encodeEmergencyFund(ef)))
                _state.value = _state.value.copy(emergencyFund = ef ?: _state.value.emergencyFund)
                storeAccounts(overlayAccounts(MoneyJson.parseAccounts(body)))
                // Budgets + rules ride the same payload too (the SPA's fetchAll does the same).
                val root = runCatching { MoneyJson.json.parseToJsonElement(body) }.getOrNull()
                val obj = root as? kotlinx.serialization.json.JsonObject
                obj?.get("budgets")?.let { storeBudgets(withInFlightBudgets(MoneyJson.parseBudgetArray(it))) }
                obj?.get("rules")?.let { storeRules(withInFlightRules(MoneyJson.parseRuleArray(it))) }
            }
            balD.await().getOrNull()?.let { body ->
                val bals = MoneyJson.parseNetWorthBalances(body)
                if (bals.isNotEmpty()) {
                    meta.put(MetaRow(META_BALANCES, MoneyJson.encodeBalances(bals)))
                    _state.value = _state.value.copy(balances = bals)
                }
            }
            bsD.await().getOrNull()?.let { body ->
                val rows = MoneyJson.parseBudgetStatus(body)
                meta.put(MetaRow(META_BUDGET_STATUS, MoneyJson.encodeBudgetStatus(rows)))
                meta.put(MetaRow(META_BUDGET_MONTH, month))
                _state.value = _state.value.copy(budgetStatus = rows, budgetMonth = month)
            }
            monthlyD.await().getOrNull()?.let { body ->
                val rows = MoneyMonthly.parse(body)
                // An empty reply is "no history" only if the hub says so with `[]`; a
                // non-array body (proxy error page) must not blank the cached chart.
                if (rows.isNotEmpty() || body.trim() == "[]") {
                    meta.put(MetaRow(META_MONTHLY, MoneyMonthly.encode(rows)))
                    _state.value = _state.value.copy(monthly = rows)
                }
            }
            ovD.await().getOrNull()?.let { body -> storeOverrides(withInFlight(MoneyOverrides.parseOverrides(body))) }
            statusD.await().getOrNull()?.let { body ->
                MoneyJson.parseStatus(body)?.let { _state.value = _state.value.copy(status = it) }
            }
        }

        val now = System.currentTimeMillis()
        if (firstError == null) db.meta().put(MetaRow(META_LAST_SYNC, now.toString()))
        _state.value = _state.value.copy(
            loading = false,
            error = firstError,
            lastReconcileAt = if (firstError == null) now else _state.value.lastReconcileAt,
        )
    }

    // ---------------------------------------------------------------- //
    // Per-transaction overrides

    private suspend fun inFlightOverrides(): Set<String> =
        if (outbox == null) emptySet() else db.outbox().inFlightEntityIds(TYPE_OVERRIDE).toSet()

    /** A hub override list with the still-queued local edits laid back over it. */
    private suspend fun withInFlight(hubMap: Map<String, TxOverride>): Map<String, TxOverride> {
        val inFlight = inFlightOverrides()
        if (inFlight.isEmpty()) return hubMap
        val local = _state.value.overrides
        val out = hubMap.toMutableMap()
        for (id in inFlight) { val l = local[id]; if (l == null) out.remove(id) else out[id] = l }
        return out
    }

    private suspend fun storeOverrides(map: Map<String, TxOverride>) {
        db.meta().put(MetaRow(META_OVERRIDES, MoneyOverrides.encodeOverrides(map)))
        _state.value = _state.value.copy(overrides = map)
    }

    /**
     * Recategorise / ignore / mark transfer / reset one transaction: the row
     * and the override map change now, the hub write rides the outbox (so it
     * survives being offline), and [refreshAfterOverride] replaces the guess
     * with the hub's classification once it lands.
     */
    suspend fun applyOverride(txId: String, edit: OverrideEdit) {
        val ob = outbox ?: error("MoneyRepository has no outbox")
        val row = db.money().byId(txId)
        val beforeOverride = _state.value.overrides[txId]
        val merged = MoneyOverrides.mergedOverride(beforeOverride, txId, edit)
        if (row != null) db.money().upsertAll(listOf(MoneyOverrides.optimistic(row, merged)))
        storeOverrides(if (merged == null) _state.value.overrides - txId else _state.value.overrides + (txId to merged))
        ob.enqueue(
            TYPE_OVERRIDE,
            MoneyOverrides.encodeAction(
                MoneyOverrides.Action(
                    txId = txId,
                    body = MoneyOverrides.requestBody(txId, edit),
                    before = row?.let { TxClassification(it.categoryId ?: MoneyOverrides.UNCATEGORISED, it.ignored, it.isTransfer) },
                    beforeOverride = beforeOverride,
                )
            ),
            entityId = txId,
        )
    }

    fun registerOutboxHandlers() {
        val ob = outbox ?: return
        ob.register(TYPE_OVERRIDE) { row, _ -> handleOverride(row) }
        ob.register("$TYPE_OVERRIDE:onFailed") { row, _ -> healOverride(row) }
        ob.register(TYPE_BALANCE) { row, _ -> handleBalance(row) }
        ob.register("$TYPE_BALANCE:onFailed") { row, _ -> healBalance(row) }
        ob.register(TYPE_BUDGET) { row, _ -> handleBudget(row) }
        ob.register("$TYPE_BUDGET:onFailed") { row, _ -> healBudget(row) }
        ob.register(TYPE_CATEGORY) { row, _ -> handleCategory(row) }
        ob.register("$TYPE_CATEGORY:onFailed") { row, _ -> healCategory(row) }
        ob.register(TYPE_RULE) { row, _ -> handleRule(row) }
        ob.register("$TYPE_RULE:onFailed") { row, _ -> healRule(row) }
        ob.register(TYPE_ACCOUNT) { row, _ -> handleAccount(row) }
        ob.register("$TYPE_ACCOUNT:onFailed") { row, _ -> healAccount(row) }
    }

    // ---------------------------------------------------------------- //
    // Categories + rules (the taxonomy the budgets and classifications hang off)

    private suspend fun inFlightCategories(): Set<String> =
        if (outbox == null) emptySet() else db.outbox().inFlightEntityIds(TYPE_CATEGORY).toSet()

    private suspend fun inFlightRules(): Set<String> =
        if (outbox == null) emptySet() else db.outbox().inFlightEntityIds(TYPE_RULE).toSet()

    /** [settled] = the id whose write just landed (its row is still `processing`) — see [MoneyCategories.withInFlightCategories]. */
    private suspend fun withInFlightCategories(hubList: List<MoneyCategory>, settled: String? = null): List<MoneyCategory> =
        MoneyCategories.withInFlightCategories(hubList, _state.value.categories, inFlightCategories() - setOfNotNull(settled))

    private suspend fun withInFlightRules(hubList: List<MoneyRule>, settled: String? = null, settledCategory: String? = null): List<MoneyRule> {
        val cats = inFlightCategories() - setOfNotNull(settledCategory)
        return MoneyCategories.withInFlightRules(
            hubList, _state.value.rules,
            inFlightRules() - setOfNotNull(settled),
            MoneyCategories.deletingCategoryIds(cats, _state.value.categories),
        )
    }

    private suspend fun storeCategories(list: List<MoneyCategory>) {
        db.meta().put(MetaRow(META_CATEGORIES, MoneyJson.encodeCategories(list)))
        _state.value = _state.value.copy(categories = list)
    }

    /** Always held in priority order — the hub sorts on write, and every local path keeps that invariant. */
    private suspend fun storeRules(list: List<MoneyRule>) {
        val sorted = MoneyCategories.sorted(list)
        db.meta().put(MetaRow(META_RULES, MoneyJson.encodeRules(sorted)))
        _state.value = _state.value.copy(rules = sorted)
    }

    /**
     * Create or edit a category. A create arrives with a phone-minted id
     * ([MoneyCategories.mintCategoryId]) so the record's identity is final from
     * the optimistic write on; the hub's POST upserts by that id.
     */
    suspend fun upsertCategory(category: MoneyCategory) {
        val ob = outbox ?: error("MoneyRepository has no outbox")
        val before = _state.value.categories.firstOrNull { it.id == category.id }
        storeCategories(MoneyCategories.upsertInto(_state.value.categories, category))
        ob.enqueue(
            TYPE_CATEGORY,
            MoneyCategories.encodeCategoryAction(
                MoneyCategories.CategoryAction(category.id, MoneyCategories.categoryBody(category), before)
            ),
            entityId = category.id,
        )
    }

    /**
     * Delete a category and, like the hub will, the rules and budgets pointing
     * at it. Any queued write for the same id is dropped first (a create the hub
     * never saw, an edit that is now moot); the DELETE still goes — a 404 for an
     * id the hub never had counts as done. System categories are refused here,
     * matching the hub's 400.
     */
    suspend fun deleteCategory(category: MoneyCategory) {
        val ob = outbox ?: error("MoneyRepository has no outbox")
        require(MoneyCategories.canDelete(category)) { "System categories can't be deleted" }
        val s = _state.value
        val cascade = MoneyCategories.cascadeOf(category.id, s.rules, s.budgets)
        storeCategories(s.categories.filterNot { it.id == category.id })
        storeRules(_state.value.rules.filterNot { it.categoryId == category.id })
        storeBudgets(_state.value.budgets.filterNot { it.categoryId == category.id })
        ob.cancel(category.id, TYPE_CATEGORY)
        ob.enqueue(
            TYPE_CATEGORY,
            MoneyCategories.encodeCategoryAction(
                MoneyCategories.CategoryAction(category.id, null, category, cascade.rules, cascade.budgets)
            ),
            entityId = category.id,
        )
    }

    suspend fun upsertRule(rule: MoneyRule) {
        val ob = outbox ?: error("MoneyRepository has no outbox")
        val before = _state.value.rules.firstOrNull { it.id == rule.id }
        storeRules(MoneyCategories.upsertInto(_state.value.rules, rule))
        ob.enqueue(
            TYPE_RULE,
            MoneyCategories.encodeRuleAction(
                MoneyCategories.RuleAction(rule.id, MoneyCategories.ruleBody(rule, isEdit = before != null), before)
            ),
            entityId = rule.id,
        )
    }

    suspend fun deleteRule(rule: MoneyRule) {
        val ob = outbox ?: error("MoneyRepository has no outbox")
        storeRules(_state.value.rules.filterNot { it.id == rule.id })
        ob.cancel(rule.id, TYPE_RULE)
        ob.enqueue(
            TYPE_RULE,
            MoneyCategories.encodeRuleAction(MoneyCategories.RuleAction(rule.id, null, rule)),
            entityId = rule.id,
        )
    }

    private suspend fun handleCategory(row: OutboxRow): Outbox.Result {
        val a = MoneyCategories.decodeCategoryAction(row.payloadJson) ?: return Outbox.Result.Fail("bad payload")
        return try {
            if (a.body != null) hub.post("/finance/categories", a.body)
            else try {
                hub.delete("/finance/categories/${java.net.URLEncoder.encode(a.categoryId, "UTF-8")}")
            } catch (e: HubClient.HttpException) {
                if (e.code != 404) throw e // already gone = the delete we wanted
            }
            runCatching { refreshAfterTaxonomy(settledCategory = a.categoryId) }
            Outbox.Result.Done
        } catch (e: HubClient.HttpException) {
            if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
        } catch (e: Exception) {
            Outbox.retryOrNotReady(e, "network")
        }
    }

    /** Terminal failure: put back the category (and, for a refused delete, what the cascade dropped). */
    private suspend fun healCategory(row: OutboxRow): Outbox.Result {
        val a = MoneyCategories.decodeCategoryAction(row.payloadJson) ?: return Outbox.Result.Done
        storeCategories(MoneyCategories.healedCategories(_state.value.categories, a))
        storeRules(MoneyCategories.healedRulesAfterCategory(_state.value.rules, a))
        storeBudgets(MoneyCategories.healedBudgetsAfterCategory(_state.value.budgets, a))
        return Outbox.Result.Done
    }

    private suspend fun handleRule(row: OutboxRow): Outbox.Result {
        val a = MoneyCategories.decodeRuleAction(row.payloadJson) ?: return Outbox.Result.Fail("bad payload")
        return try {
            if (a.body != null) hub.post("/finance/rules", a.body)
            else try {
                hub.delete("/finance/rules/${java.net.URLEncoder.encode(a.ruleId, "UTF-8")}")
            } catch (e: HubClient.HttpException) {
                if (e.code != 404) throw e // already gone = the delete we wanted
            }
            runCatching { refreshAfterTaxonomy(settledRule = a.ruleId) }
            Outbox.Result.Done
        } catch (e: HubClient.HttpException) {
            if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
        } catch (e: Exception) {
            Outbox.retryOrNotReady(e, "network")
        }
    }

    private suspend fun healRule(row: OutboxRow): Outbox.Result {
        val a = MoneyCategories.decodeRuleAction(row.payloadJson) ?: return Outbox.Result.Done
        storeRules(MoneyCategories.healedRules(_state.value.rules, a))
        return Outbox.Result.Done
    }

    /**
     * After a category or rule write: the taxonomy, the budgets a category
     * delete cascaded through, and every transaction's classification (a rule
     * change re-categorises history) come back from the hub.
     */
    private suspend fun refreshAfterTaxonomy(settledCategory: String? = null, settledRule: String? = null) {
        runCatching {
            val body = hub.get("/finance/all")
            storeCategories(withInFlightCategories(MoneyJson.parseCategories(body), settled = settledCategory))
            storeRules(withInFlightRules(MoneyJson.parseRules(body), settled = settledRule, settledCategory = settledCategory))
            val root = runCatching { MoneyJson.json.parseToJsonElement(body) }.getOrNull() as? kotlinx.serialization.json.JsonObject
            root?.get("budgets")?.let { storeBudgets(withInFlightBudgets(MoneyJson.parseBudgetArray(it))) }
        }
        runCatching {
            val classes = MoneyJson.parseClassifications(hub.get("/finance/categorise?limit=$TX_LIMIT"))
            val inFlight = inFlightOverrides()
            val rows = db.money().recent(TX_LIMIT).mapNotNull { r ->
                val c = classes[r.id] ?: return@mapNotNull null
                if (r.id in inFlight) null
                else r.copy(categoryId = c.categoryId, ignored = c.ignored, isTransfer = c.isTransfer).takeIf { it != r }
            }
            if (rows.isNotEmpty()) db.money().upsertAll(rows)
        }
    }

    // ---------------------------------------------------------------- //
    // Manual-account balance ledger

    private suspend fun inFlightLedgers(): Set<String> =
        if (outbox == null) emptySet() else db.outbox().inFlightEntityIds(TYPE_BALANCE).toSet()

    /**
     * The hub's accounts with the still-queued local ledgers laid back over
     * them — otherwise every reconcile while an entry sits in the outbox
     * re-applies the pre-edit copy and the reading visibly reverts.
     *
     * [settled] is the account whose write just landed: its own row is still
     * `processing` while its handler runs, so without this the hub's now-
     * authoritative ledger would be overwritten by our optimistic guess and the
     * local id would stick around until the next reconcile. A LATER edit to the
     * same account (another row, still `pending`) keeps the overlay.
     */
    private suspend fun withInFlightLedgers(hubAccounts: List<Account>, settled: String? = null): List<Account> {
        var inFlight = inFlightLedgers()
        if (settled != null && inFlight.contains(settled) && !hasQueuedBalanceEdit(settled)) inFlight = inFlight - settled
        if (inFlight.isEmpty()) return hubAccounts
        val local = _state.value.accounts.associateBy { it.id }
        return hubAccounts.map { a ->
            if (a.id !in inFlight) a else local[a.id]?.let { a.copy(ledger = it.ledger) } ?: a
        }
    }

    /** Another ledger edit for [accountId] still waiting (the in-flight one is `processing`). */
    private suspend fun hasQueuedBalanceEdit(accountId: String): Boolean =
        db.outbox().pending().any { it.type == TYPE_BALANCE && it.entityId == accountId }

    private suspend fun storeAccounts(accounts: List<Account>) {
        db.meta().put(MetaRow(META_ACCOUNTS, MoneyJson.encodeAccounts(accounts)))
        _state.value = _state.value.copy(accounts = accounts)
    }

    // ---------------------------------------------------------------- //
    // Account CRUD (the records the ledger and the streams hang off)

    private suspend fun inFlightAccounts(): Set<String> =
        if (outbox == null) emptySet() else db.outbox().inFlightEntityIds(TYPE_ACCOUNT).toSet()

    /** Another account write for [accountId] still waiting (the in-flight one is `processing`). */
    private suspend fun hasQueuedAccountEdit(accountId: String): Boolean =
        db.outbox().pending().any { it.type == TYPE_ACCOUNT && it.entityId == accountId }

    /**
     * Every hub accounts list goes through here: the queued ledger entries AND
     * the queued account edits are laid back over it, in that order, so an
     * account overlay keeps whichever ledger won. [settledLedger] /
     * [settledAccount] name the write that just landed — see
     * [MoneyAccounts.withInFlightAccounts].
     */
    private suspend fun overlayAccounts(
        hubAccounts: List<Account>,
        settledLedger: String? = null,
        settledAccount: String? = null,
    ): List<Account> {
        var inFlight = inFlightAccounts()
        if (settledAccount != null && settledAccount in inFlight && !hasQueuedAccountEdit(settledAccount)) {
            inFlight = inFlight - settledAccount
        }
        return MoneyAccounts.withInFlightAccounts(
            withInFlightLedgers(hubAccounts, settled = settledLedger),
            _state.value.accounts,
            inFlight,
        )
    }

    /**
     * Create or edit an account. A create arrives with a phone-minted id
     * ([MoneyAccounts.mintAccountId]) so its identity is final from the
     * optimistic write on; the hub's POST upserts by that id. The write body
     * carries no ledger and, on an edit, explicit nulls for the cleared
     * optionals — both reasons in [MoneyAccounts].
     */
    suspend fun upsertAccount(account: Account) {
        val ob = outbox ?: error("MoneyRepository has no outbox")
        val before = _state.value.accounts.firstOrNull { it.id == account.id }
        // Never let an edit rewrite the ledger or the Monzo link we hold.
        val toStore = if (before == null) account else account.copy(
            ledger = before.ledger,
            type = before.type,
            monzoAccountId = before.monzoAccountId,
        )
        storeAccounts(MoneyAccounts.upsertInto(_state.value.accounts, toStore))
        val isEdit = before != null
        ob.enqueue(
            TYPE_ACCOUNT,
            MoneyAccounts.encodeAccountAction(
                MoneyAccounts.AccountAction(
                    accountId = toStore.id,
                    body = MoneyAccounts.accountBody(toStore, isEdit = isEdit),
                    before = before,
                    patch = if (MoneyAccounts.needsPatch(toStore, isEdit)) MoneyAccounts.patchBody(toStore) else null,
                )
            ),
            entityId = toStore.id,
        )
    }

    /**
     * Delete an account. Any queued write for the same id is dropped first (a
     * create the hub never saw, an edit that is now moot); the DELETE still
     * goes — the id is the phone-minted real one, so a 404 for an account the
     * hub never had counts as done and no network probe is needed to tell the
     * two cases apart offline. The hub also clears the account off every stream
     * pointing at it (the phone caches no streams, so there is nothing to
     * mirror) and its balance history goes with it. Monzo accounts are refused:
     * their link is the desktop's to remove.
     */
    suspend fun deleteAccount(account: Account) {
        val ob = outbox ?: error("MoneyRepository has no outbox")
        require(MoneyAccounts.canDelete(account)) { "Monzo accounts are removed in the web app" }
        storeAccounts(_state.value.accounts.filterNot { it.id == account.id })
        ob.cancel(account.id, TYPE_ACCOUNT)
        ob.enqueue(
            TYPE_ACCOUNT,
            MoneyAccounts.encodeAccountAction(MoneyAccounts.AccountAction(account.id, null, account)),
            entityId = account.id,
        )
    }

    private suspend fun handleAccount(row: OutboxRow): Outbox.Result {
        val a = MoneyAccounts.decodeAccountAction(row.payloadJson) ?: return Outbox.Result.Fail("bad payload")
        return try {
            if (a.body != null) {
                hub.post("/finance/accounts", a.body)
                // Repeats growthPctYoy / archived, which a hub older than 9 Oct 2026 dropped on a create.
                a.patch?.let { hub.patch(MoneyAccounts.path(a.accountId), it) }
            } else try {
                hub.delete(MoneyAccounts.path(a.accountId))
            } catch (e: HubClient.HttpException) {
                if (e.code != 404) throw e else "" // already gone = the delete we wanted
            }
            runCatching { refreshAfterAccount(a.accountId) }
            Outbox.Result.Done
        } catch (e: HubClient.HttpException) {
            if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
        } catch (e: Exception) {
            Outbox.retryOrNotReady(e, "network")
        }
    }

    /** Terminal failure: put back the record this write replaced (ledger and all), or drop a failed create. */
    private suspend fun healAccount(row: OutboxRow): Outbox.Result {
        val a = MoneyAccounts.decodeAccountAction(row.payloadJson) ?: return Outbox.Result.Done
        storeAccounts(MoneyAccounts.healedAccounts(_state.value.accounts, a))
        return Outbox.Result.Done
    }

    /** An account's liquidity and growth are projection inputs, so the runway and net worth move with it. */
    private suspend fun refreshAfterAccount(settled: String) {
        runCatching {
            storeAccounts(overlayAccounts(MoneyJson.decodeAccounts(hub.get("/finance/accounts")), settledAccount = settled))
        }
        runCatching { MoneyJson.parseProjection(hub.get("/finance/projection"))?.let { p ->
            db.meta().put(MetaRow(META_RUNWAY, MoneyJson.encodeRunway(p)))
            _state.value = _state.value.copy(projection = p)
        } }
        runCatching {
            val bals = MoneyJson.parseNetWorthBalances(hub.get("/finance/networth"))
            if (bals.isNotEmpty()) {
                db.meta().put(MetaRow(META_BALANCES, MoneyJson.encodeBalances(bals)))
                _state.value = _state.value.copy(balances = bals)
            }
        }
    }

    /**
     * Log / edit / delete one dated balance reading on a manual account: the
     * ledger changes now, the hub write rides the outbox (so it survives being
     * offline — logging a balance standing at a cash machine is the point), and
     * [refreshAfterBalance] pulls the hub's stored entry, the recomputed
     * net-worth history and the runway back once it lands.
     */
    suspend fun applyBalanceEdit(accountId: String, edit: LedgerEdit) {
        val ob = outbox ?: error("MoneyRepository has no outbox")
        val account = _state.value.accounts.firstOrNull { it.id == accountId }
            ?: error("Unknown account $accountId")
        val action = MoneyLedger.action(account, edit)
        storeAccounts(MoneyLedger.replace(_state.value.accounts, MoneyLedger.optimistic(account, edit)))
        ob.enqueue(TYPE_BALANCE, MoneyLedger.encodeAction(action), entityId = accountId)
    }

    private suspend fun handleBalance(row: OutboxRow): Outbox.Result {
        val a = MoneyLedger.decodeAction(row.payloadJson) ?: return Outbox.Result.Fail("bad payload")
        return try {
            when (a.method) {
                "POST" -> hub.post(a.path, a.body ?: "{}")
                "PATCH" -> hub.patch(a.path, a.body ?: "{}")
                "DELETE" -> try {
                    hub.delete(a.path)
                } catch (e: HubClient.HttpException) {
                    if (e.code != 404) throw e else "" // already gone = the delete we wanted
                }
                else -> return Outbox.Result.Fail("bad method ${a.method}")
            }
            runCatching { refreshAfterBalance(a.accountId) }
            Outbox.Result.Done
        } catch (e: HubClient.HttpException) {
            if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
        } catch (e: Exception) {
            Outbox.retryOrNotReady(e, "network")
        }
    }

    /**
     * Terminal failure: the hub never took the reading, so put the account's
     * pre-edit ledger back. The next reconcile would also fix it, but only
     * while online — this heals now, and an optimistic row that stood would
     * otherwise read as a logged balance that no desktop ever sees.
     */
    private suspend fun healBalance(row: OutboxRow): Outbox.Result {
        val a = MoneyLedger.decodeAction(row.payloadJson) ?: return Outbox.Result.Done
        val current = _state.value.accounts.firstOrNull { it.id == a.accountId } ?: return Outbox.Result.Done
        storeAccounts(MoneyLedger.replace(_state.value.accounts, MoneyLedger.healed(current, a.beforeLedger)))
        return Outbox.Result.Done
    }

    /** The ledger IS the net-worth input, so the history + runway move with it. */
    private suspend fun refreshAfterBalance(settled: String) {
        runCatching { storeAccounts(overlayAccounts(MoneyJson.decodeAccounts(hub.get("/finance/accounts")), settledLedger = settled)) }
        runCatching {
            val pts = MoneyJson.parseNetWorthHistory(hub.get("/finance/networth/history?months=12"))
            if (pts.isNotEmpty()) {
                db.meta().put(MetaRow(META_NETWORTH, MoneyJson.encodeNetWorthHistory(pts)))
                _state.value = _state.value.copy(netWorthHistory = pts)
            }
        }
        runCatching {
            val bals = MoneyJson.parseNetWorthBalances(hub.get("/finance/networth"))
            if (bals.isNotEmpty()) {
                db.meta().put(MetaRow(META_BALANCES, MoneyJson.encodeBalances(bals)))
                _state.value = _state.value.copy(balances = bals)
            }
        }
        runCatching {
            MoneyJson.parseProjection(hub.get("/finance/projection"))?.let { p ->
                db.meta().put(MetaRow(META_RUNWAY, MoneyJson.encodeRunway(p)))
                _state.value = _state.value.copy(projection = p)
            }
        }
    }

    private suspend fun handleOverride(row: OutboxRow): Outbox.Result {
        val a = MoneyOverrides.decodeAction(row.payloadJson) ?: return Outbox.Result.Fail("bad payload")
        return try {
            if (a.body != null) hub.post("/finance/overrides", a.body)
            else try {
                hub.delete("/finance/overrides/${java.net.URLEncoder.encode(a.txId, "UTF-8")}")
            } catch (e: HubClient.HttpException) {
                if (e.code != 404) throw e // already gone = the reset we wanted
            }
            runCatching { refreshAfterOverride(a.txId) }
            Outbox.Result.Done
        } catch (e: HubClient.HttpException) {
            if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
        } catch (e: Exception) {
            Outbox.retryOrNotReady(e, "network")
        }
    }

    /**
     * Terminal failure: the hub never took the edit, so put back the row's
     * classification and the override entry it replaced. The next reconcile
     * would also fix the row, but only while it is online — this heals now.
     */
    private suspend fun healOverride(row: OutboxRow): Outbox.Result {
        val a = MoneyOverrides.decodeAction(row.payloadJson) ?: return Outbox.Result.Done
        db.money().byId(a.txId)?.let { db.money().upsertAll(listOf(MoneyOverrides.healed(it, a.before))) }
        val ovs = _state.value.overrides
        storeOverrides(if (a.beforeOverride == null) ovs - a.txId else ovs + (a.txId to a.beforeOverride))
        return Outbox.Result.Done
    }

    // ---------------------------------------------------------------- //
    // Budgets

    /** Categories of budgets whose write has not landed — a reconcile must not undo them. */
    private suspend fun inFlightBudgets(): Set<String> =
        if (outbox == null) emptySet() else db.outbox().inFlightEntityIds(TYPE_BUDGET).toSet()

    /**
     * [settled] is the category whose write just landed: the outbox row is
     * still `processing` while its handler runs, so without this exclusion the
     * post-write refresh keeps our own optimistic copy — and a create would sit
     * under its `~` temp id until some later reconcile.
     */
    private suspend fun withInFlightBudgets(hubList: List<Budget>, settled: String? = null): List<Budget> {
        val merged = MoneyBudgets.withInFlight(hubList, _state.value.budgets, inFlightBudgets() - setOfNotNull(settled))
        // A category whose delete is queued takes its budget with it on the hub; don't revive it meanwhile.
        val deleting = MoneyCategories.deletingCategoryIds(inFlightCategories(), _state.value.categories)
        return if (deleting.isEmpty()) merged else merged.filterNot { it.categoryId in deleting }
    }

    private suspend fun storeBudgets(list: List<Budget>) {
        db.meta().put(MetaRow(META_BUDGETS, MoneyJson.encodeBudgets(list)))
        _state.value = _state.value.copy(budgets = list)
    }

    /**
     * Create or retarget the budget for a category: the list changes now, the
     * hub write rides the outbox, and [refreshAfterBudget] replaces the local
     * row (temp id and all) with the hub's once it lands.
     */
    suspend fun upsertBudget(categoryId: String, monthlyTargetPence: Long, id: String? = null) {
        val ob = outbox ?: error("MoneyRepository has no outbox")
        val edit = MoneyBudgets.BudgetEdit.SetTarget(categoryId, monthlyTargetPence, id)
        val before = _state.value.budgets.firstOrNull { b -> id?.let { b.id == it } ?: (b.categoryId == categoryId) }
        val merged = MoneyBudgets.merged(before, edit)
        storeBudgets(MoneyBudgets.optimisticUpsert(_state.value.budgets, merged))
        ob.enqueue(
            TYPE_BUDGET,
            MoneyBudgets.encodeAction(
                MoneyBudgets.Action(
                    categoryId = categoryId,
                    budgetId = merged.id,
                    body = MoneyBudgets.requestBody(edit),
                    before = before,
                )
            ),
            entityId = categoryId,
        )
    }

    /** Drop a budget (the target only — transactions and their categories are untouched). */
    suspend fun deleteBudget(budget: Budget) {
        val ob = outbox ?: error("MoneyRepository has no outbox")
        storeBudgets(MoneyBudgets.optimisticDelete(_state.value.budgets, budget.id))
        // A never-synced budget has no hub row to delete: dropping the queued
        // create is the whole job (and a `~` id would 404 forever otherwise).
        if (budget.isLocal) {
            ob.cancel(budget.categoryId, TYPE_BUDGET)
            return
        }
        ob.enqueue(
            TYPE_BUDGET,
            MoneyBudgets.encodeAction(
                MoneyBudgets.Action(categoryId = budget.categoryId, budgetId = budget.id, body = null, before = budget)
            ),
            entityId = budget.categoryId,
        )
    }

    private suspend fun handleBudget(row: OutboxRow): Outbox.Result {
        val a = MoneyBudgets.decodeAction(row.payloadJson) ?: return Outbox.Result.Fail("bad payload")
        return try {
            if (a.body != null) hub.post("/finance/budgets", a.body)
            else try {
                hub.delete("/finance/budgets/${java.net.URLEncoder.encode(a.budgetId, "UTF-8")}")
            } catch (e: HubClient.HttpException) {
                if (e.code != 404) throw e // already gone = the delete we wanted
            }
            runCatching { refreshAfterBudget(a.categoryId) }
            Outbox.Result.Done
        } catch (e: HubClient.HttpException) {
            if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
        } catch (e: Exception) {
            Outbox.retryOrNotReady(e, "network")
        }
    }

    /** Terminal failure: put back the record the edit replaced (or drop a failed create). */
    private suspend fun healBudget(row: OutboxRow): Outbox.Result {
        val a = MoneyBudgets.decodeAction(row.payloadJson) ?: return Outbox.Result.Done
        storeBudgets(MoneyBudgets.healed(_state.value.budgets, a))
        return Outbox.Result.Done
    }

    /** Pull the hub's budget list + this month's status back after a write. */
    private suspend fun refreshAfterBudget(settled: String? = null) {
        val month = MoneyBudgets.currentMonth()
        runCatching { storeBudgets(withInFlightBudgets(MoneyJson.parseBudgets(hub.get("/finance/budgets")), settled)) }
        runCatching {
            val rows = MoneyJson.parseBudgetStatus(hub.get("/finance/budget-status?month=$month"))
            db.meta().put(MetaRow(META_BUDGET_STATUS, MoneyJson.encodeBudgetStatus(rows)))
            db.meta().put(MetaRow(META_BUDGET_MONTH, month))
            _state.value = _state.value.copy(budgetStatus = rows, budgetMonth = month)
        }
    }

    /** Pull the hub's re-derived classification (+ the override list and runway) after a write. */
    private suspend fun refreshAfterOverride(txId: String) {
        val classes = MoneyJson.parseClassifications(hub.get("/finance/categorise?limit=$TX_LIMIT"))
        classes[txId]?.let { c ->
            db.money().byId(txId)?.let { r ->
                db.money().upsertAll(listOf(r.copy(categoryId = c.categoryId, ignored = c.ignored, isTransfer = c.isTransfer)))
            }
        }
        runCatching { storeOverrides(withInFlight(MoneyOverrides.parseOverrides(hub.get("/finance/overrides")))) }
        runCatching {
            MoneyJson.parseProjection(hub.get("/finance/projection"))?.let { p ->
                db.meta().put(MetaRow(META_RUNWAY, MoneyJson.encodeRunway(p)))
                _state.value = _state.value.copy(projection = p)
            }
        }
    }
}
