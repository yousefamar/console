package io.amar.console.data.money

import io.amar.console.data.db.MoneyTxRow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor

/**
 * Pure Money-pane models + parsers + formatters — ports of the SPA's
 * `src/store/finance.ts` (fmtPence, RunwaySummary) and `src/store/money.ts`
 * (getDisplayName / getReference / getMerchantEmoji / formatAmountAbs).
 * No Android imports: everything here is unit-tested on the JVM.
 */

/** `/finance/projection` → `runway` (server RunwaySummary). `Infinity` serialises
 *  to JSON null, so `monthsToFloor == null` means the floor is never breached. */
data class Runway(
    val liquidPence: Long,
    val investmentPence: Long,
    val totalPence: Long,
    val emergencyFundPence: Long,
    /** Signed: negative = burning. */
    val monthlyBurnPence: Long,
    val monthsToFloor: Double?,
    /** YYYY-MM */
    val floorDate: String?,
    val monthsToZero: Double?,
    val zeroDate: String?,
) {
    val neverHitsFloor: Boolean get() = monthsToFloor == null || !monthsToFloor.isFinite()
}

/** Emergency-fund setting, for the RunwayCard hint (`/finance/all` → settings). */
data class EmergencyFund(val mode: String, val months: Int?)

/** One `/finance/networth/history` point (server NetWorthSnapshot, byAccount dropped). */
data class NetWorthPoint(
    /** YYYY-MM-DD (month end) */
    val date: String,
    val liquidPence: Long,
    val investmentPence: Long,
    val totalPence: Long,
)

data class MoneyCategory(
    val id: String,
    val name: String,
    val emoji: String,
    /** Hex like `#a78bfa`. */
    val color: String,
    val kind: String,
)

/** `/finance/categorise` row: the effective category for one transaction. */
data class TxClassification(val categoryId: String, val ignored: Boolean, val isTransfer: Boolean)

/** `/money/status`. */
data class MoneyStatus(
    val connected: Boolean,
    val hasCredentials: Boolean,
    val lastSync: String?,
    val transactionCount: Int,
)

data class ProjectionResult(val runway: Runway, val emergencyFundPence: Long)

object MoneyJson {
    val json = Json { ignoreUnknownKeys = true }

    private fun JsonElement?.longOr(default: Long = 0): Long = when (this) {
        null, is JsonNull -> default
        is JsonPrimitive -> longOrNull ?: doubleOrNull?.let { floor(it).toLong() } ?: default
        else -> default
    }

    private fun JsonElement?.doubleOrNullSafe(): Double? = when (this) {
        null, is JsonNull -> null
        is JsonPrimitive -> doubleOrNull
        else -> null
    }

    private fun JsonElement?.str(): String? = when (this) {
        null, is JsonNull -> null
        is JsonPrimitive -> if (isString) content else contentOrNull
        else -> null
    }

    private fun JsonElement?.bool(default: Boolean = false): Boolean = when (this) {
        null, is JsonNull -> default
        is JsonPrimitive -> booleanOrNull ?: default
        else -> default
    }

    fun parseProjection(body: String): ProjectionResult? {
        val root = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
        val r = root["runway"] as? JsonObject ?: return null
        val runway = Runway(
            liquidPence = r["liquidPence"].longOr(),
            investmentPence = r["investmentPence"].longOr(),
            totalPence = r["totalPence"].longOr(),
            emergencyFundPence = r["emergencyFundPence"].longOr(),
            monthlyBurnPence = r["monthlyBurnPence"].longOr(),
            monthsToFloor = r["monthsToFloor"].doubleOrNullSafe(),
            floorDate = r["floorDate"].str(),
            monthsToZero = r["monthsToZero"].doubleOrNullSafe(),
            zeroDate = r["zeroDate"].str(),
        )
        return ProjectionResult(runway, root["emergencyFundPence"].longOr(runway.emergencyFundPence))
    }

