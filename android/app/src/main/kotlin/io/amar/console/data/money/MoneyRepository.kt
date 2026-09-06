package io.amar.console.data.money

import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.MetaRow
import io.amar.console.data.db.MoneyTxRow
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
 * Budgets / scenarios / category editing are deliberately NOT here (SPA-only
 * for now — BACKLOG Open follow-ups).
 */
class MoneyRepository(
    private val db: ConsoleDb,
    private val hub: HubClient,
) {
    companion object {
        const val TX_LIMIT = 500
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
        _state.value = _state.value.copy(
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

            val txBody = txD.await().onFailure(::noteError).getOrNull()
            val classes = clsD.await().onFailure(::noteError).getOrNull()
                ?.let { MoneyJson.parseClassifications(it) } ?: emptyMap()
            if (txBody != null) {
                val rows = MoneyJson.parseTransactions(txBody, classes)
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
}
