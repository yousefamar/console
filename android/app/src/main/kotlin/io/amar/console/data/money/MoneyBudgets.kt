package io.amar.console.data.money

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * Pure helpers behind `money:budget` — the phone's half of the SPA's
 * `BudgetsView.tsx` (`upsertBudget` / `deleteBudget` in `src/store/finance.ts`)
 * plus the per-row arithmetic that view does inline.
 *
 * Outbox keying: an action's `entityId` is the **categoryId**, not the budget
 * id — a create has no hub id yet (we show it under a temp one), and the hub's
 * own upsert matches on categoryId when no id is given, so the category is the
 * stable identity of "the budget being edited" across the whole round trip.
 * One budget per category is the SPA's invariant too (its picker hides
 * already-budgeted categories).
 */
object MoneyBudgets {
    /** Prefix of a locally-created budget's placeholder id (the calendar's `~` convention). */
    const val TEMP_PREFIX = "~"

    /** The SPA clamps both bar fractions at 1.5 of target. */
    const val BAR_CLAMP = 1.5

    fun tempId(nowMs: Long = System.currentTimeMillis(), salt: Int = (0..0xffff).random()): String =
        "$TEMP_PREFIX$nowMs.$salt"

    /** `YYYY-MM` for the status query — current month only, like the SPA's default. */
    fun currentMonth(today: LocalDate = LocalDate.now(ZoneId.systemDefault())): String =
        "%04d-%02d".format(today.year, today.monthValue)

    // ---- Edits ----------------------------------------------------------

    sealed class BudgetEdit {
        /** Create (when [id] is null or local) or retarget an existing budget. */
        data class SetTarget(val categoryId: String, val monthlyTargetPence: Long, val id: String? = null) : BudgetEdit()
        data class Delete(val id: String, val categoryId: String) : BudgetEdit()
    }

    /**
     * POST body for an upsert. A real hub id is sent so the hub retargets that
     * exact row; a missing or temp id is omitted, leaving the hub to match on
     * categoryId (create-or-update) — sending `~17…` would mint a budget with
     * a junk id that nothing could then address.
     */
    fun requestBody(edit: BudgetEdit.SetTarget): String = buildJsonObject {
        val id = edit.id
        if (id != null && !id.startsWith(TEMP_PREFIX)) put("id", id)
        put("categoryId", edit.categoryId)
        put("monthlyTargetPence", edit.monthlyTargetPence)
    }.toString()

    /** The budget record [edit] leaves behind, for the optimistic write. */
    fun merged(before: Budget?, edit: BudgetEdit.SetTarget, newId: () -> String = { tempId() }): Budget =
        before?.copy(categoryId = edit.categoryId, monthlyTargetPence = edit.monthlyTargetPence)
            ?: Budget(id = edit.id ?: newId(), categoryId = edit.categoryId, monthlyTargetPence = edit.monthlyTargetPence)

    /** Replace-or-append by id, falling back to categoryId (a create has a temp id). */
    fun optimisticUpsert(list: List<Budget>, b: Budget): List<Budget> {
        val idx = list.indexOfFirst { it.id == b.id }.takeIf { it >= 0 }
            ?: list.indexOfFirst { it.categoryId == b.categoryId }
        return if (idx >= 0) list.toMutableList().also { it[idx] = b } else list + b
    }

    fun optimisticDelete(list: List<Budget>, id: String): List<Budget> = list.filterNot { it.id == id }

    /**
     * A hub list with the still-queued local edits laid back over it, keyed by
     * category: the hub's pre-edit copy of a budget whose write has not landed
     * would otherwise flip the row back and forth (the ^warm-wren rule).
     */
    fun withInFlight(hubList: List<Budget>, local: List<Budget>, inFlightCategoryIds: Set<String>): List<Budget> {
        if (inFlightCategoryIds.isEmpty()) return hubList
        val out = hubList.filterNot { it.categoryId in inFlightCategoryIds }.toMutableList()
        for (cat in inFlightCategoryIds) local.firstOrNull { it.categoryId == cat }?.let(out::add)
        return out
    }

    // ---- View rows (the arithmetic BudgetsView does inline) --------------

    data class Row(
        val budget: Budget,
        val category: MoneyCategory?,
        val spentPence: Long,
        val projectedPence: Long,
    ) {
        val targetPence: Long get() = budget.monthlyTargetPence
        val remainingPence: Long get() = targetPence - spentPence
        /** Spent as a fraction of target, clamped at [BAR_CLAMP]. */
        val pct: Double get() = fraction(spentPence)
        val projectedPct: Double get() = fraction(projectedPence)
        /** Red: the month is on course to end over target. */
        val overspending: Boolean get() = projectedPence > targetPence
        /** Amber: already at or past target, even if the projection says otherwise. */
        val over: Boolean get() = targetPence > 0 && spentPence >= targetPence

        private fun fraction(v: Long): Double =
            if (targetPence <= 0) 0.0 else min(v.toDouble() / targetPence.toDouble(), BAR_CLAMP)

        val label: String get() = listOfNotNull(category?.emoji?.takeIf { it.isNotEmpty() }, category?.name ?: budget.categoryId).joinToString(" ")
    }

