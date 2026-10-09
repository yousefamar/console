package io.amar.console.data.money

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
 * Pure helpers behind `money:account` — the phone's half of the SPA's
 * `NetWorthView.tsx` "Add account" button + account editor (`upsertAccount` /
 * `deleteAccount` in `src/store/finance.ts`).
 *
 * Outbox keying, as for the taxonomy ([MoneyCategories]): the hub's
 * `upsertAccount` honours a client-supplied `id` (`id: input.id ?? mint()`), so
 * the phone mints it in the hub's own shape (`acc_<8 hex>`). The record has its
 * real identity BEFORE the write lands — no temp id, no swap on the way back,
 * and a delete of a never-synced row addresses the id the hub would have
 * stored. Edits are a POST of the whole record (the hub's POST is an upsert),
 * never a PATCH.
 *
 * Three hub behaviours this module exists to respect:
 *
 *  1. The upsert is `Object.assign(existing, input)`, so an EDIT must send the
 *     optionals that are now empty as `null` — see [accountBody]. The hub
 *     removes a null key instead of storing it (9 Oct 2026).
 *  2. A write body never carries the `ledger` ([accountBody] passes
 *     `includeLedger = false`): the ledger is owned by `money:balance`. A hub
 *     older than 9 Oct 2026 let one REPLACE the balance history; it is ignored
 *     now, and we still never send it.
 *  3. A hub older than 9 Oct 2026 dropped `growthPctYoy` and `archived` on a
 *     CREATE. [patchBody] is the follow-up PATCH that put them back and
 *     [needsPatch] says when; it only repeats what the POST now stores.
 *
 * Monzo accounts are not hand-editable here beyond their metadata: their
 * `type` / `monzoAccountId` link is the desktop's to define and deleting one
 * would strand the Monzo mirror, so [canDelete] refuses it ([toAccount] never
 * rewrites either field).
 */
object MoneyAccounts {
    const val TYPE_MANUAL = "manual"
    const val TYPE_MONZO = "monzo"

    const val LIQUID = "liquid"
    const val INVESTMENT = "investment"
    const val ILLIQUID = "illiquid"

    /** Liquidity keys in the SPA's display order, with its section headings. */
    val LIQUIDITY_LABELS = listOf(
        LIQUID to "Liquid",
        INVESTMENT to "Investments",
        ILLIQUID to "Illiquid / external",
    )
    val LIQUIDITIES = LIQUIDITY_LABELS.map { it.first }

    /** What each choice means, for the editor's radio rows (the SPA's section titles spelt out). */
    val LIQUIDITY_HINTS = mapOf(
        LIQUID to "Cash, current accounts — counts toward runway",
        INVESTMENT to "ISAs, GIAs — grows, not spent down",
        ILLIQUID to "Property, pensions, held by others",
    )

    /** A small set to pick from; the SPA types an emoji freely and the field stays free here too. */
    val EMOJI_CHOICES = listOf("💳", "🏦", "💰", "📈", "🏠", "🪙", "💵", "🧾", "🎓", "🚗", "🟧", "🗄️")

    fun mintAccountId(uuid: String = UUID.randomUUID().toString()): String =
        "acc_" + uuid.replace("-", "").take(8)

    fun liquidityLabel(key: String): String =
        LIQUIDITY_LABELS.firstOrNull { it.first == key }?.second ?: key

    /**
     * The accounts list the Net worth view draws: one group per liquidity in
     * display order, archived accounts filtered out (the SPA excludes them from
     * all three groups and offers no editor for them), empty groups dropped.
     */
    fun grouped(accounts: List<Account>, showArchived: Boolean = false): List<Pair<String, List<Account>>> =
        LIQUIDITY_LABELS.map { (key, label) ->
            label to accounts
                .filter { it.liquidity == key && (showArchived || !it.archived) }
                .sortedWith(compareBy({ it.sort ?: Int.MAX_VALUE }, { it.name.lowercase() }))
        }.filter { it.second.isNotEmpty() }

    /**
     * Deleting a Monzo account would strand the mirror its `monzoAccountId`
     * points at — the link is defined on the desktop, so it is removed there
     * too. Metadata (name, liquidity, growth, …) stays editable either way.
     */
    fun canDelete(a: Account): Boolean = a.isManual

    // ---- The editor's draft ----------------------------------------------

    /**
     * What the editor holds while it is open. Strings, because every field is a
     * text input or a toggle; [toAccount] turns it back into a record keeping
     * everything the phone must not rewrite (ledger, type, Monzo link, sort).
     */
    data class Draft(
        val name: String = "",
        val liquidity: String = LIQUID,
        val emoji: String = "",
        val isExternal: Boolean = false,
        /** Annual %, blank = unset — which is MEANINGFUL (see [Account.growthPctYoy]). */
        val growth: String = "",
        val notes: String = "",
    )

    fun draftOf(a: Account?): Draft = if (a == null) Draft() else Draft(
        name = a.name,
        liquidity = a.liquidity,
        emoji = a.emoji ?: "",
        isExternal = a.isExternal,
        growth = a.growthPctYoy?.let(::formatGrowth) ?: "",
        notes = a.notes ?: "",
    )

    /** Null when the draft can be saved, else why not (shown under the field). */
    fun validate(d: Draft): String? = when {
        d.name.isBlank() -> "Name it first"
        d.liquidity !in LIQUIDITIES -> "Pick a liquidity"
        !growthValid(d.growth) -> "Growth must be a number, e.g. 3.25"
        else -> null
    }

    /**
     * The record to write. [existing] is the account being edited (null for a
     * create): its ledger, type, Monzo link and sort are carried through
     * untouched — the phone never redefines any of them — and a create is
     * always `manual` with no sort, which the hub assigns.
     */
    fun toAccount(d: Draft, existing: Account?, id: String = mintAccountId()): Account = Account(
        id = existing?.id ?: id,
        name = d.name.trim(),
        type = existing?.type ?: TYPE_MANUAL,
        liquidity = d.liquidity,
        currency = existing?.currency ?: "GBP",
        emoji = d.emoji.trim().takeIf { it.isNotEmpty() },
        color = existing?.color,
        monzoAccountId = existing?.monzoAccountId,
        isExternal = d.isExternal,
        sort = existing?.sort,
        notes = d.notes.trim().takeIf { it.isNotEmpty() },
        archived = existing?.archived ?: false,
        growthPctYoy = parseGrowth(d.growth),
        ledger = existing?.ledger ?: emptyList(),
    )

    /** `""` → null (unset), `"3.25"` → 3.25. Null for junk too — gate on [growthValid] first. */
    fun parseGrowth(input: String): Double? {
        val t = input.trim().removeSuffix("%").trim()
        if (t.isEmpty()) return null
        val v = t.toDoubleOrNull() ?: return null
        return if (v.isFinite()) v else null
    }

    /** Blank (= clear it) or a finite number. */
    fun growthValid(input: String): Boolean {
        val t = input.trim().removeSuffix("%").trim()
        return t.isEmpty() || (t.toDoubleOrNull()?.isFinite() == true)
    }

    /** `3.25` → `3.25`, `6.0` → `6` — what the growth field starts with. */
    fun formatGrowth(v: Double): String {
        val s = "%.2f".format(java.util.Locale.ROOT, v).trimEnd('0').trimEnd('.')
        return s.ifEmpty { "0" }
    }

    /** What the row's subtitle says about the projection assumption. */
    fun growthSummary(a: Account): String = when {
        a.growthPctYoy != null -> "${formatGrowth(a.growthPctYoy)}% a year"
        a.liquidity == INVESTMENT -> "growth: the global investment rate"
        else -> "no growth"
    }

    // ---- Requests ---------------------------------------------------------

    /**
     * POST `/finance/accounts` body: the whole record, id included, and on an
     * EDIT the now-empty optionals as explicit `null`s (reason in the class
     * doc). Never the ledger — that would overwrite the hub's balance history.
     */
    fun accountBody(a: Account, isEdit: Boolean): String =
        MoneyJson.accountJson(a, nullsForCleared = isEdit, includeLedger = false).toString()

    /**
     * A hub older than 9 Oct 2026 omitted `growthPctYoy` and `archived` on a
     * create, so a new account carrying either gets one PATCH behind its POST
     * (the PATCH goes through `{...existing, ...patch}`, which applies them).
     */
    fun needsPatch(a: Account, isEdit: Boolean): Boolean =
        !isEdit && (a.growthPctYoy != null || a.archived)

    fun patchBody(a: Account): String = buildJsonObject {
        put("growthPctYoy", a.growthPctYoy?.let { JsonPrimitive(it) } ?: JsonNull)
        put("archived", JsonPrimitive(a.archived))
    }.toString()

    fun path(accountId: String): String =
        "/finance/accounts/" + java.net.URLEncoder.encode(accountId, "UTF-8")

    /** Replace-or-append by id. */
    fun upsertInto(list: List<Account>, a: Account): List<Account> {
        val idx = list.indexOfFirst { it.id == a.id }
        return if (idx >= 0) list.toMutableList().also { it[idx] = a } else list + a
    }

    // ---- Reconcile overlays ----------------------------------------------

    /**
     * A hub account list with the still-queued local edits laid back over it:
     * an in-flight id present locally wins, one absent locally (a queued
     * delete) stays gone. Without this, every reconcile while the write sits in
     * the outbox re-applies the pre-edit copy and the rename visibly reverts.
     *
     * The caller subtracts the id whose write just landed — its own row is
     * still `processing` while the handler refreshes, so counting it would keep
     * our optimistic guess over the hub's now-authoritative record (the
     * ^loud-frog / ^busy-vole rule).
     *
     * A local overlay keeps the HUB's ledger when it has one: `money:balance`
     * owns that list, and an account edit knows nothing about readings logged
     * from elsewhere since this phone last reconciled.
     */
    fun withInFlightAccounts(
        hubList: List<Account>,
        local: List<Account>,
        inFlightIds: Set<String>,
    ): List<Account> {
        if (inFlightIds.isEmpty()) return hubList
        val localById = local.associateBy { it.id }
        val hubIds = hubList.mapTo(HashSet()) { it.id }
        val out = ArrayList<Account>(hubList.size + inFlightIds.size)
        for (a in hubList) {
            if (a.id !in inFlightIds) out += a
            // Absent locally = a queued delete; it stays gone.
            else localById[a.id]?.let { out += it.copy(ledger = a.ledger) }
        }
        // A create the hub hasn't got yet keeps its own (empty) ledger.
        for (id in inFlightIds) if (id !in hubIds) localById[id]?.let { out += it }
        return out
    }

    /** Account ids with a queued action but no local row = queued deletes. */
    fun deletingAccountIds(inFlightIds: Set<String>, local: List<Account>): Set<String> {
        if (inFlightIds.isEmpty()) return emptySet()
        val have = local.mapTo(HashSet()) { it.id }
        return inFlightIds.filterNotTo(HashSet()) { it in have }
    }

    // ---- Outbox payload: the request plus everything the heal needs ------

    data class AccountAction(
        val accountId: String,
        /** POST body; null = DELETE `/finance/accounts/<id>`. */
        val body: String?,
        /** The record this edit replaced (null = a create) — the heal puts it back. */
        val before: Account?,
        /** Follow-up PATCH after a create, for the fields the hub's create branch drops. */
        val patch: String? = null,
    )

    fun encodeAccountAction(a: AccountAction): String = buildJsonObject {
        put("accountId", a.accountId)
        put("body", a.body?.let { JsonPrimitive(it) } ?: JsonNull)
        // The heal restores the ledger too, so `before` keeps it (unlike a write body).
        put("before", a.before?.let { MoneyJson.accountJson(it) } ?: JsonNull)
        put("patch", a.patch?.let { JsonPrimitive(it) } ?: JsonNull)
    }.toString()

    fun decodeAccountAction(payload: String): AccountAction? {
        val o = runCatching { MoneyJson.json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return null
        return AccountAction(
            accountId = o["accountId"]?.jsonPrimitive?.contentOrNull ?: return null,
            body = (o["body"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
            before = (o["before"] as? JsonObject)?.let(MoneyJson::parseAccount),
            patch = (o["patch"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
        )
    }

    /**
     * Terminal failure of an account write: the hub never took it, so put back
     * the record it replaced — or drop the row for a failed create. The restored
     * copy carries its ledger, so a refused rename doesn't also lose the
     * readings the row was showing.
     */
    fun healedAccounts(list: List<Account>, a: AccountAction): List<Account> {
        val without = list.filterNot { it.id == a.accountId }
        return if (a.before == null) without else without + a.before
    }
}
