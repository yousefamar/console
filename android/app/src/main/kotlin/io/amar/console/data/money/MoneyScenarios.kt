package io.amar.console.data.money

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale
import java.util.UUID
import kotlin.math.floor
import kotlin.math.roundToLong

/**
 * One what-if step. The hub's `Delta` is a tagged union whose members carry
 * fields this phone never edits (a `modifyStream` patch can hold any `Stream`
 * key, an `addStream` a whole stream, a `categoryAdjust` a from/until window),
 * so a delta is kept as its RAW object and edited key by key — a scenario
 * written on the desktop survives a rename on the phone byte for byte.
 */
data class ScenarioDelta(val raw: JsonObject) {
    val kind: String get() = (raw["kind"] as? JsonPrimitive)?.contentOrNull ?: ""

    fun str(key: String): String? = (raw[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    fun long(key: String): Long? = (raw[key] as? JsonPrimitive)?.let { it.longOrNull ?: it.doubleOrNull?.let(::floor)?.toLong() }
    fun double(key: String): Double? = (raw[key] as? JsonPrimitive)?.doubleOrNull
    fun obj(key: String): JsonObject? = raw[key] as? JsonObject

    /** Set [key]; a null [value] REMOVES it (the hub stores no nulls inside a delta). */
    fun with(key: String, value: JsonElement?): ScenarioDelta =
        ScenarioDelta(JsonObject(if (value == null) raw - key else raw + (key to value)))

    /** Same, one level down (`patch.amountPence`, `stream.name`). */
    fun withIn(parent: String, key: String, value: JsonElement?): ScenarioDelta {
        val inner = obj(parent) ?: JsonObject(emptyMap())
        return with(parent, JsonObject(if (value == null) inner - key else inner + (key to value)))
    }
}

data class Scenario(
    val id: String,
    val name: String,
    val description: String? = null,
    val deltas: List<ScenarioDelta> = emptyList(),
    val horizonMonths: Int? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
)

/** The little of a `Stream` a delta row needs: the phone has no stream editor. */
data class StreamRef(val id: String, val name: String, val kind: String, val amountPence: Long, val archived: Boolean = false)

/** One month of a projection, as the comparison chart reads it. */
data class TrajectoryPoint(val month: String, val liquidPence: Long)

data class SharedExpense(val id: String, val date: String, val merchant: String, val grossPence: Long, val theirSharePence: Long)
data class SharedReimbursement(val id: String, val date: String, val amountPence: Long, val note: String)

/** `GET /finance/shared-tab` row: what one counterparty owes on shared spend, net of what they sent back. */
data class SharedTabBalance(
    val counterparty: String,
    val theyOwePence: Long,
    val theyPaidPence: Long,
    val netOwedToYouPence: Long,
    val oldestSharedDate: String? = null,
    val latestSharedDate: String? = null,
    val sampleShared: List<SharedExpense> = emptyList(),
    val sampleReimbursements: List<SharedReimbursement> = emptyList(),
) {
    /** SPA SharedTabPanel's row label. */
    val summary: String get() = when {
        netOwedToYouPence > 0 -> "owes you ${MoneyFormat.fmtPence(netOwedToYouPence, abs = true)}"
        netOwedToYouPence < 0 -> "you owe ${MoneyFormat.fmtPence(netOwedToYouPence, abs = true)}"
        else -> "settled"
    }
}

/**
 * Pure helpers behind `money:scenario` — the phone's half of the SPA's
 * `ScenariosView.tsx` (`upsertScenario` / `deleteScenario` in
 * `src/store/finance.ts`) and of `SharedTabPanel.tsx`.
 *
 * Outbox keying, as for accounts and the taxonomy: the hub's `upsertScenario`
 * honours a client-supplied `id` (`id: input.id ?? mint()`), so the phone mints
 * it in the hub's own shape (`scn_<8 hex>`) and the record has its real identity
 * before the write lands. Every write is a POST of `{id, name, description,
 * deltas}` — the hub's POST is an upsert, so a queued create followed by a
 * queued edit lands in any state of the hub, where a PATCH would 404 on a
 * scenario the hub has not seen yet. `horizonMonths` and the timestamps are
 * never sent: the phone does not edit them, and `Object.assign` keeps what the
 * hub holds.
 */
object MoneyScenarios {
    const val ADD_STREAM = "addStream"
    const val MODIFY_STREAM = "modifyStream"
    const val TERMINATE_STREAM = "terminateStream"
    const val ONE_OFF = "oneOff"
    const val CATEGORY_ADJUST = "categoryAdjust"
    const val INVESTMENT_GROWTH = "investmentGrowth"

    /** SPA `SCN_COLORS`: index 0 is the baseline, scenario `i` takes `(i + 1) % size`. */
    val COLORS = listOf(0xFF3B82F6, 0xFF10B981, 0xFFF59E0B, 0xFFEC4899, 0xFF06B6D4, 0xFF84CC16, 0xFFFB7185)

    const val BASELINE = "baseline"

    fun colorFor(scenarioIndex: Int): Long = COLORS[(scenarioIndex + 1) % COLORS.size]

    fun mintScenarioId(uuid: String = UUID.randomUUID().toString()): String =
        "scn_" + uuid.replace("-", "").take(8)

    fun today(zone: ZoneId = ZoneId.systemDefault()): String = LocalDate.now(zone).toString()

    // ---- Parsing ----------------------------------------------------------

    private val json get() = MoneyJson.json

    private fun JsonElement?.s(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull
    private fun JsonElement?.l(): Long = (this as? JsonPrimitive)?.let { it.longOrNull ?: it.doubleOrNull?.let(::floor)?.toLong() } ?: 0L

    fun parseScenarios(body: String): List<Scenario> =
        parseScenarioArray(runCatching { json.parseToJsonElement(body) }.getOrNull())

    fun parseScenarioArray(el: JsonElement?): List<Scenario> =
        (el as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let(::parseScenario) } ?: emptyList()

    fun parseScenario(o: JsonObject): Scenario? {
        val id = o["id"].s() ?: return null
        return Scenario(
            id = id,
            name = o["name"].s() ?: "",
            description = o["description"].s()?.takeIf { it.isNotEmpty() },
            // A delta with no kind is nothing the engine can apply; an unknown kind is kept as-is.
            deltas = (o["deltas"] as? JsonArray)?.mapNotNull { d ->
                (d as? JsonObject)?.takeIf { it["kind"].s() != null }?.let(::ScenarioDelta)
            } ?: emptyList(),
            horizonMonths = (o["horizonMonths"] as? JsonPrimitive)?.longOrNull?.toInt(),
            createdAt = o["createdAt"].s(),
            updatedAt = o["updatedAt"].s(),
        )
    }

    /** The cache copy: everything we hold. */
    fun scenarioJson(s: Scenario): JsonObject = buildJsonObject {
        put("id", s.id)
        put("name", s.name)
        s.description?.let { put("description", it) }
        put("deltas", JsonArray(s.deltas.map { it.raw }))
        s.horizonMonths?.let { put("horizonMonths", it) }
        s.createdAt?.let { put("createdAt", it) }
        s.updatedAt?.let { put("updatedAt", it) }
    }

    fun encodeScenarios(list: List<Scenario>): String = JsonArray(list.map(::scenarioJson)).toString()

    fun parseStreams(el: JsonElement?): List<StreamRef> = (el as? JsonArray)?.mapNotNull { e ->
        val o = e as? JsonObject ?: return@mapNotNull null
        StreamRef(
            id = o["id"].s() ?: return@mapNotNull null,
            name = o["name"].s() ?: "",
            kind = o["kind"].s() ?: "expense",
            amountPence = o["amountPence"].l(),
            archived = (o["archived"] as? JsonPrimitive)?.contentOrNull == "true",
        )
    } ?: emptyList()

    fun decodeStreams(body: String): List<StreamRef> = parseStreams(runCatching { json.parseToJsonElement(body) }.getOrNull())

    fun encodeStreams(list: List<StreamRef>): String = buildJsonArray {
        for (s in list) add(buildJsonObject {
            put("id", s.id); put("name", s.name); put("kind", s.kind); put("amountPence", s.amountPence)
            if (s.archived) put("archived", true)
        })
    }.toString()

    /** `/finance/projection` → the liquid line. Empty when the body carries no trajectory. */
    fun parseTrajectory(body: String): List<TrajectoryPoint> {
        val root = runCatching { json.parseToJsonElement(body) }.getOrNull() as? JsonObject ?: return emptyList()
        return trajectoryOf(root["trajectory"])
    }

    private fun trajectoryOf(el: JsonElement?): List<TrajectoryPoint> = (el as? JsonArray)?.mapNotNull { e ->
        val o = e as? JsonObject ?: return@mapNotNull null
        TrajectoryPoint(o["month"].s() ?: return@mapNotNull null, o["liquidPence"].l())
    } ?: emptyList()

    private fun trajectoryJson(points: List<TrajectoryPoint>): JsonArray = buildJsonArray {
        for (p in points) add(buildJsonObject { put("month", p.month); put("liquidPence", p.liquidPence) })
    }

    fun encodeTrajectory(points: List<TrajectoryPoint>): String = trajectoryJson(points).toString()

    fun decodeTrajectory(body: String): List<TrajectoryPoint> =
        trajectoryOf(runCatching { json.parseToJsonElement(body) }.getOrNull())

    fun encodeOverlays(map: Map<String, List<TrajectoryPoint>>): String =
        JsonObject(map.mapValues { trajectoryJson(it.value) }).toString()

    fun decodeOverlays(body: String): Map<String, List<TrajectoryPoint>> {
        val o = runCatching { json.parseToJsonElement(body) }.getOrNull() as? JsonObject ?: return emptyMap()
        return o.mapValues { trajectoryOf(it.value) }
    }

    /** Null when the body is not the array the route answers with (a proxy error page must not blank the cache). */
    fun parseSharedTabs(body: String): List<SharedTabBalance>? {
        val arr = runCatching { json.parseToJsonElement(body) }.getOrNull() as? JsonArray ?: return null
        return arr.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            SharedTabBalance(
                counterparty = o["counterparty"].s() ?: return@mapNotNull null,
                theyOwePence = o["theyOwePence"].l(),
                theyPaidPence = o["theyPaidPence"].l(),
                netOwedToYouPence = o["netOwedToYouPence"].l(),
                oldestSharedDate = o["oldestSharedDate"].s(),
                latestSharedDate = o["latestSharedDate"].s(),
                sampleShared = (o["sampleShared"] as? JsonArray)?.mapNotNull { x ->
                    val s = x as? JsonObject ?: return@mapNotNull null
                    SharedExpense(s["id"].s() ?: "", s["date"].s() ?: "", s["merchant"].s() ?: "", s["grossPence"].l(), s["theirSharePence"].l())
                } ?: emptyList(),
                sampleReimbursements = (o["sampleReimbursements"] as? JsonArray)?.mapNotNull { x ->
                    val r = x as? JsonObject ?: return@mapNotNull null
                    SharedReimbursement(r["id"].s() ?: "", r["date"].s() ?: "", r["amountPence"].l(), r["note"].s() ?: "")
                } ?: emptyList(),
            )
        }
    }

    // ---- Deltas: what the adder buttons create (SPA `DeltaAdder`) ----------

    fun newOneOff(date: String = today()): ScenarioDelta = ScenarioDelta(buildJsonObject {
        put("kind", ONE_OFF); put("date", date); put("amountPence", 0L); put("note", "")
    })

    fun newModifyStream(streamId: String): ScenarioDelta = ScenarioDelta(buildJsonObject {
        put("kind", MODIFY_STREAM); put("streamId", streamId); put("patch", JsonObject(emptyMap()))
    })

    fun newTerminateStream(streamId: String, date: String = today()): ScenarioDelta = ScenarioDelta(buildJsonObject {
        put("kind", TERMINATE_STREAM); put("streamId", streamId); put("date", date)
    })

    fun newAddStream(date: String = today(), tempId: String = "tmp_" + UUID.randomUUID().toString().replace("-", "").take(6)): ScenarioDelta =
        ScenarioDelta(buildJsonObject {
            put("kind", ADD_STREAM)
            put("tempId", tempId)
            put("stream", buildJsonObject {
                put("name", "New stream"); put("kind", "income"); put("amountPence", 0L)
                put("cadence", "monthly"); put("startDate", date)
            })
        })

    fun newCategoryAdjust(categoryId: String): ScenarioDelta = ScenarioDelta(buildJsonObject {
        put("kind", CATEGORY_ADJUST); put("categoryId", categoryId); put("multiplier", 1.0)
    })

    fun newInvestmentGrowth(): ScenarioDelta = ScenarioDelta(buildJsonObject {
        put("kind", INVESTMENT_GROWTH); put("annualPct", 5.0)
    })

    /** Streams a delta may point at: the live ones, plus whichever the delta already names. */
    fun pickableStreams(streams: List<StreamRef>, current: String? = null): List<StreamRef> =
        streams.filter { !it.archived || it.id == current }

    /** One line for a collapsed delta — also what the delete confirm and tests read. */
    fun describe(d: ScenarioDelta, streams: List<StreamRef>, categories: Map<String, MoneyCategory>): String {
        fun streamName(id: String?) = streams.firstOrNull { it.id == id }?.name ?: "?"
        return when (d.kind) {
            ONE_OFF -> listOfNotNull(
                "One-off ${MoneyFormat.fmtPence(d.long("amountPence") ?: 0L, showSign = true)}",
                d.str("date")?.let { "on $it" },
                d.str("note")?.takeIf { it.isNotBlank() }?.let { "· $it" },
            ).joinToString(" ")
            MODIFY_STREAM -> {
                val p = d.obj("patch")
                val amount = (p?.get("amountPence") as? JsonPrimitive)?.longOrNull
                listOfNotNull(
                    "Modify ${streamName(d.str("streamId"))}",
                    amount?.let { "→ ${MoneyFormat.fmtPence(it, abs = true)}" },
                    (p?.get("startDate") as? JsonPrimitive)?.contentOrNull?.let { "from $it" },
                ).joinToString(" ")
            }
            TERMINATE_STREAM -> "End ${streamName(d.str("streamId"))} on ${d.str("date") ?: "?"}"
            ADD_STREAM -> {
                val s = d.obj("stream")
                val name = (s?.get("name") as? JsonPrimitive)?.contentOrNull ?: "stream"
                val kind = (s?.get("kind") as? JsonPrimitive)?.contentOrNull ?: "income"
                val amount = (s?.get("amountPence") as? JsonPrimitive)?.longOrNull ?: 0L
                "New $kind $name ${MoneyFormat.fmtPence(amount, abs = true)}/mo"
            }
            CATEGORY_ADJUST -> {
                val c = categories[d.str("categoryId")]
                "${c?.label ?: d.str("categoryId") ?: "?"} × ${formatNumber(d.double("multiplier") ?: 1.0)}"
            }
            INVESTMENT_GROWTH -> "Investment growth ${formatNumber(d.double("annualPct") ?: 0.0)}%/yr"
            else -> d.kind
        }
    }

    // ---- Field text <-> values -------------------------------------------

    /** `"-12.50"` / `"£1,200"` / `"+300"` → signed pence; null for blank or junk. */
    fun poundsToSignedPence(input: String): Long? {
        val t = input.trim().replace("£", "").replace(",", "").replace("−", "-")
        if (t.isEmpty()) return null
        val v = t.toDoubleOrNull() ?: return null
        if (!v.isFinite()) return null
        return (v * 100).roundToLong()
    }

    /** Pence → the text an amount field starts with (`-1250` → `-12.50`, `0` → blank). */
    fun penceToText(pence: Long?): String = when {
        pence == null || pence == 0L -> ""
        pence % 100 == 0L -> (pence / 100).toString()
        else -> "%.2f".format(Locale.ROOT, pence / 100.0)
    }

    fun parseNumber(input: String): Double? = input.trim().removeSuffix("%").trim().toDoubleOrNull()?.takeIf { it.isFinite() }

    /** `1.3` → `1.3`, `5.0` → `5`. */
    fun formatNumber(v: Double): String =
        "%.2f".format(Locale.ROOT, v).trimEnd('0').trimEnd('.').ifEmpty { "0" }

    // ---- The editor's draft ----------------------------------------------

    data class Draft(val name: String = "", val description: String = "", val deltas: List<ScenarioDelta> = emptyList())

    fun draftOf(s: Scenario?): Draft =
        if (s == null) Draft(name = "New scenario") else Draft(s.name, s.description ?: "", s.deltas)

    fun validate(d: Draft): String? = if (d.name.isBlank()) "Name it first" else null

    /** The record to write; [existing]'s horizon and timestamps ride through untouched. */
    fun toScenario(d: Draft, existing: Scenario?, id: String = mintScenarioId()): Scenario = Scenario(
        id = existing?.id ?: id,
        name = d.name.trim(),
        description = d.description.trim().takeIf { it.isNotEmpty() },
        deltas = d.deltas,
        horizonMonths = existing?.horizonMonths,
        createdAt = existing?.createdAt,
        updatedAt = existing?.updatedAt,
    )

    /** SPA "Clone": a new scenario with the same deltas and description. */
    fun cloneOf(s: Scenario, id: String = mintScenarioId()): Scenario =
        Scenario(id = id, name = "${s.name} (copy)", description = s.description, deltas = s.deltas)

    // ---- Requests ---------------------------------------------------------

    /**
     * POST `/finance/scenarios` body. On an EDIT an emptied description goes as
     * an explicit `null`: the hub's upsert is `Object.assign(existing, input)`,
     * so omitting it would keep the old text (the SPA's `editBody` rule).
     */
    fun scenarioBody(s: Scenario, isEdit: Boolean): String = buildJsonObject {
        put("id", s.id)
        put("name", s.name)
        if (s.description != null) put("description", s.description) else if (isEdit) put("description", JsonNull)
        put("deltas", JsonArray(s.deltas.map { it.raw }))
    }.toString()

    fun path(scenarioId: String): String =
        "/finance/scenarios/" + java.net.URLEncoder.encode(scenarioId, "UTF-8")

    fun projectionPath(scenarioId: String): String =
        "/finance/projection?scenario=" + java.net.URLEncoder.encode(scenarioId, "UTF-8")

    /** Replace-or-append by id. */
    fun upsertInto(list: List<Scenario>, s: Scenario): List<Scenario> {
        val idx = list.indexOfFirst { it.id == s.id }
        return if (idx >= 0) list.toMutableList().also { it[idx] = s } else list + s
    }

    /**
     * A hub list with the still-queued local edits laid back over it: an
     * in-flight id present locally wins, one absent locally (a queued delete)
     * stays gone, and a create the hub has not got yet is appended. The caller
     * subtracts the id whose write just landed (the ^loud-frog / ^busy-vole rule).
     */
    fun withInFlight(hubList: List<Scenario>, local: List<Scenario>, inFlightIds: Set<String>): List<Scenario> {
        if (inFlightIds.isEmpty()) return hubList
        val localById = local.associateBy { it.id }
        val hubIds = hubList.mapTo(HashSet()) { it.id }
        val out = ArrayList<Scenario>(hubList.size + inFlightIds.size)
        for (s in hubList) {
            if (s.id !in inFlightIds) out += s else localById[s.id]?.let { out += it }
        }
        for (s in local) if (s.id in inFlightIds && s.id !in hubIds) out += s
        return out
    }

    // ---- Outbox payload: the request plus everything the heal needs ------

    data class Action(
        val scenarioId: String,
        /** POST body; null = DELETE `/finance/scenarios/<id>`. */
        val body: String?,
        /** The record this write replaced (null = a create). */
        val before: Scenario?,
    )

    fun encodeAction(a: Action): String = buildJsonObject {
        put("scenarioId", a.scenarioId)
        put("body", a.body?.let { JsonPrimitive(it) } ?: JsonNull)
        put("before", a.before?.let(::scenarioJson) ?: JsonNull)
    }.toString()

    fun decodeAction(payload: String): Action? {
        val o = runCatching { json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return null
        return Action(
            scenarioId = o["scenarioId"]?.jsonPrimitive?.contentOrNull ?: return null,
            body = (o["body"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
            before = (o["before"] as? JsonObject)?.let(::parseScenario),
        )
    }

    /** Terminal failure: put back the record the write replaced, or drop a failed create. */
    fun healed(list: List<Scenario>, a: Action): List<Scenario> {
        val idx = list.indexOfFirst { it.id == a.scenarioId }
        return when {
            a.before == null -> list.filterNot { it.id == a.scenarioId }
            idx >= 0 -> list.toMutableList().also { it[idx] = a.before }
            else -> list + a.before
        }
    }

    // ---- Comparison chart (SPA `ComparisonChart`) --------------------------

    data class Series(val id: String, val name: String, val color: Long, val values: List<Long?>) {
        val last: Long? get() = values.lastOrNull { it != null }
    }

    data class Comparison(val months: List<String>, val series: List<Series>, val emergencyPence: Long) {
        val isEmpty: Boolean get() = months.isEmpty()
        private val all: List<Long> get() = series.flatMap { it.values.filterNotNull() }
        /** The y range: every line plus the emergency floor, so the floor is always on the chart. */
        val minPence: Long get() = minOf(all.minOrNull() ?: 0L, emergencyPence)
        val maxPence: Long get() = maxOf(all.maxOrNull() ?: 0L, emergencyPence)
    }

    /**
     * The baseline's months are the x axis; a scenario contributes a value where
     * its own trajectory has that index (the SPA joins by index too — both come
     * from the same start month and horizon). A scenario with no trajectory yet
     * (offline, or its create still queued) is listed with no line.
     */
    fun comparison(
        base: List<TrajectoryPoint>,
        overlays: Map<String, List<TrajectoryPoint>>,
        scenarios: List<Scenario>,
        emergencyPence: Long,
    ): Comparison {
        val series = ArrayList<Series>(scenarios.size + 1)
        series += Series(BASELINE, "Baseline", COLORS[0], base.map { it.liquidPence })
        scenarios.forEachIndexed { i, s ->
            val t = overlays[s.id].orEmpty()
            series += Series(s.id, s.name, colorFor(i), base.indices.map { t.getOrNull(it)?.liquidPence })
        }
        return Comparison(base.map { it.month }, series, emergencyPence)
    }

    /** SPA row suffix: `@ Sep 28 → £12,345`, off the scenario's last projected month (signed: a negative end is the point). */
    fun endLabel(trajectory: List<TrajectoryPoint>?): String? = trajectory?.lastOrNull()?.let {
        "@ ${MoneyFormat.fmtMonthShort(it.month)} → ${MoneyFormat.fmtPence(it.liquidPence)}"
    }

    fun deltaCount(s: Scenario): String = "${s.deltas.size} delta${if (s.deltas.size == 1) "" else "s"}"
}