    fun parseNetWorthHistory(body: String): List<NetWorthPoint> {
        val arr = runCatching { json.parseToJsonElement(body) as? JsonArray }.getOrNull() ?: return emptyList()
        return arr.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            NetWorthPoint(
                date = o["date"].str() ?: return@mapNotNull null,
                liquidPence = o["liquidPence"].longOr(),
                investmentPence = o["investmentPence"].longOr(),
                totalPence = o["totalPence"].longOr(),
            )
        }
    }

    /** `/finance/all` → categories (archived dropped) + emergency-fund setting. */
    fun parseCategories(allBody: String): List<MoneyCategory> {
        val root = runCatching { json.parseToJsonElement(allBody).jsonObject }.getOrNull() ?: return emptyList()
        return parseCategoryArray(root["categories"])
    }

    fun parseCategoryArray(el: JsonElement?): List<MoneyCategory> {
        val arr = el as? JsonArray ?: return emptyList()
        return arr.mapNotNull { c ->
            val o = c as? JsonObject ?: return@mapNotNull null
            if (o["archived"].bool()) return@mapNotNull null
            MoneyCategory(
                id = o["id"].str() ?: return@mapNotNull null,
                name = o["name"].str() ?: return@mapNotNull null,
                emoji = o["emoji"].str() ?: "",
                color = o["color"].str() ?: "#94a3b8",
                kind = o["kind"].str() ?: "expense",
            )
        }
    }

    fun parseEmergencyFund(allBody: String): EmergencyFund? {
        val root = runCatching { json.parseToJsonElement(allBody).jsonObject }.getOrNull() ?: return null
        val ef = (root["settings"] as? JsonObject)?.get("emergencyFund") as? JsonObject ?: return null
        return EmergencyFund(
            mode = ef["mode"].str() ?: "fixed",
            months = ef["months"].longOr(-1).toInt().takeIf { it >= 0 },
        )
    }

    fun parseClassifications(body: String): Map<String, TxClassification> {
        val root = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return emptyMap()
        val out = HashMap<String, TxClassification>(root.size)
        for ((id, v) in root) {
            val o = v as? JsonObject ?: continue
            out[id] = TxClassification(
                categoryId = o["categoryId"].str() ?: continue,
                ignored = o["ignored"].bool(),
                isTransfer = o["isTransfer"].bool(),
            )
        }
        return out
    }

    fun parseStatus(body: String): MoneyStatus? {
        val o = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
        return MoneyStatus(
            connected = o["connected"].bool(),
            hasCredentials = o["hasCredentials"].bool(),
            lastSync = o["lastSync"].str(),
            transactionCount = o["transactionCount"].longOr().toInt(),
        )
    }

    /**
     * `/money/transactions` → Room rows. `merchant` is an object, a string or
     * null (Monzo's three shapes); `counterparty` is `{}` for card payments.
     * The classification map (from `/finance/categorise`) is merged in here so
     * a row is self-contained for offline rendering.
     */
    fun parseTransactions(body: String, classes: Map<String, TxClassification> = emptyMap()): List<MoneyTxRow> {
        val arr = runCatching { json.parseToJsonElement(body) as? JsonArray }.getOrNull() ?: return emptyList()
        return arr.mapNotNull { el -> (el as? JsonObject)?.let { parseTransaction(it, classes[it["id"].str()]) } }
    }

    fun parseTransaction(o: JsonObject, cls: TxClassification?): MoneyTxRow? {
        val id = o["id"].str() ?: return null
        val merchant = o["merchant"]
        val merchantObj = merchant as? JsonObject
        val counterparty = o["counterparty"] as? JsonObject
        val created = o["created"].str() ?: ""
        return MoneyTxRow(
            id = id,
            amount = o["amount"].longOr(),
            currency = o["currency"].str() ?: "GBP",
            created = created,
            createdAt = parseIsoMs(created),
            settled = o["settled"].str() ?: "",
            description = o["description"].str() ?: "",
            merchantName = merchantObj?.get("name").str() ?: (merchant as? JsonPrimitive)?.takeIf { it.isString }?.content,
            merchantEmoji = merchantObj?.get("emoji").str()?.takeIf { it.isNotEmpty() },
            merchantLogo = merchantObj?.get("logo").str()?.takeIf { it.isNotEmpty() },
            counterpartyName = counterparty?.get("preferred_name").str()?.takeIf { it.isNotEmpty() }
                ?: counterparty?.get("name").str()?.takeIf { it.isNotEmpty() },
            monzoCategory = o["category"].str() ?: "general",
            declineReason = o["decline_reason"].str()?.takeIf { it.isNotEmpty() },
            notes = o["notes"].str()?.takeIf { it.isNotEmpty() },
            categoryId = cls?.categoryId,
            ignored = cls?.ignored ?: false,
            isTransfer = cls?.isTransfer ?: false,
        )
    }

    fun parseIsoMs(iso: String): Long =
        runCatching { Instant.parse(iso).toEpochMilli() }.getOrElse { 0L }

    // ---- Serialisation for the meta-table cache -----------------------------

    fun encodeRunway(p: ProjectionResult): String = json.encodeToString(
        kotlinx.serialization.json.JsonObject.serializer(),
        kotlinx.serialization.json.buildJsonObject {
            put("emergencyFundPence", JsonPrimitive(p.emergencyFundPence))
            put("runway", kotlinx.serialization.json.buildJsonObject {
                val r = p.runway
                put("liquidPence", JsonPrimitive(r.liquidPence))
                put("investmentPence", JsonPrimitive(r.investmentPence))
                put("totalPence", JsonPrimitive(r.totalPence))
                put("emergencyFundPence", JsonPrimitive(r.emergencyFundPence))
                put("monthlyBurnPence", JsonPrimitive(r.monthlyBurnPence))
                put("monthsToFloor", r.monthsToFloor?.let { JsonPrimitive(it) } ?: JsonNull)
                put("floorDate", r.floorDate?.let { JsonPrimitive(it) } ?: JsonNull)
                put("monthsToZero", r.monthsToZero?.let { JsonPrimitive(it) } ?: JsonNull)
                put("zeroDate", r.zeroDate?.let { JsonPrimitive(it) } ?: JsonNull)
            })
        },
    )

    fun encodeNetWorthHistory(points: List<NetWorthPoint>): String = json.encodeToString(
        JsonArray.serializer(),
        JsonArray(points.map {
            kotlinx.serialization.json.buildJsonObject {
                put("date", JsonPrimitive(it.date))
                put("liquidPence", JsonPrimitive(it.liquidPence))
                put("investmentPence", JsonPrimitive(it.investmentPence))
                put("totalPence", JsonPrimitive(it.totalPence))
            }
        }),
    )

    fun encodeCategories(cats: List<MoneyCategory>): String = json.encodeToString(
        JsonArray.serializer(),
        JsonArray(cats.map {
            kotlinx.serialization.json.buildJsonObject {
                put("id", JsonPrimitive(it.id))
                put("name", JsonPrimitive(it.name))
                put("emoji", JsonPrimitive(it.emoji))
                put("color", JsonPrimitive(it.color))
                put("kind", JsonPrimitive(it.kind))
            }
        }),
    )

    fun decodeCategories(body: String): List<MoneyCategory> =
        parseCategoryArray(runCatching { json.parseToJsonElement(body) }.getOrNull())

    fun encodeEmergencyFund(ef: EmergencyFund): String = json.encodeToString(
        JsonObject.serializer(),
        kotlinx.serialization.json.buildJsonObject {
            put("mode", JsonPrimitive(ef.mode))
            put("months", ef.months?.let { JsonPrimitive(it) } ?: JsonNull)
        },
    )

    fun decodeEmergencyFund(body: String): EmergencyFund? {
        val o = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
        return EmergencyFund(o["mode"].str() ?: "fixed", o["months"].longOr(-1).toInt().takeIf { it >= 0 })
    }
}

