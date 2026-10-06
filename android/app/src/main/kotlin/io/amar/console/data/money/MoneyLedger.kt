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
import java.time.LocalDate
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToLong

/** One edit to a manual account's balance ledger. */
sealed class LedgerEdit {
    data class Add(val date: String, val balancePence: Long, val note: String? = null) : LedgerEdit()
    data class Update(val entryId: String, val date: String, val balancePence: Long, val note: String? = null) : LedgerEdit()
    data class Delete(val entryId: String) : LedgerEdit()
}

/**
 * Pure helpers behind `money:balance` — the manual-account balance ledger
 * (`POST/PATCH/DELETE /finance/accounts/:id/balance[/:entryId]`, port of the
 * SPA's `Ledger` in `src/components/money/NetWorthView.tsx` plus the hub's
 * sort-on-write in `server/src/finance/store.ts`).
 *
 * Only Monzo auto-syncs; every other account (Lloyds, Revolut, ISAs, GIAs) is a
 * manual account whose balance is this ledger, logged whenever he checks it —
 * which happens on the phone.
 */
object MoneyLedger {

    /** An outbox-ready HTTP request for [edit]. */
    data class Request(val method: String, val path: String, val body: String?)

    fun requestFor(accountId: String, edit: LedgerEdit): Request {
        val base = "/finance/accounts/${enc(accountId)}/balance"
        return when (edit) {
            is LedgerEdit.Add -> Request("POST", base, entryBody(edit.date, edit.balancePence, edit.note, clearNote = false))
            is LedgerEdit.Update -> Request("PATCH", "$base/${enc(edit.entryId)}", entryBody(edit.date, edit.balancePence, edit.note, clearNote = true))
            is LedgerEdit.Delete -> Request("DELETE", "$base/${enc(edit.entryId)}", null)
        }
    }

    /**
     * A PATCH is a merge (`{...entry, ...patch}` server-side), so an edit that
     * CLEARED the note must send an empty string — omitting the key would keep
     * the old note. A fresh POST just leaves it out, like the SPA.
     */
    private fun entryBody(date: String, balancePence: Long, note: String?, clearNote: Boolean): String = buildJsonObject {
        put("date", date)
        put("balancePence", balancePence)
        val n = note?.takeIf { it.isNotBlank() }
        if (n != null) put("note", n) else if (clearNote) put("note", "")
    }.toString()

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")

    // ---- Optimistic state ----

    /**
     * [account] with [edit] applied the way the hub would: entries sorted by
     * date, an add getting a local id until the real entry comes back. A
     * [LedgerEdit.Update]/[LedgerEdit.Delete] naming an unknown entry is a
     * no-op (the hub answers 404 and the row resolves as Done).
     */
    fun optimistic(account: Account, edit: LedgerEdit, localId: String = localId()): Account {
        val ledger = when (edit) {
            is LedgerEdit.Add -> account.ledger + BalanceEntry(localId, edit.date, edit.balancePence, edit.note?.takeIf { it.isNotBlank() })
            is LedgerEdit.Update -> account.ledger.map {
                if (it.id != edit.entryId) it
                else it.copy(date = edit.date, balancePence = edit.balancePence, note = edit.note?.takeIf { n -> n.isNotBlank() })
            }
            is LedgerEdit.Delete -> account.ledger.filter { it.id != edit.entryId }
        }
        return account.copy(ledger = sorted(ledger))
    }

    /** The hub's own order: oldest first, `date.localeCompare` (a stable sort). */
    fun sorted(ledger: List<BalanceEntry>): List<BalanceEntry> = ledger.sortedBy { it.date }

    /** Render order: newest reading first (SPA `Ledger`). */
    fun newestFirst(ledger: List<BalanceEntry>): List<BalanceEntry> = ledger.sortedByDescending { it.date }

    fun localId(): String = "${BalanceEntry.LOCAL_PREFIX}${java.util.UUID.randomUUID().toString().take(8)}"

    /** Replace [accountId]'s row in [accounts], keeping list order. */
    fun replace(accounts: List<Account>, updated: Account): List<Account> =
        accounts.map { if (it.id == updated.id) updated else it }

    /** Terminal-failure heal: put the account's pre-edit ledger back. */
    fun healed(current: Account, beforeLedger: List<BalanceEntry>): Account = current.copy(ledger = sorted(beforeLedger))

    // ---- Form input ----

    /**
     * SPA `Math.round(parseFloat(pounds) * 100)`: a pounds string → pence, or
     * null when it isn't a finite number. Accepts a leading `£`, thousands
     * separators and a bare `-`-prefixed overdraft.
     */
    fun parsePounds(text: String): Long? {
        val cleaned = text.trim().removePrefix("£").replace(",", "").replace(" ", "")
        if (cleaned.isEmpty() || cleaned == "-" || cleaned == "." || cleaned == "-.") return null
        val d = cleaned.toDoubleOrNull() ?: return null
        if (!d.isFinite()) return null
        return (d * 100).roundToLong()
    }

    /** Pence → an editable pounds string (always 2dp, no grouping, no `£`). */
    fun poundsInput(pence: Long): String {
        val sign = if (pence < 0) "-" else ""
        return sign + String.format(Locale.UK, "%d.%02d", abs(pence) / 100, abs(pence) % 100)
    }

    fun today(): String = LocalDate.now().toString()

    /** `2026-10-06` → `6 Oct 2026`, falling back to the raw string. */
    fun fmtDate(date: String): String = runCatching {
        LocalDate.parse(date).format(java.time.format.DateTimeFormatter.ofPattern("d MMM yyyy", MoneyFormat.MONTH_LOCALE))
    }.getOrDefault(date)

    // ---- Outbox payload: the request plus everything the heal needs ----

    data class Action(
        val accountId: String,
        val method: String,
        val path: String,
        /** JSON body for POST/PATCH; null for DELETE. */
        val body: String?,
        val beforeLedger: List<BalanceEntry>,
    )

    fun action(account: Account, edit: LedgerEdit): Action {
        val r = requestFor(account.id, edit)
        return Action(account.id, r.method, r.path, r.body, account.ledger)
    }

    fun encodeAction(a: Action): String = buildJsonObject {
        put("accountId", a.accountId)
        put("method", a.method)
        put("path", a.path)
        put("body", a.body?.let { JsonPrimitive(it) } ?: JsonNull)
        put("beforeLedger", JsonArray(a.beforeLedger.map(MoneyJson::balanceEntryJson)))
    }.toString()

    fun decodeAction(payload: String): Action? {
        val o = runCatching { MoneyJson.json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return null
        return Action(
            accountId = o["accountId"]?.jsonPrimitive?.contentOrNull ?: return null,
            method = o["method"]?.jsonPrimitive?.contentOrNull ?: return null,
            path = o["path"]?.jsonPrimitive?.contentOrNull ?: return null,
            body = (o["body"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
            beforeLedger = MoneyJson.parseLedger(o["beforeLedger"]),
        )
    }

    /** The hub's reply to a POST/PATCH is the stored entry. */
    fun parseEntryResponse(body: String): BalanceEntry? =
        runCatching { MoneyJson.json.parseToJsonElement(body).jsonObject }.getOrNull()
            ?.let(MoneyJson::parseBalanceEntry)
}