    /** Budgets joined to their status row, in the hub's order. */
    fun rows(budgets: List<Budget>, status: List<BudgetStatus>, categoriesById: Map<String, MoneyCategory>): List<Row> =
        budgets.map { b ->
            // Status is keyed by budgetId, but a just-created budget has only a
            // temp id here — fall back to the category so its spend still shows.
            val s = status.firstOrNull { it.budgetId == b.id } ?: status.firstOrNull { it.categoryId == b.categoryId }
            Row(b, categoriesById[b.categoryId], s?.spentPence ?: 0L, s?.projectedEndOfMonthPence ?: 0L)
        }

    data class Totals(val targetPence: Long, val spentPence: Long, val projectedPence: Long) {
        val overspending: Boolean get() = projectedPence > targetPence
    }

    /** The three summary tiles. Totals come from the rows so a temp-id budget counts. */
    fun totals(rows: List<Row>): Totals = Totals(
        targetPence = rows.sumOf { it.targetPence },
        spentPence = rows.sumOf { it.spentPence },
        projectedPence = rows.sumOf { it.projectedPence },
    )

    /**
     * Categories the add form may offer: expense, not hub-system, not already
     * budgeted (SPA `expense.filter(c => !budgets.some(b => b.categoryId === c.id))`).
     * Archived ones never reach the phone — `parseCategoryArray` drops them.
     */
    fun availableCategories(categories: List<MoneyCategory>, budgets: List<Budget>): List<MoneyCategory> {
        val taken = budgets.map { it.categoryId }.toSet()
        return categories.filter { it.kind == "expense" && !it.isSystem && it.id !in taken }
    }

    /** `"12.50"` / `"12"` / `"£12.50"` → pence; null when it isn't a positive amount. */
    fun poundsToPence(input: String): Long? {
        val cleaned = input.trim().removePrefix("£").replace(",", "")
        val v = cleaned.toDoubleOrNull() ?: return null
        if (!v.isFinite() || v <= 0) return null
        return max(1L, (v * 100).roundToLong())
    }

    /** Pence → the text the edit field starts with (`1250` → `12.50`). */
    fun penceToPounds(pence: Long): String =
        if (pence % 100 == 0L) (pence / 100).toString() else "%.2f".format(pence / 100.0)

    // ---- Outbox payload: the request plus everything the heal needs -----

    data class Action(
        val categoryId: String,
        val budgetId: String,
        /** POST body; null = DELETE `/finance/budgets/<budgetId>`. */
        val body: String?,
        /** The record this edit replaced (null = there was none). */
        val before: Budget?,
    )

    fun encodeAction(a: Action): String = buildJsonObject {
        put("categoryId", a.categoryId)
        put("budgetId", a.budgetId)
        put("body", a.body?.let { JsonPrimitive(it) } ?: JsonNull)
        put("before", a.before?.let(::encodeBudget) ?: JsonNull)
    }.toString()

    fun decodeAction(payload: String): Action? {
        val o = runCatching { MoneyJson.json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return null
        return Action(
            categoryId = o["categoryId"]?.jsonPrimitive?.contentOrNull ?: return null,
            budgetId = o["budgetId"]?.jsonPrimitive?.contentOrNull ?: return null,
            body = (o["body"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
            before = (o["before"] as? JsonObject)?.let(::decodeBudget),
        )
    }

    /**
     * Terminal failure: the hub never took the edit, so put the record it
     * replaced back — or drop the row entirely when there was none (a failed
     * create). The next reconcile would also fix it, but only while online.
     */
    fun healed(list: List<Budget>, a: Action): List<Budget> {
        val without = list.filterNot { it.id == a.budgetId || it.categoryId == a.categoryId }
        return if (a.before == null) without else without + a.before
    }

    private fun encodeBudget(b: Budget): JsonObject = buildJsonObject {
        put("id", b.id)
        put("categoryId", b.categoryId)
        put("monthlyTargetPence", b.monthlyTargetPence)
        b.rollover?.let { put("rollover", it) }
        b.notes?.let { put("notes", it) }
    }

    private fun decodeBudget(o: JsonObject): Budget? {
        val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return null
        val categoryId = o["categoryId"]?.jsonPrimitive?.contentOrNull ?: return null
        return Budget(
            id = id,
            categoryId = categoryId,
            monthlyTargetPence = o["monthlyTargetPence"]?.jsonPrimitive?.longOrNull ?: 0L,
            rollover = (o["rollover"] as? JsonPrimitive)?.let { runCatching { it.content.toBoolean() }.getOrNull() },
            notes = (o["notes"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
        )
    }
}
