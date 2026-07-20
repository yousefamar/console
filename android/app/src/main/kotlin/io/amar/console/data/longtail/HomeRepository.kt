package io.amar.console.data.longtail

import io.amar.console.core.HubClient
import io.amar.console.sync.SyncBusClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Home dashboard state — servers snapshot + alerts (independent poll cadences:
 * snapshot 30s, alerts 15s), canvas meta + a reload counter (bumped by the
 * dashboard SyncBus `canvas_changed` event), and blog drafts/projects. Failures
 * keep the last-known data (as the SPA store does).
 */
class HomeRepository(private val hub: HubClient) {
    data class UiState(
        val snapshot: DashboardSnapshot? = null,
        val snapshotLoading: Boolean = false,
        val snapshotError: String? = null,
        val alerts: List<DashboardAlert> = emptyList(),
        val alertsLoading: Boolean = false,
        val canvasMeta: CanvasMeta? = null,
        val canvasReloadKey: Int = 0,
        val drafts: List<BlogDraft> = emptyList(),
        val draftsLoading: Boolean = false,
        val projects: List<BlogProject> = emptyList(),
        val projectsLoading: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    // --- snapshot / alerts --- //

    suspend fun refreshSnapshot() {
        _state.value = _state.value.copy(snapshotLoading = true, snapshotError = null)
        val raw = runCatching { hub.get("/dashboard/snapshot") }
        raw.fold(
            onSuccess = { _state.value = _state.value.copy(snapshot = parseDashboardSnapshot(it), snapshotLoading = false) },
            onFailure = { _state.value = _state.value.copy(snapshotLoading = false, snapshotError = it.message) },
        )
    }

    suspend fun refreshAlerts() {
        _state.value = _state.value.copy(alertsLoading = true)
        val raw = runCatching { hub.get("/dashboard/alerts") }.getOrNull()
        if (raw != null) {
            _state.value = _state.value.copy(alerts = parseDashboardAlerts(raw), alertsLoading = false)
        } else {
            _state.value = _state.value.copy(alertsLoading = false) // keep last alerts
        }
    }

    // --- canvas --- //

    suspend fun refreshCanvasMeta() {
        val raw = runCatching { hub.get("/canvas/_meta") }.getOrNull() ?: return
        parseCanvasMeta(raw)?.let { _state.value = _state.value.copy(canvasMeta = it) }
    }

    suspend fun clearCanvas() {
        runCatching { hub.delete("/canvas") }
        _state.value = _state.value.copy(canvasReloadKey = _state.value.canvasReloadKey + 1)
        refreshCanvasMeta()
    }

    /** Called by the dashboard SyncBus subscriber on `canvas_changed`. */
    fun onCanvasChanged(meta: CanvasMeta?) {
        _state.value = _state.value.copy(
            canvasReloadKey = _state.value.canvasReloadKey + 1,
            canvasMeta = meta ?: _state.value.canvasMeta,
        )
    }

    /** Wire the dashboard SyncBus `canvas_changed` event → live iframe reload.
     *  Ready for AppGraph to call once at build time. */
    fun wireDashboardBus(syncBus: SyncBusClient) {
        syncBus.on("dashboard", "canvas_changed") { data ->
            onCanvasChanged((data as? JsonObject)?.toString()?.let { parseCanvasMeta(it) })
        }
    }

    // --- external servers --- //

    suspend fun addServer(name: String, url: String) {
        val body = buildJsonObject { put("name", name); put("url", url) }.toString()
        runCatching { hub.post("/dashboard/servers", body) }
        refreshSnapshot()
    }

    suspend fun removeServer(id: String) {
        runCatching { hub.delete("/dashboard/servers/${java.net.URLEncoder.encode(id, "UTF-8")}") }
        refreshSnapshot()
    }

    // --- blog drafts + projects --- //

    suspend fun refreshDrafts() {
        _state.value = _state.value.copy(draftsLoading = true)
        val raw = runCatching { hub.get("/blog/drafts") }.getOrNull()
        _state.value = if (raw != null) {
            _state.value.copy(drafts = parseBlogDrafts(raw), draftsLoading = false)
        } else _state.value.copy(draftsLoading = false)
    }

    suspend fun refreshProjects() {
        _state.value = _state.value.copy(projectsLoading = true)
        val raw = runCatching { hub.get("/blog/projects") }.getOrNull()
        _state.value = if (raw != null) {
            _state.value.copy(projects = parseBlogProjects(raw), projectsLoading = false)
        } else _state.value.copy(projectsLoading = false)
    }

    data class CreateResult(val ok: Boolean, val path: String?, val error: String?)

    /** POST /blog/draft {title, project?} → new draft path (opened in Notes). */
    suspend fun createDraft(title: String, project: String? = null): CreateResult {
        val body = buildJsonObject {
            put("title", title)
            if (project != null) put("project", project)
        }.toString()
        return runCatching {
            val o = Json.parseToJsonElement(hub.post("/blog/draft", body)) as? JsonObject
            CreateResult(
                ok = o?.get("ok")?.jsonPrimitive?.booleanOrNull ?: false,
                path = (o?.get("path") as? JsonPrimitive)?.content,
                error = (o?.get("error") as? JsonPrimitive)?.content,
            )
        }.getOrElse { CreateResult(false, null, it.message) }.also { refreshDrafts() }
    }

    /** POST /blog/project {title} → new project page path (opened in Notes). */
    suspend fun createProject(title: String): CreateResult {
        val body = buildJsonObject { put("title", title) }.toString()
        return runCatching {
            val o = Json.parseToJsonElement(hub.post("/blog/project", body)) as? JsonObject
            CreateResult(
                ok = o?.get("ok")?.jsonPrimitive?.booleanOrNull ?: false,
                path = (o?.get("path") as? JsonPrimitive)?.content,
                error = (o?.get("error") as? JsonPrimitive)?.content,
            )
        }.getOrElse { CreateResult(false, null, it.message) }.also { refreshProjects() }
    }

    /** Pull-to-refresh: everything Home shows, in parallel-ish sequence. */
    suspend fun refreshAll() {
        refreshSnapshot()
        refreshAlerts()
        refreshCanvasMeta()
        refreshDrafts()
        refreshProjects()
    }
}
