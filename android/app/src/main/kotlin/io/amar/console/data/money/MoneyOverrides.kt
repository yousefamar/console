package io.amar.console.data.money

import io.amar.console.data.db.MoneyTxRow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Per-transaction override (`finance-tx-overrides.json`) — the slice of the
 * hub's `TxOverride` the phone edits. The hub's POST is a MERGE upsert, so any
 * field we don't send (pairedTxId, sharedFraction, …) survives an edit here.
 */
data class TxOverride(val txId: String, val categoryId: String? = null, val ignore: Boolean? = null)

/** One edit from the transaction sheet. */
sealed class OverrideEdit {
    data class SetCategory(val categoryId: String) : OverrideEdit()
    data class Ignore(val on: Boolean) : OverrideEdit()
    data class Transfer(val on: Boolean) : OverrideEdit()
    /** Drop the override — the hub re-derives the category from its rules. */
    data object Reset : OverrideEdit()
}

/**
 * Pure helpers behind `money:override` (port of the SPA's `setOverride` /
 * `clearOverride` calls in `TransactionsView.tsx` + the override branch of the
 * hub's `effectiveCategory` in `server/src/finance/projection.ts`).
 */
object MoneyOverrides {
    /** Hub-seeded category ids `effectiveCategory` special-cases. */
    const val TRANSFER = "cat_transfer"
    const val UNCATEGORISED = "cat_uncat"

    /**
     * POST `/finance/overrides` body for [edit], or null for [OverrideEdit.Reset]
     * (a DELETE). Picking a category or a transfer always sends `ignore:false`
     * explicitly: the upsert merges, so leaving it out would keep an earlier
     * ignore and the pick would have no effect (the SPA does the same).
     */
    fun requestBody(txId: String, edit: OverrideEdit): String? = when (edit) {
        is OverrideEdit.SetCategory -> buildJsonObject { put("txId", txId); put("categoryId", edit.categoryId); put("ignore", false) }
        is OverrideEdit.Ignore -> buildJsonObject { put("txId", txId); put("ignore", edit.on) }
        is OverrideEdit.Transfer -> buildJsonObject {
            put("txId", txId); put("categoryId", if (edit.on) TRANSFER else UNCATEGORISED); put("ignore", false)
        }
        OverrideEdit.Reset -> null
    }?.toString()

    /** The override record after [edit] (null = none), mirroring the hub's merge. */
    fun mergedOverride(before: TxOverride?, txId: String, edit: OverrideEdit): TxOverride? {
        val base = before ?: TxOverride(txId)
        return when (edit) {
            is OverrideEdit.SetCategory -> base.copy(categoryId = edit.categoryId, ignore = false)
            is OverrideEdit.Ignore -> base.copy(ignore = edit.on)
            is OverrideEdit.Transfer -> base.copy(categoryId = if (edit.on) TRANSFER else UNCATEGORISED, ignore = false)
            OverrideEdit.Reset -> null
        }
    }

    /**
     * Optimistic classification of [row] under [merged] — the override branch
     * of `effectiveCategory`. A Reset (or an override with neither field)
     * leaves the row alone: falling back to the rules needs the hub, which
     * re-derives it once the write lands.
     */
    fun optimistic(row: MoneyTxRow, merged: TxOverride?): MoneyTxRow = when {
        merged == null -> row
        merged.ignore == true -> row.copy(categoryId = merged.categoryId ?: row.categoryId ?: UNCATEGORISED, ignored = true, isTransfer = false)
        merged.categoryId != null -> row.copy(categoryId = merged.categoryId, ignored = false, isTransfer = merged.categoryId == TRANSFER)
        else -> row.copy(ignored = false, isTransfer = row.categoryId == TRANSFER)
    }

    // ---- Outbox payload: the request plus everything the heal needs ----

    data class Action(
        val txId: String,
        /** POST body; null = DELETE. */
        val body: String?,
        val before: TxClassification?,
        val beforeOverride: TxOverride?,
    )

    fun encodeAction(a: Action): String = buildJsonObject {
        put("txId", a.txId)
        put("body", a.body?.let { JsonPrimitive(it) } ?: JsonNull)
        put("before", a.before?.let {
            buildJsonObject { put("categoryId", it.categoryId); put("ignored", it.ignored); put("isTransfer", it.isTransfer) }
        } ?: JsonNull)
        put("beforeOverride", a.beforeOverride?.let(::encodeOverride) ?: JsonNull)
    }.toString()

    fun decodeAction(payload: String): Action? {
        val o = runCatching { MoneyJson.json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return null
        val txId = o["txId"]?.jsonPrimitive?.contentOrNull ?: return null
        val before = (o["before"] as? JsonObject)?.let { b ->
            val cat = b["categoryId"]?.jsonPrimitive?.contentOrNull ?: return@let null
            TxClassification(cat, b["ignored"]?.jsonPrimitive?.booleanOrNull ?: false, b["isTransfer"]?.jsonPrimitive?.booleanOrNull ?: false)
        }
        return Action(
            txId = txId,
            body = (o["body"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
            before = before,
            beforeOverride = (o["beforeOverride"] as? JsonObject)?.let(::decodeOverride),
        )
    }

    /** Terminal-failure heal: put the row's pre-edit classification back. */
    fun healed(current: MoneyTxRow, before: TxClassification?): MoneyTxRow =
        if (before == null) current
        else current.copy(categoryId = before.categoryId, ignored = before.ignored, isTransfer = before.isTransfer)

    // ---- `GET /finance/overrides` + the meta-table cache ----

    fun parseOverrides(body: String): Map<String, TxOverride> {
        val arr = runCatching { MoneyJson.json.parseToJsonElement(body) as? JsonArray }.getOrNull() ?: return emptyMap()
        return arr.mapNotNull { (it as? JsonObject)?.let(::decodeOverride) }.associateBy { it.txId }
    }

    fun encodeOverrides(map: Map<String, TxOverride>): String =
        JsonArray(map.values.map(::encodeOverride)).toString()

    private fun encodeOverride(o: TxOverride): JsonObject = buildJsonObject {
        put("txId", o.txId)
        o.categoryId?.let { put("categoryId", it) }
        o.ignore?.let { put("ignore", it) }
    }

    private fun decodeOverride(o: JsonObject): TxOverride? {
        val id = o["txId"]?.jsonPrimitive?.contentOrNull ?: return null
        return TxOverride(id, o["categoryId"]?.jsonPrimitive?.contentOrNull, o["ignore"]?.jsonPrimitive?.booleanOrNull)
    }
}
