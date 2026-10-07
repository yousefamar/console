package io.amar.console.data.money

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * Pure helpers behind `money:category` + `money:rule` — the phone's half of the
 * SPA's `CategoriesView.tsx` (`upsertCategory` / `deleteCategory` /
 * `upsertRule` / `deleteRule` in `src/store/finance.ts`).
 *
 * Outbox keying: the hub's `upsertCategory` / `upsertRule` honour a
 * client-supplied `id` (`id: input.id ?? mint()`), so the phone mints the id
 * itself in the hub's own shape (`cat_<8 hex>` / `rule_<8 hex>`). The entity
 * therefore has its real identity BEFORE the write lands — no temp id, no
 * swap on the way back, and a delete of a never-synced row addresses the same
 * id the hub would have stored. Edits are a POST of the whole record (the
 * hub's POST is an upsert: `Object.assign(existing, input)`), never a PATCH.
 */
object MoneyCategories {
    const val KIND_INCOME = "income"
    const val KIND_EXPENSE = "expense"
    const val KIND_TRANSFER = "transfer"
    val KINDS = listOf(KIND_INCOME, KIND_EXPENSE, KIND_TRANSFER)

    const val DEFAULT_EMOJI = "🏷️" // 🏷️ — the hub's default
    const val DEFAULT_COLOR = "#94a3b8"
    const val DEFAULT_PRIORITY = 50

    /** The SPA's colour input is a free picker; the phone offers the Tailwind-400 set the seeds use. */
    val SWATCHES = listOf(
        "#f87171", "#fb923c", "#fbbf24", "#facc15", "#a3e635", "#4ade80", "#34d399", "#2dd4bf",
        "#22d3ee", "#38bdf8", "#60a5fa", "#818cf8", "#a78bfa", "#c084fc", "#e879f9", "#f472b6",
        "#fb7185", "#94a3b8",
    )

    fun mintCategoryId(uuid: String = UUID.randomUUID().toString()): String = "cat_" + uuid.replace("-", "").take(8)
    fun mintRuleId(uuid: String = UUID.randomUUID().toString()): String = "rule_" + uuid.replace("-", "").take(8)

    /** `#abc` / `#aabbcc` / `aabbcc` → `#aabbcc`; null when it isn't a hex colour. */
    fun normaliseHex(input: String): String? {
        val s = input.trim().removePrefix("#").lowercase()
        if (!s.all { it in '0'..'9' || it in 'a'..'f' }) return null
        return when (s.length) {
            3 -> "#" + s.map { "$it$it" }.joinToString("")
            6 -> "#$s"
            else -> null
        }
    }

    // ---- Categories -------------------------------------------------------

    /** Live categories grouped the SPA way (income → expense → transfer), archived behind [showArchived]. */
    fun grouped(categories: List<MoneyCategory>, showArchived: Boolean): List<Pair<String, List<MoneyCategory>>> =
        KINDS.map { kind -> kind to categories.filter { it.kind == kind && (showArchived || !it.archived) } }
            .filter { it.second.isNotEmpty() }

    /** The hub 400s on a system category (`cat_transfer` / `cat_uncat`); don't even offer it. */
    fun canDelete(c: MoneyCategory): Boolean = !c.isSystem

    /** POST `/finance/categories` body — the whole record, id included (the hub's upsert honours it). */
    fun categoryBody(c: MoneyCategory): String = MoneyJson.categoryJson(c).toString()

    /** Replace-or-append by id. */
    fun upsertInto(list: List<MoneyCategory>, c: MoneyCategory): List<MoneyCategory> {
        val idx = list.indexOfFirst { it.id == c.id }
        return if (idx >= 0) list.toMutableList().also { it[idx] = c } else list + c
    }

    /**
     * What the hub's `deleteCategory` cascades: the rules pointing at the
     * category go, so do its budgets (streams and overrides merely lose the
     * pointer — the phone caches neither). Mirrored optimistically so the lists
     * agree with the hub before the refresh.
     */
    data class Cascade(val rules: List<MoneyRule>, val budgets: List<Budget>)

    fun cascadeOf(categoryId: String, rules: List<MoneyRule>, budgets: List<Budget>): Cascade =
        Cascade(rules.filter { it.categoryId == categoryId }, budgets.filter { it.categoryId == categoryId })

    /**
     * A hub category list with the still-queued local edits laid back over it:
     * an in-flight id present locally wins, one absent locally (a queued
     * delete) stays gone. [settled] is the id whose write just landed — its
     * own outbox row is still `processing` while the handler refreshes, so it
     * must not count (the ^loud-frog / ^busy-vole rule).
     */
    fun withInFlightCategories(
        hubList: List<MoneyCategory>,
        local: List<MoneyCategory>,
        inFlightIds: Set<String>,
    ): List<MoneyCategory> {
        if (inFlightIds.isEmpty()) return hubList
        val localById = local.associateBy { it.id }
        val out = hubList.filterNot { it.id in inFlightIds }.toMutableList()
        for (id in inFlightIds) localById[id]?.let(out::add)
        return out
    }

    /**
     * Same for rules, plus one cross-entity rule: a rule whose category is
     * being deleted (in flight, absent locally) is dropped too — the hub will
     * cascade it, and resurrecting it for one reconcile would flicker.
     */
    fun withInFlightRules(
        hubList: List<MoneyRule>,
        local: List<MoneyRule>,
        inFlightRuleIds: Set<String>,
        deletingCategoryIds: Set<String> = emptySet(),
    ): List<MoneyRule> {
        if (inFlightRuleIds.isEmpty() && deletingCategoryIds.isEmpty()) return hubList
        val localById = local.associateBy { it.id }
        val out = hubList.filterNot { it.id in inFlightRuleIds || it.categoryId in deletingCategoryIds }.toMutableList()
        for (id in inFlightRuleIds) localById[id]?.let(out::add)
        return sorted(out)
    }

    /** Category ids with a queued action but no local row = queued deletes. */
    fun deletingCategoryIds(inFlightIds: Set<String>, local: List<MoneyCategory>): Set<String> {
        if (inFlightIds.isEmpty()) return emptySet()
        val have = local.mapTo(HashSet()) { it.id }
        return inFlightIds.filterNotTo(HashSet()) { it in have }
    }

    // ---- Rules ------------------------------------------------------------

    /** The hub sorts by priority on every write (stable); ties keep the hub's order, so sort by id for determinism. */
    fun sorted(rules: List<MoneyRule>): List<MoneyRule> = rules.sortedWith(compareBy({ it.priority }, { it.id }))

    /** SPA `describeMatch`: `merchant ~ "tesco" AND amount < 0`, or `(empty)`. */
    fun describeMatch(m: RuleMatch): String {
        val parts = ArrayList<String>(5)
        m.merchantContains?.let { parts += "merchant ~ \"$it\"" }
        m.descriptionContains?.let { parts += "description ~ \"$it\"" }
        m.counterpartyContains?.let { parts += "counterparty ~ \"$it\"" }
        m.amountSign?.let { parts += "amount " + if (it == "in") "> 0" else "< 0" }
        m.monzoCategoryEquals?.let { parts += "monzo cat = \"$it\"" }
        return if (parts.isEmpty()) "(empty)" else parts.joinToString(" AND ")
    }

    /** Row title: the label, else the match description (SPA `r.label || describeMatch`). */
    fun ruleTitle(r: MoneyRule): String = r.label ?: describeMatch(r.match)

    /**
     * POST `/finance/rules` body. On an EDIT the optional fields that are now
     * empty go as `null`: the hub's upsert is `Object.assign(existing, input)`,
     * so an omitted key keeps the old value and a cleared label / share would
     * silently survive (the SPA has exactly that bug — `undefined` drops out
     * of its JSON). `match` is replaced wholesale, so its fields need no nulls.
     */
    fun ruleBody(r: MoneyRule, isEdit: Boolean): String = MoneyJson.ruleJson(r, nullsForCleared = isEdit).toString()

    /** `"0.5"` / `" 1"` → the share clamped to 0..1; null for blank; NaN-safe. */
    fun parseShare(input: String): Double? {
        val t = input.trim()
        if (t.isEmpty()) return null
        val v = t.toDoubleOrNull() ?: return null
        if (!v.isFinite()) return null
        return v.coerceIn(0.0, 1.0)
    }

    /** `0.5` → `0.5`, `1.0` → `1`, `0.333…` → `0.33` — what the share field starts with. */
    fun formatShare(v: Double): String {
        val s = "%.2f".format(java.util.Locale.ROOT, v).trimEnd('0').trimEnd('.')
        return s.ifEmpty { "0" }
    }

    fun upsertInto(list: List<MoneyRule>, r: MoneyRule): List<MoneyRule> {
        val idx = list.indexOfFirst { it.id == r.id }
        return sorted(if (idx >= 0) list.toMutableList().also { it[idx] = r } else list + r)
    }

    // ---- Outbox payloads: the request plus everything the heal needs -----

    data class CategoryAction(
        val categoryId: String,
        /** POST body; null = DELETE `/finance/categories/<id>`. */
        val body: String?,
        /** The record this edit replaced (null = a create). */
        val before: MoneyCategory?,
        /** What a delete dropped alongside it, so a refused delete puts them back. */
        val beforeRules: List<MoneyRule> = emptyList(),
        val beforeBudgets: List<Budget> = emptyList(),
    )

    fun encodeCategoryAction(a: CategoryAction): String = buildJsonObject {
        put("categoryId", a.categoryId)
        put("body", a.body?.let { JsonPrimitive(it) } ?: JsonNull)
        put("before", a.before?.let(MoneyJson::categoryJson) ?: JsonNull)
        put("beforeRules", JsonArray(a.beforeRules.map { MoneyJson.ruleJson(it) }))
        put("beforeBudgets", JsonArray(a.beforeBudgets.map(::budgetJson)))
    }.toString()

    fun decodeCategoryAction(payload: String): CategoryAction? {
        val o = runCatching { MoneyJson.json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return null
        return CategoryAction(
            categoryId = o["categoryId"]?.jsonPrimitive?.contentOrNull ?: return null,
            body = (o["body"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
            before = (o["before"] as? JsonObject)?.let(MoneyJson::parseCategory),
            beforeRules = MoneyJson.parseRuleArray(o["beforeRules"]),
            beforeBudgets = MoneyJson.parseBudgetArray(o["beforeBudgets"]),
        )
    }

    data class RuleAction(
        val ruleId: String,
        /** POST body; null = DELETE `/finance/rules/<id>`. */
        val body: String?,
        val before: MoneyRule?,
    )

    fun encodeRuleAction(a: RuleAction): String = buildJsonObject {
        put("ruleId", a.ruleId)
        put("body", a.body?.let { JsonPrimitive(it) } ?: JsonNull)
        put("before", a.before?.let { MoneyJson.ruleJson(it) } ?: JsonNull)
    }.toString()

    fun decodeRuleAction(payload: String): RuleAction? {
        val o = runCatching { MoneyJson.json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return null
        return RuleAction(
            ruleId = o["ruleId"]?.jsonPrimitive?.contentOrNull ?: return null,
            body = (o["body"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
            before = (o["before"] as? JsonObject)?.let(MoneyJson::parseRule),
        )
    }

    /**
     * Terminal failure of a category write: the hub never took it, so put back
     * the record it replaced — or drop the row for a failed create. A refused
     * DELETE (a system category, say) also restores the rules and budgets the
     * optimistic cascade removed.
     */
    fun healedCategories(list: List<MoneyCategory>, a: CategoryAction): List<MoneyCategory> {
        val without = list.filterNot { it.id == a.categoryId }
        return if (a.before == null) without else without + a.before
    }

    fun healedRulesAfterCategory(list: List<MoneyRule>, a: CategoryAction): List<MoneyRule> {
        if (a.body != null || a.beforeRules.isEmpty()) return list
        val have = list.mapTo(HashSet()) { it.id }
        return sorted(list + a.beforeRules.filterNot { it.id in have })
    }

    fun healedBudgetsAfterCategory(list: List<Budget>, a: CategoryAction): List<Budget> {
        if (a.body != null || a.beforeBudgets.isEmpty()) return list
        val have = list.mapTo(HashSet()) { it.id }
        return list + a.beforeBudgets.filterNot { it.id in have }
    }

    fun healedRules(list: List<MoneyRule>, a: RuleAction): List<MoneyRule> {
        val without = list.filterNot { it.id == a.ruleId }
        return sorted(if (a.before == null) without else without + a.before)
    }

    private fun budgetJson(b: Budget): JsonObject = buildJsonObject {
        put("id", b.id)
        put("categoryId", b.categoryId)
        put("monthlyTargetPence", b.monthlyTargetPence)
        b.rollover?.let { put("rollover", it) }
        b.notes?.let { put("notes", it) }
    }
}
