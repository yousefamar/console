package io.amar.console.data.agents

import io.amar.console.core.HubClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.net.URLEncoder

/**
 * Hub-side event-listener mirror — the port of src/store/listeners.ts (the
 * cron store's twin). Polls `GET /listeners?session=<csid>` while a session
 * screen is open; mutations re-fetch. Rules are registered from the session
 * itself (`con listen add`) — there is no create form on any client.
 *
 * The models + formatters below are pure and unit-tested; the Spaces/Inbox
 * row badge reads them too, so keep them free of Compose and Android.
 */
object Listeners {
    private val json = Json { ignoreUnknownKeys = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var hub: HubClient? = null

    data class Where(val path: String, val op: String, val value: String)

    /** One of the six action kinds; only the fields for [type] are set. */
    data class Action(
        val type: String,
        val prompt: String? = null,
        val asKey: String? = null,
        val fork: Boolean = false,
        val model: String? = null,
        val cmd: String? = null,
        val url: String? = null,
        val method: String? = null,
        val title: String? = null,
        val topic: String? = null,
        val project: String? = null,
        val text: String? = null,
    )

    data class ExpectPending(val armedAt: Long, val deadlineAt: Long, val triggerEventId: String?)

    /** Present = the rule acts on the ABSENCE of its `on` event; the listener's
     *  [Listener.action] is the `--else`. */
    data class Expectation(
        val by: String?,
        val windowMs: Long?,
        val afterOn: String?,
        val afterWhere: List<Where>,
        val withinMs: Long?,
        val then: Action?,
        val pending: List<ExpectPending>,
        val satisfied: Int,
        val missed: Int,
    )

    data class Pending(val events: List<String>, val startedAt: Long, val dueAt: Long)

    data class Stats(
        val matched: Int,
        val fired: Int,
        val guardSkipped: Int,
        val lastEventAt: Long?,
        val lastFiredAt: Long?,
        val lastOutcome: String?,
    )

    data class Listener(
        val id: String,
        val name: String?,
        val claudeSessionId: String,
        val agentKey: String?,
        val ownerName: String?,
        val on: String,
        val where: List<Where>,
        val guard: String?,
        val expect: Expectation?,
        val coalesceMs: Long,
        val cooldownMs: Long,
        val hours: String?,
        val days: String?,
        val action: Action,
        val times: Int?,
        val timesTotal: Int?,
        val expiresAt: Long?,
        val pausedAt: Long?,
        val pauseReason: String?,
        val disabledAt: Long?,
        val stats: Stats,
        val pending: Pending?,
    ) {
        val active: Boolean get() = disabledAt == null
        val paused: Boolean get() = pausedAt != null
    }

    private val _bySession = MutableStateFlow<Map<String, List<Listener>>>(emptyMap())
    val bySession: StateFlow<Map<String, List<Listener>>> = _bySession
    private val _errorBySession = MutableStateFlow<Map<String, String>>(emptyMap())
    val errorBySession: StateFlow<Map<String, String>> = _errorBySession

    fun attach(client: HubClient) { hub = client }

    /** Live flow of listeners for one claudeSessionId (empty when null). */
    fun listenersFor(claudeSessionId: String?): Flow<List<Listener>> =
        _bySession.map { if (claudeSessionId == null) emptyList() else it[claudeSessionId] ?: emptyList() }

    fun errorFor(claudeSessionId: String?): Flow<String?> =
        _errorBySession.map { if (claudeSessionId == null) null else it[claudeSessionId] }

    // ------------------------------------------------------------------ //
    // Parsing

    internal fun whereFrom(a: JsonArray?): List<Where> = a?.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        Where(
            path = o["path"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
            op = o["op"]?.jsonPrimitive?.contentOrNull ?: "=",
            value = o["value"]?.jsonPrimitive?.contentOrNull ?: "",
        )
    } ?: emptyList()

    internal fun actionFrom(o: JsonObject?): Action {
        if (o == null) return Action(type = "?")
        fun s(k: String) = o[k]?.jsonPrimitive?.contentOrNull
        return Action(
            type = s("type") ?: "?",
            prompt = s("prompt"),
            asKey = s("as"),
            fork = o["fork"]?.jsonPrimitive?.booleanOrNull ?: false,
            model = s("model"),
            cmd = s("cmd"),
            url = s("url"),
            method = s("method"),
            title = s("title"),
            topic = s("topic"),
            project = s("project"),
            text = s("text"),
        )
    }

    internal fun expectFrom(o: JsonObject?): Expectation? {
        if (o == null) return null
        val after = o["after"] as? JsonObject
        return Expectation(
            by = o["by"]?.jsonPrimitive?.contentOrNull,
            windowMs = o["windowMs"]?.jsonPrimitive?.longOrNull,
            afterOn = after?.get("on")?.jsonPrimitive?.contentOrNull,
            afterWhere = whereFrom(after?.get("where") as? JsonArray),
            withinMs = o["withinMs"]?.jsonPrimitive?.longOrNull,
            then = (o["then"] as? JsonObject)?.let { actionFrom(it) },
            pending = (o["pending"] as? JsonArray)?.mapNotNull { el ->
                val p = el as? JsonObject ?: return@mapNotNull null
                ExpectPending(
                    armedAt = p["armedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
                    deadlineAt = p["deadlineAt"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null,
                    triggerEventId = p["triggerEventId"]?.jsonPrimitive?.contentOrNull,
                )
            } ?: emptyList(),
            satisfied = o["satisfied"]?.jsonPrimitive?.intOrNull ?: 0,
            missed = o["missed"]?.jsonPrimitive?.intOrNull ?: 0,
        )
    }

    internal fun listenerFrom(o: JsonObject): Listener {
        val owner = o["owner"] as? JsonObject
        val stats = o["stats"] as? JsonObject
        val pending = o["pending"] as? JsonObject
        return Listener(
            id = o["id"]!!.jsonPrimitive.content,
            name = o["name"]?.jsonPrimitive?.contentOrNull,
            claudeSessionId = owner?.get("claudeSessionId")?.jsonPrimitive?.contentOrNull ?: "",
            agentKey = owner?.get("agentKey")?.jsonPrimitive?.contentOrNull,
            ownerName = o["ownerName"]?.jsonPrimitive?.contentOrNull,
            on = o["on"]?.jsonPrimitive?.contentOrNull ?: "",
            where = whereFrom(o["where"] as? JsonArray),
            guard = o["guard"]?.jsonPrimitive?.contentOrNull,
            expect = expectFrom(o["expect"] as? JsonObject),
            coalesceMs = o["coalesceMs"]?.jsonPrimitive?.longOrNull ?: 0L,
            cooldownMs = o["cooldownMs"]?.jsonPrimitive?.longOrNull ?: 0L,
            hours = o["hours"]?.jsonPrimitive?.contentOrNull,
            days = o["days"]?.jsonPrimitive?.contentOrNull,
            action = actionFrom(o["action"] as? JsonObject),
            times = o["times"]?.jsonPrimitive?.intOrNull,
            timesTotal = o["timesTotal"]?.jsonPrimitive?.intOrNull,
            expiresAt = o["expiresAt"]?.jsonPrimitive?.longOrNull,
            pausedAt = o["pausedAt"]?.jsonPrimitive?.longOrNull,
            pauseReason = o["pauseReason"]?.jsonPrimitive?.contentOrNull,
            disabledAt = o["disabledAt"]?.jsonPrimitive?.longOrNull,
            stats = Stats(
                matched = stats?.get("matched")?.jsonPrimitive?.intOrNull ?: 0,
                fired = stats?.get("fired")?.jsonPrimitive?.intOrNull ?: 0,
                guardSkipped = stats?.get("guardSkipped")?.jsonPrimitive?.intOrNull ?: 0,
                lastEventAt = stats?.get("lastEventAt")?.jsonPrimitive?.longOrNull,
                lastFiredAt = stats?.get("lastFiredAt")?.jsonPrimitive?.longOrNull,
                lastOutcome = stats?.get("lastOutcome")?.jsonPrimitive?.contentOrNull,
            ),
            pending = pending?.let {
                Pending(
                    events = (it["events"] as? JsonArray)?.mapNotNull { e -> e.jsonPrimitive.contentOrNull } ?: emptyList(),
                    startedAt = it["startedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
                    dueAt = it["dueAt"]?.jsonPrimitive?.longOrNull ?: 0L,
                )
            },
        )
    }

    // ------------------------------------------------------------------ //
    // Formatters — the labels of src/components/agent/ListenerPanel.tsx.

    /** `1h` / `10m` / `45s` — whole units only, like the SPA's fmtDur. */
    fun fmtDur(ms: Long): String = when {
        ms % 3_600_000L == 0L -> "${ms / 3_600_000L}h"
        ms % 60_000L == 0L -> "${ms / 60_000L}m"
        else -> "${Math.round(ms / 1000.0)}s"
    }

    fun whereText(where: List<Where>): String =
        where.joinToString(" && ") { c -> if (c.op == "in") "${c.path} in ${c.value}" else "${c.path}${c.op}${c.value}" }

    fun describeAction(a: Action): String = when (a.type) {
        "wake" -> "wake" + (if (a.fork) " (fork" + (a.model?.let { " $it" } ?: "") + ")" else "") + (a.asKey?.let { " @$it" } ?: "") + ": ${a.prompt ?: ""}"
        "run" -> "run: ${a.cmd ?: ""}"
        "post" -> "post ${a.method ?: "POST"} ${a.url ?: ""}"
        "notify" -> "notify: ${a.title ?: ""}"
        "emit" -> "emit ${a.topic ?: ""}"
        "card" -> "card ${a.project ?: ""}: ${a.text ?: ""}"
        else -> a.type
    }

    /** `else <action>[; then <action>]` for an expectation, the bare action otherwise. */
    fun actionLine(l: Listener): String =
        (if (l.expect != null) "else " else "") + describeAction(l.action) + (l.expect?.then?.let { "; then ${describeAction(it)}" } ?: "")

    /** The deadline half of an expectation's rule: `by "0 9 * * 1" (window 3h)` /
     *  `by <local date>` / `within 90m after geo.leave where data.fence=home`. */
    fun expectWhen(e: Expectation, formatDate: (Long) -> String): String {
        if (e.by != null) {
            val by = if (Regex("""^\d{12,}$""").matches(e.by)) formatDate(e.by.toLong()) else "\"${e.by}\""
            return "by $by" + (e.windowMs?.takeIf { it > 0 }?.let { " (window ${fmtDur(it)})" } ?: "")
        }
        val after = e.afterOn?.let { " after $it" + (if (e.afterWhere.isNotEmpty()) " where ${whereText(e.afterWhere)}" else "") } ?: ""
        return "within ${fmtDur(e.withinMs ?: 0L)}$after"
    }

    /** The rule header: `[expect ]<topic>[ where …][ <expectWhen>]`. */
    fun listenerSummary(l: Listener, formatDate: (Long) -> String = { it.toString() }): String {
        val sb = StringBuilder()
        if (l.expect != null) sb.append("expect ")
        sb.append(l.on)
        if (l.where.isNotEmpty()) sb.append(" where ").append(whereText(l.where))
        l.expect?.let { sb.append(' ').append(expectWhen(it, formatDate)) }
        return sb.toString()
    }

    /** Nearest armed deadline, or null when nothing is armed. */
    fun nextDeadline(l: Listener): Long? = l.expect?.pending?.minOfOrNull { it.deadlineAt }

    /** `in 5m` for the next thing this rule will do on its own: the nearest
     *  armed deadline, else the coalesce batch's due time. Null when idle. */
    fun nextIn(l: Listener, now: Long, relIn: (Long) -> String): String? {
        val at = nextDeadline(l) ?: l.pending?.dueAt ?: return null
        return "in ${relIn(at - now)}"
    }

    /** One line for a row badge: `expect <rule> · armed N · next in X → else <action>`. */
    fun expectationSummary(l: Listener, now: Long, relIn: (Long) -> String, formatDate: (Long) -> String = { it.toString() }): String {
        val e = l.expect ?: return "${listenerSummary(l, formatDate)} → ${actionLine(l)}"
        val parts = mutableListOf(listenerSummary(l, formatDate))
        if (e.pending.isNotEmpty()) {
            parts += "armed ${e.pending.size}"
            nextIn(l, now, relIn)?.let { parts += "next $it" }
        } else parts += "waiting"
        return parts.joinToString(" · ") + " → " + actionLine(l)
    }

    enum class StateKind { DISABLED, PAUSED, INFO }
    data class StateChip(val text: String, val kind: StateKind)

    /** The chip beside the rule: `disabled` · `paused` · `armed N · in X` ·
     *  `waiting` (expectation with nothing armed) · `pending N` (coalesce
     *  batch). Null when the rule is simply idle. */
    fun stateChip(l: Listener, now: Long, relIn: (Long) -> String): StateChip? {
        if (l.disabledAt != null) return StateChip("disabled", StateKind.DISABLED)
        if (l.pausedAt != null) return StateChip("paused", StateKind.PAUSED)
        val deadline = nextDeadline(l)
        if (deadline != null) return StateChip("armed ${l.expect!!.pending.size} · in ${relIn(deadline - now)}", StateKind.INFO)
        if (l.expect != null) return StateChip("waiting", StateKind.INFO)
        l.pending?.let { return StateChip("pending ${it.events.size}", StateKind.INFO) }
        return null
    }

    /** `coalesce 1m`, `cooldown 10m`, `Mon-Fri 07:00-23:00`, `guard` — the gates that sit between a match and the action. */
    fun gates(l: Listener): List<String> = listOfNotNull(
        l.coalesceMs.takeIf { it > 0 }?.let { "coalesce ${fmtDur(it)}" },
        l.cooldownMs.takeIf { it > 0 }?.let { "cooldown ${fmtDur(it)}" },
        listOfNotNull(l.days, l.hours).joinToString(" ").ifBlank { null },
        if (l.guard != null) "guard" else null,
    )

    /** `once` / `2/3 left` / `expires in 2h` / `expired`. */
    fun life(l: Listener, now: Long, relIn: (Long) -> String): List<String> = listOfNotNull(
        l.times?.let { t -> if (l.timesTotal == 1) "once" else "$t/${l.timesTotal ?: t} left" },
        l.expiresAt?.let { at -> if (at > now) "expires in ${relIn(at - now)}" else "expired" },
    )

    /** `satisfied N · missed M` (expectation) · `fired N · 3m ago` · `matched N` (only when more matched than fired) · `guard-skipped N`. */
    fun statsLine(l: Listener, now: Long, relAgo: (Long) -> String): List<String> = listOfNotNull(
        l.expect?.let { "satisfied ${it.satisfied} · missed ${it.missed}" },
        "fired ${l.stats.fired}" + (l.stats.lastFiredAt?.let { " · ${relAgo(now - it)}" } ?: ""),
        if (l.stats.matched > l.stats.fired) "matched ${l.stats.matched}" else null,
        if (l.stats.guardSkipped > 0) "guard-skipped ${l.stats.guardSkipped}" else null,
    )

    /** An outcome that means the rule did NOT do its job this time. */
    fun outcomeBad(outcome: String?): Boolean =
        outcome != null && Regex("""^(skipped|error|paused|dropped)""").containsMatchIn(outcome)

    /** Status-bar pill numbers: (active = not disabled, paused among them). Null when the pill hides. */
    data class PillCounts(val active: Int, val paused: Int)
    fun pillCounts(list: List<Listener>): PillCounts? {
        val active = list.filter { it.active }
        if (active.isEmpty()) return null
        return PillCounts(active.size, active.count { it.paused })
    }

    /** Spaces session-row badge (SPA `SessionBadges` `listen`, ^deft-hawk): active
     *  rules only — disabled ones are dead; expectations + paused feed the
     *  description. Null when the badge hides. */
    data class Badge(val count: Int, val expects: Int, val paused: Int) {
        val title: String
            get() = buildString {
                append(count).append(" event listener").append(if (count == 1) "" else "s")
                if (expects > 0) append(" (").append(expects).append(" expectation").append(if (expects == 1) "" else "s").append(")")
                if (paused > 0) append(", ").append(paused).append(" paused")
            }
    }

    fun badge(list: List<Listener>): Badge? {
        val active = list.filter { it.active }
        if (active.isEmpty()) return null
        return Badge(active.size, active.count { it.expect != null }, active.count { it.paused })
    }

    // ------------------------------------------------------------------ //
    // Hub calls

    fun refresh(claudeSessionId: String) {
        val client = hub ?: return
        scope.launch { refreshNow(client, claudeSessionId) }
    }

    private suspend fun refreshNow(client: HubClient, claudeSessionId: String) {
        runCatching {
            val body = client.get("/listeners?session=${URLEncoder.encode(claudeSessionId, "UTF-8")}")
            json.parseToJsonElement(body).jsonArray.mapNotNull { runCatching { listenerFrom(it.jsonObject) }.getOrNull() }
        }.onSuccess { list ->
            _bySession.value = _bySession.value + (claudeSessionId to list)
            _errorBySession.value = _errorBySession.value - claudeSessionId
        }.onFailure { e ->
            _errorBySession.value = _errorBySession.value + (claudeSessionId to (extractError(e) ?: "hub error"))
        }
    }

    /** Fleet-wide fetch grouped by owner — the row badge's source (cron `refreshAll` twin). */
    fun refreshAll() {
        val client = hub ?: return
        scope.launch {
            runCatching {
                val body = client.get("/listeners")
                json.parseToJsonElement(body).jsonArray.mapNotNull { runCatching { listenerFrom(it.jsonObject) }.getOrNull() }
            }.onSuccess { all -> _bySession.value = all.groupBy { it.claudeSessionId } }
        }
    }

    suspend fun pause(id: String): String? = verb(id, "pause")
    suspend fun resume(id: String): String? = verb(id, "resume")
    suspend fun flush(id: String): String? = verb(id, "flush")

    /** Removes the rule. The hub 403s another session's rule — that error is
     *  surfaced verbatim, never forced from the UI. */
    suspend fun remove(id: String): String? {
        val client = hub ?: return "not connected"
        val owner = ownerOf(id)
        return runCatching { client.delete("/listeners/${URLEncoder.encode(id, "UTF-8")}") }
            .fold(onSuccess = { owner?.let { refreshNow(client, it) }; null }, onFailure = { extractError(it) ?: it.message })
    }

    private suspend fun verb(id: String, verb: String): String? {
        val client = hub ?: return "not connected"
        return runCatching { client.post("/listeners/${URLEncoder.encode(id, "UTF-8")}/$verb") }
            .fold(onSuccess = { ownerOf(id)?.let { refreshNow(client, it) }; null }, onFailure = { extractError(it) ?: it.message })
    }

    private fun ownerOf(id: String): String? =
        _bySession.value.entries.firstOrNull { (_, list) -> list.any { it.id == id } }?.key

    private fun extractError(e: Throwable): String? {
        val body = (e as? HubClient.HttpException)?.body ?: return e.message
        return runCatching { json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.contentOrNull }.getOrNull() ?: body.take(160)
    }
}