object MoneyFormat {
    /** en-GB CLDR (JDK 17+) abbreviates September as "Sept"; ENGLISH keeps the
     *  3-letter form the SPA renders. Day-before-month order lives in the patterns. */
    val MONTH_LOCALE: Locale = Locale.ENGLISH

    /**
     * SPA `fmtPence`: `£1,234` at ≥ £1000 (no pennies), `£12.34` below; `abs`
     * drops the sign, `showSign` adds a leading `+` for positives.
     */
    fun fmtPence(pence: Long, showSign: Boolean = false, abs: Boolean = false): String {
        val v = if (abs) abs(pence) else pence
        val sign = if (!abs && showSign && pence > 0) "+" else ""
        val num = abs(v) / 100.0
        val fmt = if (num >= 1000) String.format(Locale.UK, "%,d", Math.round(num))
        else String.format(Locale.UK, "%.2f", num)
        val neg = if (v < 0 && !abs) "-" else ""
        return "$sign$neg£$fmt"
    }

    /** SPA `formatAmountAbs`: always pennies, never a sign. */
    fun amountAbs(pence: Long): String = String.format(Locale.UK, "£%.2f", abs(pence) / 100.0)

    /** Row amount: `-£7.00` / `+£120.00` (SPA TransactionRow). */
    fun rowAmount(pence: Long): String = (if (pence < 0) "-" else "+") + amountAbs(pence)

