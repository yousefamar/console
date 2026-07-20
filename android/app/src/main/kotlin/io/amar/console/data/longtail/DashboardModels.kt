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
 * server/src/dashboard.ts (DashboardSnapshot / DashboardAlert[]) and
 * src/store/dashboard.ts. No Android deps so plain-JUnit testable.
 */

private val json = Json { ignoreUnknownKeys = true }

data class HubStatus(val uptimeMs: Long, val sessions: Int)
data class TsPeer(val hostname: String, val dnsName: String, val online: Boolean, val self: Boolean, val os: String?)
data class Pm2Proc(
    val name: String,
    val status: String,
    val uptimeMs: Long,
    val restartCount: Int,
    val memoryBytes: Long,
    val cpuPct: Double,
) {
    /** Legacy convenience (kept for the LongTailLogicTest contract). */
    val memoryMb: Int get() = (memoryBytes / (1024 * 1024)).toInt()
}
data class ExternalProbe(
    val id: String,
    val name: String,
    val url: String,
    val ok: Boolean,
    val latencyMs: Long?,
    val status: Int?,
    val error: String?,
)

data class DashboardSnapshot(
    val generatedAt: Long,
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

/** Canvas metadata — server/src/dashboard.ts CanvasDir.metadata(). */
data class CanvasMeta(val updatedAt: Long, val sizeBytes: Long, val isPlaceholder: Boolean)

data class ExternalServerRow(val id: String, val name: String, val url: String)

fun parseDashboardSnapshot(raw: String): DashboardSnapshot {
    val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
        ?: return DashboardSnapshot(0L, null, emptyList(), emptyList(), emptyList())

    val hub = (obj["hub"] as? JsonObject)?.let {
        HubStatus(
            uptimeMs = it["uptimeMs"]?.jsonPrimitive?.longOrNull ?: 0L,
            sessions = it["sessions"]?.jsonPrimitive?.intOrNull ?: 0,
        )
    }
    val tailscale = (obj["tailscale"] as? JsonArray)?.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        val hostname = o["hostname"]?.jsonPrimitive?.content ?: return@mapNotNull null
        TsPeer(
            hostname = hostname,
            dnsName = o["dnsName"]?.jsonPrimitive?.content ?: "",
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
            uptimeMs = o["uptimeMs"]?.jsonPrimitive?.longOrNull ?: 0L,
            restartCount = o["restartCount"]?.jsonPrimitive?.intOrNull ?: 0,
            memoryBytes = o["memoryBytes"]?.jsonPrimitive?.longOrNull ?: 0L,
            cpuPct = o["cpuPct"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
        )
    } ?: emptyList()
    val external = (obj["external"] as? JsonArray)?.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        val probe = o["probe"] as? JsonObject
        ExternalProbe(
            id = o["id"]?.jsonPrimitive?.content ?: "",
            name = o["name"]?.jsonPrimitive?.content ?: return@mapNotNull null,
            url = o["url"]?.jsonPrimitive?.content ?: "",
            ok = probe?.get("ok")?.jsonPrimitive?.booleanOrNull ?: false,
            latencyMs = probe?.get("latencyMs")?.jsonPrimitive?.longOrNull,
            status = probe?.get("status")?.jsonPrimitive?.intOrNull,
            error = probe?.get("error")?.jsonPrimitive?.content,
        )
    } ?: emptyList()

    return DashboardSnapshot(
        generatedAt = obj["generatedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
        hub = hub, tailscale = tailscale, pm2 = pm2, external = external,
    )
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

fun parseCanvasMeta(raw: String): CanvasMeta? = runCatching {
    val o = json.parseToJsonElement(raw) as? JsonObject ?: return@runCatching null
    CanvasMeta(
        updatedAt = o["updatedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
        sizeBytes = o["sizeBytes"]?.jsonPrimitive?.longOrNull ?: 0L,
        isPlaceholder = o["isPlaceholder"]?.jsonPrimitive?.booleanOrNull ?: true,
    )
}.getOrNull()

fun parseExternalServers(raw: String): List<ExternalServerRow> {
    val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return emptyList()
    val arr = obj["servers"] as? JsonArray ?: return emptyList()
    return arr.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        ExternalServerRow(
            id = o["id"]?.jsonPrimitive?.content ?: return@mapNotNull null,
            name = o["name"]?.jsonPrimitive?.content ?: "",
            url = o["url"]?.jsonPrimitive?.content ?: "",
        )
    }
}

// --- blog drafts + projects (server/src/blog.ts DraftSummary/ProjectSummary) //

data class BlogDraft(val path: String, val title: String, val mtime: Long)
data class BlogProject(
    val slug: String,
    val title: String,
    val path: String,
    val status: String,
    val lastPostMtime: Long?,
)

fun parseBlogDrafts(raw: String): List<BlogDraft> {
    val arr = runCatching { json.parseToJsonElement(raw) as? JsonArray }.getOrNull() ?: return emptyList()
    return arr.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        BlogDraft(
            path = o["path"]?.jsonPrimitive?.content ?: return@mapNotNull null,
            title = o["title"]?.jsonPrimitive?.content ?: "(untitled)",
            mtime = o["mtime"]?.jsonPrimitive?.longOrNull ?: 0L,
        )
    }
}

fun parseBlogProjects(raw: String): List<BlogProject> {
    val arr = runCatching { json.parseToJsonElement(raw) as? JsonArray }.getOrNull() ?: return emptyList()
    return arr.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        BlogProject(
            slug = o["slug"]?.jsonPrimitive?.content ?: return@mapNotNull null,
            title = o["title"]?.jsonPrimitive?.content ?: "",
            path = o["path"]?.jsonPrimitive?.content ?: "",
            status = o["status"]?.jsonPrimitive?.content ?: "active",
            lastPostMtime = o["lastPostMtime"]?.jsonPrimitive?.longOrNull,
        )
    }
}

