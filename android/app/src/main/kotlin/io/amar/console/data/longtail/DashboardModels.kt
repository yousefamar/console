package io.amar.console.data.longtail

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Pure parsers for GET /dashboard/snapshot + /dashboard/alerts — shapes from
 * server/src/dashboard.ts (DashboardSnapshot / DashboardAlert[]). No Android
 * deps so plain-JUnit testable.
 */

private val json = Json { ignoreUnknownKeys = true }

data class HubStatus(val uptimeMs: Long, val sessions: Int)
data class TsPeer(val hostname: String, val online: Boolean, val self: Boolean, val os: String?)
data class Pm2Proc(val name: String, val status: String, val memoryMb: Int, val cpuPct: Double)
data class ExternalProbe(val name: String, val url: String, val ok: Boolean, val latencyMs: Long?, val error: String?)

data class DashboardSnapshot(
    val hub: HubStatus?,
    val tailscale: List<TsPeer>,
    val pm2: List<Pm2Proc>,
    val external: List<ExternalProbe>,
)

sealed class DashboardAlert {
    data class Approval(val sessionId: String, val sessionName: String?, val toolName: String, val question: String?) : DashboardAlert()
    data class Upcoming(val summary: String, val startMs: Long) : DashboardAlert()
    data class Err(val source: String, val message: String, val ts: Long) : DashboardAlert()
}

fun parseDashboardSnapshot(raw: String): DashboardSnapshot {
    val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
        ?: return DashboardSnapshot(null, emptyList(), emptyList(), emptyList())

    val hub = (obj["hub"] as? JsonObject)?.let {
        HubStatus(
            uptimeMs = it["uptimeMs"]?.jsonPrimitive?.longOrNull ?: 0L,
            sessions = it["sessions"]?.jsonPrimitive?.intOrNull ?: 0,
        )
    }
    val tailscale = (obj["tailscale"] as? JsonArray)?.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        TsPeer(
            hostname = o["hostname"]?.jsonPrimitive?.content ?: return@mapNotNull null,
            online = o["online"]?.jsonPrimitive?.booleanOrNull ?: false,
            self = o["self"]?.jsonPrimitive?.booleanOrNull ?: false,
            os = o["os"]?.jsonPrimitive?.content,
        )
    } ?: emptyList()
    val pm2 = (obj["pm2"] as? JsonArray)?.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        Pm2Proc(
            name = o["name"]?.jsonPrimitive?.content ?: return@mapNotNull null,
            status = o["status"]?.jsonPrimitive?.content ?: "unknown",
            memoryMb = ((o["memoryBytes"]?.jsonPrimitive?.longOrNull ?: 0L) / (1024 * 1024)).toInt(),
            cpuPct = o["cpuPct"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
        )
    } ?: emptyList()
    val external = (obj["external"] as? JsonArray)?.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        val probe = o["probe"] as? JsonObject
        ExternalProbe(
            name = o["name"]?.jsonPrimitive?.content ?: return@mapNotNull null,
            url = o["url"]?.jsonPrimitive?.content ?: "",
            ok = probe?.get("ok")?.jsonPrimitive?.booleanOrNull ?: false,
            latencyMs = probe?.get("latencyMs")?.jsonPrimitive?.longOrNull,
            error = probe?.get("error")?.jsonPrimitive?.content,
        )
    } ?: emptyList()

    return DashboardSnapshot(hub, tailscale, pm2, external)
}

/** GET /dashboard/alerts responds {alerts: DashboardAlert[]} (kind-tagged). */
fun parseDashboardAlerts(raw: String): List<DashboardAlert> {
    val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return emptyList()
    val arr = obj["alerts"] as? JsonArray ?: return emptyList()
    return arr.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        when (o["kind"]?.jsonPrimitive?.content) {
            "agent-approval" -> DashboardAlert.Approval(
                sessionId = o["sessionId"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                sessionName = o["sessionName"]?.jsonPrimitive?.content,
                toolName = o["toolName"]?.jsonPrimitive?.content ?: "?",
                question = o["question"]?.jsonPrimitive?.content,
            )
            "cal-upcoming" -> DashboardAlert.Upcoming(
                summary = o["summary"]?.jsonPrimitive?.content ?: "(event)",
                startMs = o["startMs"]?.jsonPrimitive?.longOrNull ?: 0L,
            )
            "error" -> DashboardAlert.Err(
                source = o["source"]?.jsonPrimitive?.content ?: "error",
                message = o["message"]?.jsonPrimitive?.content ?: "",
                ts = o["ts"]?.jsonPrimitive?.longOrNull ?: 0L,
            )
            else -> null
        }
    }
}

fun formatUptime(ms: Long): String {
    val totalMin = ms / 60_000
    val d = totalMin / (60 * 24)
    val h = (totalMin % (60 * 24)) / 60
    val m = totalMin % 60
    return when {
        d > 0 -> "${d}d ${h}h"
        h > 0 -> "${h}h ${m}m"
        else -> "${m}m"
    }
}