    /** SPA `getDisplayName`: merchant → counterparty → raw description. */
    fun displayName(tx: MoneyTxRow): String =
        tx.merchantName?.takeIf { it.isNotBlank() }
            ?: tx.counterpartyName?.takeIf { it.isNotBlank() }
            ?: tx.description

    /** SPA `getReference`: for bank transfers the description IS the reference. */
    fun reference(tx: MoneyTxRow): String =
        if (!tx.counterpartyName.isNullOrBlank() && tx.merchantName.isNullOrBlank()) tx.description else ""

    /** RunwayCard "Runway" tile: `∞` when the floor is never breached, else whole months. */
    fun runwayMonthsLabel(r: Runway): String =
        if (r.neverHitsFloor) "∞ mo" else "${floor(r.monthsToFloor!!).toLong()} mo"

    /** RunwayCard runway hint: `Sep 2026` / `never (positive cashflow)` / `—`. */
    fun runwayDateLabel(r: Runway): String = when {
        r.floorDate != null -> fmtMonthLong(r.floorDate)
        r.neverHitsFloor -> "never (positive cashflow)"
        else -> "—"
    }

    /** Traffic light for the runway tile: green ∞, red < 6 mo, amber < 12 mo, else neutral. */
    enum class RunwayTone { GOOD, WARN, BAD, NEUTRAL }

    fun runwayTone(r: Runway): RunwayTone {
        if (r.neverHitsFloor) return RunwayTone.GOOD
        val m = r.monthsToFloor!!
        return when {
            m < 6 -> RunwayTone.BAD
            m < 12 -> RunwayTone.WARN
            else -> RunwayTone.NEUTRAL
        }
    }

    fun emergencyHint(ef: EmergencyFund?): String =
        if (ef?.mode == "months" && ef.months != null) "${ef.months} mo of burn" else "fixed"

    /** `2026-09` → `Sep 2026`. */
    fun fmtMonthLong(month: String): String {
        val parts = month.split('-')
        val y = parts.getOrNull(0)?.toIntOrNull() ?: return month
        val m = parts.getOrNull(1)?.toIntOrNull() ?: return month
        return LocalDate.of(y, m, 1).format(DateTimeFormatter.ofPattern("MMM yyyy", MONTH_LOCALE))
    }

    /** `2026-09-30` → `Sep 26` (SPA fmtMonth on the history x-axis). */
    fun fmtMonthShort(date: String): String {
        val parts = date.split('-')
        val y = parts.getOrNull(0)?.toIntOrNull() ?: return date
        val m = parts.getOrNull(1)?.toIntOrNull() ?: return date
        return LocalDate.of(y, m, 1).format(DateTimeFormatter.ofPattern("MMM yy", MONTH_LOCALE))
    }

    /** Day-group header for the transactions list: Today / Yesterday / `Fri 5 Sep`. */
    fun dayLabel(createdAt: Long, nowMs: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
        if (createdAt <= 0) return "Unknown date"
        val d = Instant.ofEpochMilli(createdAt).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        return when (d) {
            today -> "Today"
            today.minusDays(1) -> "Yesterday"
            else -> d.format(DateTimeFormatter.ofPattern(if (d.year == today.year) "EEE d MMM" else "EEE d MMM yyyy", MONTH_LOCALE))
        }
    }

    fun dayKey(createdAt: Long, zone: ZoneId = ZoneId.systemDefault()): String =
        if (createdAt <= 0) "" else Instant.ofEpochMilli(createdAt).atZone(zone).toLocalDate().toString()

    fun timeLabel(createdAt: Long, zone: ZoneId = ZoneId.systemDefault()): String =
        if (createdAt <= 0) "" else Instant.ofEpochMilli(createdAt).atZone(zone).format(DateTimeFormatter.ofPattern("HH:mm", Locale.UK))
}