fun formatUptime(ms: Long): String {
    if (ms <= 0) return "—"
    val s = ms / 1000
    val d = s / 86400
    if (d > 0) return "${d}d"
    val h = s / 3600
    if (h > 0) return "${h}h"
    val m = s / 60
    if (m > 0) return "${m}m"
    return "${s}s"
}

/** Bytes → B/K/M (mirrors ServersCard fmtBytes). */
fun formatBytes(b: Long): String = when {
    b < 1024 -> "${b}B"
    b < 1024 * 1024 -> "${(b / 1024)}K"
    else -> "${(b / (1024 * 1024))}M"
}

/** ms-until → "now"/"Nm"/"Nh Mm" (mirrors AlertsCard fmtMinutes). */
fun formatCountdown(ms: Long): String {
    val m = Math.round(ms / 60000.0)
    if (m < 1) return "now"
    if (m < 60) return "${m}m"
    val h = m / 60
    val rem = m % 60
    return if (rem > 0) "${h}h ${rem}m" else "${h}h"
}

/** ms-ago → "just now"/"Nm ago"/"Nh ago"/"Nd ago" (mirrors AlertsCard fmtAgo). */
fun formatAgo(ms: Long): String {
    val m = Math.round(ms / 60000.0)
    if (m < 1) return "just now"
    if (m < 60) return "${m}m ago"
    val h = m / 60
    if (h < 24) return "${h}h ago"
    return "${h / 24}d ago"
}

/** ms-ago → "empty"/"updated Xs/m/h/d ago" for the canvas header. */
fun formatCanvasAge(ms: Long): String {
    val s = Math.round(ms / 1000.0)
    if (s < 60) return "${s}s ago"
    val m = s / 60
    if (m < 60) return "${m}m ago"
    val h = m / 60
    if (h < 24) return "${h}h ago"
    return "${h / 24}d ago"
}

/** Age of a draft in days → colour bucket (mirrors BlogDraftsCard). */
enum class AgeTint { RED, YELLOW, NORMAL }

fun draftAgeTint(ageDays: Double): AgeTint = when {
    ageDays > 30 -> AgeTint.RED
    ageDays > 7 -> AgeTint.YELLOW
    else -> AgeTint.NORMAL
}

fun projectAgeTint(ageDays: Double?): AgeTint = when {
    ageDays == null -> AgeTint.NORMAL
    ageDays > 90 -> AgeTint.RED
    ageDays > 30 -> AgeTint.YELLOW
    else -> AgeTint.NORMAL
}

/** Draft age string: "just now"/Xh/Xd/Xmo/X.Xy ago. */
fun formatDraftAge(ageDays: Double): String {
    if (ageDays < 1) {
        val h = ageDays * 24
        if (h < 1) return "just now"
        return "${Math.round(h)}h ago"
    }
    if (ageDays < 30) return "${Math.round(ageDays)}d ago"
    if (ageDays < 365) return "${Math.round(ageDays / 30)}mo ago"
    return "%.1fy ago".format(ageDays / 365)
}

/** Project last-post age string: "today"/Xd/Xmo/X.Xy ago (no lastPost → caller). */
fun formatProjectAge(ageDays: Double): String {
    if (ageDays < 1) return "today"
    if (ageDays < 30) return "${Math.round(ageDays)}d ago"
    if (ageDays < 365) return "${Math.round(ageDays / 30)}mo ago"
    return "%.1fy ago".format(ageDays / 365)
}
