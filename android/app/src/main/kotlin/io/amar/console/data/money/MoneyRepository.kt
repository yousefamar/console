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
 * pulled back over the row. Budgets / scenarios / rules CRUD are still
 * SPA-only (BACKLOG Open follow-ups).
 */
class MoneyRepository(
    private val db: ConsoleDb,
    private val hub: HubClient,
    private val outbox: Outbox? = null,
) {
    companion object {
        const val TX_LIMIT = 500
        const val TYPE_OVERRIDE = "money:override"
        private const val META_OVERRIDES = "money:overrides"
        private const val META_RUNWAY = "money:runway"
        private const val META_NETWORTH = "money:networth"
        private const val META_CATEGORIES = "money:categories"
        private const val META_EMERGENCY = "money:emergencyFund"
        private const val META_LAST_SYNC = "money:lastReconcileAt"
    }

    data class State(
        val projection: ProjectionResult? = null,
        val netWorthHistory: List<NetWorthPoint> = emptyList(),
        val categories: List<MoneyCategory> = emptyList(),
        val emergencyFund: EmergencyFund? = null,
        /** Per-transaction overrides by txId (`GET /finance/overrides`, optimistic on edit). */
        val overrides: Map<String, TxOverride> = emptyMap(),
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
        _state.value = _state.value.copy(
            overrides = ovs ?: _state.value.overrides,
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
                val cats = MoneyJson.parseCategories(body)
                val ef = MoneyJson.parseEmergencyFund(body)
                if (cats.isNotEmpty()) meta.put(MetaRow(META_CATEGORIES, MoneyJson.encodeCategories(cats)))
                if (ef != null) meta.put(MetaRow(META_EMERGENCY, MoneyJson.encodeEmergencyFund(ef)))
                _state.value = _state.value.copy(
                    categories = if (cats.isNotEmpty()) cats else _state.value.categories,
                    emergencyFund = ef ?: _state.value.emergencyFund,
                )
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
