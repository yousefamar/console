package io.amar.console.ui.longtail

import android.annotation.SuppressLint
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import io.amar.console.core.HubConfig
import io.amar.console.data.longtail.AgeTint
import io.amar.console.data.longtail.BlogDraft
import io.amar.console.data.longtail.BlogProject
import io.amar.console.data.longtail.DashboardAlert
import io.amar.console.data.longtail.DashboardSnapshot
import io.amar.console.data.longtail.HomeRepository
import io.amar.console.data.longtail.draftAgeTint
import io.amar.console.data.longtail.formatAgo
import io.amar.console.data.longtail.formatBytes
import io.amar.console.data.longtail.formatCanvasAge
import io.amar.console.data.longtail.formatCountdown
import io.amar.console.data.longtail.formatDraftAge
import io.amar.console.data.longtail.formatProjectAge
import io.amar.console.data.longtail.formatUptime
import io.amar.console.data.longtail.projectAgeTint
import kotlinx.coroutines.launch

private const val SNAPSHOT_INTERVAL_MS = 30_000L
private const val ALERTS_INTERVAL_MS = 15_000L

private enum class HomeSubTab(val label: String) { ALERTS("Alerts"), SERVERS("Servers"), BLOG("Blog"), CANVAS("Canvas") }

/**
 * Home dashboard: a sub-tab bar (Alerts | Servers | Blog | Canvas) showing one
 * full-viewport section — mirrors the SPA's mobile HomeTab layout, avoiding
 * scroll-fighting with the sandboxed canvas WebView. Snapshot polls at 30s,
 * alerts at 15s (independent, matching the spec).
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun HomeScreen(
    repo: HomeRepository,
    onOpenAgentSession: (String) -> Unit = {},
    onOpenNote: (String) -> Unit = {},
    onGrid: () -> Unit = {},
) {
    val state by repo.state.collectAsState()
    val scope = rememberCoroutineScope()
    var subTab by remember { mutableStateOf(HomeSubTab.ALERTS) }

    LaunchedEffect(Unit) {
        repo.refreshSnapshot(); repo.refreshAlerts(); repo.refreshCanvasMeta()
        repo.refreshDrafts(); repo.refreshProjects()
    }
    // Snapshot loop (30s).
    LaunchedEffect(Unit) {
        while (true) { kotlinx.coroutines.delay(SNAPSHOT_INTERVAL_MS); repo.refreshSnapshot() }
    }
    // Alerts loop (15s) — independent cadence.
    LaunchedEffect(Unit) {
        while (true) { kotlinx.coroutines.delay(ALERTS_INTERVAL_MS); repo.refreshAlerts() }
    }

    Column(Modifier.fillMaxSize()) {
        // Sub-tab bar with grid button and a live alert-count badge.
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onGrid) { Icon(Icons.Filled.Apps, "App grid", modifier = Modifier.size(20.dp)) }
            TabRow(selectedTabIndex = subTab.ordinal, modifier = Modifier.weight(1f)) {
                for (t in HomeSubTab.entries) {
                    Tab(selected = subTab == t, onClick = { subTab = t }, text = {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(t.label, style = MaterialTheme.typography.labelMedium)
                            if (t == HomeSubTab.ALERTS && state.alerts.isNotEmpty()) CountBadge(state.alerts.size)
                        }
                    })
                }
            }
        }

        when (subTab) {
            HomeSubTab.ALERTS -> AlertsSection(state.alerts, state.alertsLoading, onOpenAgentSession)
            HomeSubTab.SERVERS -> ServersSection(
                snapshot = state.snapshot,
                loading = state.snapshotLoading,
                error = state.snapshotError,
                onRefresh = { scope.launch { repo.refreshSnapshot() } },
                onAdd = { name, url -> scope.launch { repo.addServer(name, url) } },
                onRemove = { id -> scope.launch { repo.removeServer(id) } },
            )
            HomeSubTab.BLOG -> BlogSection(
                drafts = state.drafts, draftsLoading = state.draftsLoading,
                projects = state.projects, projectsLoading = state.projectsLoading,
                onOpenNote = onOpenNote,
                onNewDraft = { title -> scope.launch { repo.createDraft(title) } },
                onNewProject = { title -> scope.launch { repo.createProject(title) } },
                onNewProjectPost = { slug, title -> scope.launch { repo.createDraft(title, slug) } },
            )
            HomeSubTab.CANVAS -> CanvasSection(repo)
        }
    }
}

@Composable
private fun CountBadge(count: Int) {
    Box(
        Modifier.clip(RoundedCornerShape(50)).background(Color(0xFF3B82F6)).padding(horizontal = 6.dp, vertical = 1.dp),
    ) { Text("$count", style = MaterialTheme.typography.labelSmall, color = Color.White) }
}

@Composable
private fun StatusDot(ok: Boolean) {
    Box(Modifier.size(8.dp).clip(CircleShape).background(if (ok) Color(0xFF4ADE80) else Color(0xFFF87171)))
}

@Composable
private fun SectionCard(title: String, count: Int?, headerActions: @Composable () -> Unit = {}, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
                if (count != null) Text("$count", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row(verticalAlignment = Alignment.CenterVertically) { headerActions() }
        }
        content()
    }
}

// ---------------------------------------------------------------------- //
// Alerts

@Composable
private fun AlertsSection(alerts: List<DashboardAlert>, loading: Boolean, onOpenAgentSession: (String) -> Unit) {
    val ctx = LocalContext.current
    SectionCard("Alerts", alerts.size) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            if (alerts.isEmpty()) {
                Text(
                    if (loading) "Loading…" else "Nothing pressing.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(12.dp),
                )
            }
            for (alert in alerts) {
                when (alert) {
                    is DashboardAlert.Approval -> AlertRow(
                        glyph = "🛡", glyphColor = Color(0xFFFBBF24),
                        title = if (alert.toolName == "AskUserQuestion") "Agent needs your input" else "Agent needs approval",
                        subtitle = "${alert.sessionName ?: alert.sessionId.take(12)} · ${alert.question ?: alert.toolName}",
                        onClick = { onOpenAgentSession(alert.sessionId) },
                    )
                    is DashboardAlert.Upcoming -> AlertRow(
                        glyph = "🕐", glyphColor = Color(0xFF60A5FA),
                        title = alert.summary,
                        subtitle = "in ${formatCountdown(alert.startMs - System.currentTimeMillis())}",
                        // Tap → open Calendar pane via deep link (no direct nav handle here).
                        onClick = { openPane(ctx, "calendar") },
                    )
                    is DashboardAlert.Err -> AlertRow(
                        glyph = "⚠", glyphColor = Color(0xFFF87171),
                        title = alert.message,
                        subtitle = "${alert.source} · ${formatAgo(System.currentTimeMillis() - alert.ts)}",
                        onClick = null,
                    )
                }
            }
        }
    }
}

@Composable
private fun AlertRow(glyph: String, glyphColor: Color, title: String, subtitle: String, onClick: (() -> Unit)?) {
    val base = Modifier.fillMaxWidth()
    Row(
        (if (onClick != null) base.clickable { onClick() } else base).padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(glyph, style = MaterialTheme.typography.bodyMedium, color = glyphColor)
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

// ---------------------------------------------------------------------- //
// Servers

@Composable
private fun ServersSection(
    snapshot: DashboardSnapshot?,
    loading: Boolean,
    error: String?,
    onRefresh: () -> Unit,
    onAdd: (String, String) -> Unit,
    onRemove: (String) -> Unit,
) {
    var adding by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    val timeStr = snapshot?.generatedAt?.takeIf { it > 0 }?.let {
        java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneId.systemDefault())
            .format(java.time.format.DateTimeFormatter.ofPattern("HH:mm:ss"))
    }

    SectionCard("Servers", null, headerActions = {
        timeStr?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = 6.dp)) }
        IconButton(onClick = onRefresh, modifier = Modifier.size(28.dp)) { Icon(Icons.Filled.Refresh, "Refresh", modifier = Modifier.size(16.dp)) }
        IconButton(onClick = { adding = !adding }, modifier = Modifier.size(28.dp)) { Icon(Icons.Filled.Add, "Add external server", modifier = Modifier.size(16.dp)) }
    }) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            if (adding) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
                    OutlinedTextField(value = name, onValueChange = { name = it }, placeholder = { Text("name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = url, onValueChange = { url = it }, placeholder = { Text("https://…") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
                    TextButton(onClick = {
                        if (name.isNotBlank() && url.isNotBlank()) { onAdd(name, url); name = ""; url = ""; adding = false }
                    }) { Text("Add") }
                }
            }
            when {
                snapshot == null && loading -> Text("Loading…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(12.dp))
                snapshot == null && error != null -> Text(error, style = MaterialTheme.typography.bodySmall, color = Color(0xFFF87171), modifier = Modifier.padding(12.dp))
                snapshot != null -> ServerRows(snapshot, onRemove)
            }
        }
    }
}

@Composable
private fun ServerRows(snap: DashboardSnapshot, onRemove: (String) -> Unit) {
    snap.hub?.let { hub ->
        ServerRow(true, "hub", "${hub.sessions} session${if (hub.sessions == 1) "" else "s"}", formatUptime(hub.uptimeMs), null)
    }
    for (h in snap.tailscale) {
        ServerRow(h.online, h.hostname, listOf(if (h.self) "self" else "tailscale", h.os).filterNotNull().joinToString(" · "), if (h.online) "online" else "offline", null)
    }
    for (p in snap.pm2) {
        ServerRow(p.status == "online", p.name, "pm2 · ${formatBytes(p.memoryBytes)} · ${p.restartCount}↻", if (p.status == "online") formatUptime(p.uptimeMs) else p.status, null)
    }
    for (e in snap.external) {
        ServerRow(e.ok, e.name, e.url, if (e.ok) (e.latencyMs?.let { "${it}ms" } ?: "ok") else (e.error ?: "error"), { onRemove(e.id) })
    }
}

@Composable
private fun ServerRow(ok: Boolean, label: String, sublabel: String, right: String?, onRemove: (() -> Unit)?) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        StatusDot(ok)
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (sublabel.isNotBlank()) Text(sublabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        right?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (onRemove != null) {
            IconButton(onClick = onRemove, modifier = Modifier.size(24.dp)) {
                Icon(Icons.Filled.Delete, "Remove", modifier = Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

// ---------------------------------------------------------------------- //
// Blog (drafts + projects)

@Composable
private fun BlogSection(
    drafts: List<BlogDraft>,
    draftsLoading: Boolean,
    projects: List<BlogProject>,
    projectsLoading: Boolean,
    onOpenNote: (String) -> Unit,
    onNewDraft: (String) -> Unit,
    onNewProject: (String) -> Unit,
    onNewProjectPost: (String, String) -> Unit,
) {
    var prompt by remember { mutableStateOf<PromptSpec?>(null) }
    val active = projects.filter { it.status == "active" }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        // Drafts
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Drafts", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
                Text("${drafts.size}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = { prompt = PromptSpec("New blog draft", "e.g. Why I switched to vim") { onNewDraft(it) } }, modifier = Modifier.size(28.dp)) {
                Icon(Icons.Filled.Add, "New draft", modifier = Modifier.size(16.dp))
            }
        }
        if (drafts.isEmpty()) {
            Text(if (draftsLoading) "Loading…" else "No drafts. Write something.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
        }
        for (d in drafts) {
            val ageDays = (System.currentTimeMillis() - d.mtime) / 86400000.0
            Row(Modifier.fillMaxWidth().clickable { onOpenNote(d.path) }.padding(horizontal = 12.dp, vertical = 6.dp)) {
                Column {
                    Text(d.title, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(formatDraftAge(ageDays), style = MaterialTheme.typography.labelSmall, color = tintColor(draftAgeTint(ageDays)))
                }
            }
        }

        // Projects
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Active projects", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
                Text("${active.size}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = { prompt = PromptSpec("New project", "e.g. Cura") { onNewProject(it) } }, modifier = Modifier.size(28.dp)) {
                Icon(Icons.Filled.Add, "New project", modifier = Modifier.size(16.dp))
            }
        }
        if (active.isEmpty()) {
            Text(if (projectsLoading) "Loading…" else "No active projects.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
        }
        for (p in active) {
            val ageDays = p.lastPostMtime?.let { (System.currentTimeMillis() - it) / 86400000.0 }
            Row(Modifier.fillMaxWidth().clickable { onOpenNote(p.path) }.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(p.title, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        if (ageDays == null) "no posts yet" else "last post ${formatProjectAge(ageDays)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = tintColor(projectAgeTint(ageDays)),
                    )
                }
                IconButton(onClick = { prompt = PromptSpec("New post — ${p.title}", "Title for the post about ${p.title}") { onNewProjectPost(p.slug, it) } }, modifier = Modifier.size(24.dp)) {
                    Icon(Icons.Filled.Add, "New post about ${p.title}", modifier = Modifier.size(15.dp))
                }
            }
        }
    }

    prompt?.let { spec ->
        var text by remember(spec) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { prompt = null },
            title = { Text(spec.title) },
            text = { OutlinedTextField(value = text, onValueChange = { text = it }, placeholder = { Text(spec.placeholder) }, singleLine = true, modifier = Modifier.fillMaxWidth()) },
            confirmButton = { TextButton(onClick = { if (text.isNotBlank()) { spec.onConfirm(text.trim()) }; prompt = null }) { Text("Create") } },
            dismissButton = { TextButton(onClick = { prompt = null }) { Text("Cancel") } },
        )
    }
}

private data class PromptSpec(val title: String, val placeholder: String, val onConfirm: (String) -> Unit)

@Composable
private fun tintColor(tint: AgeTint): Color = when (tint) {
    AgeTint.RED -> Color(0xFFF87171)
    AgeTint.YELLOW -> Color(0xFFFBBF24)
    AgeTint.NORMAL -> MaterialTheme.colorScheme.onSurfaceVariant
}

// ---------------------------------------------------------------------- //
// Canvas (sandboxed WebView + header status/actions)

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun CanvasSection(repo: HomeRepository) {
    val state by repo.state.collectAsState()
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var maximized by remember { mutableStateOf(false) }
    var confirmClear by remember { mutableStateOf(false) }
    var showShare by remember { mutableStateOf(false) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    val canvasUrl = "${HubConfig.publicOrigin}/hub/canvas/index.html"

    // Live reload when the hub broadcasts canvas_changed (reloadKey bumps).
    LaunchedEffect(state.canvasReloadKey) {
        if (state.canvasReloadKey > 0) webView?.reload()
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Agent canvas", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
                val meta = state.canvasMeta
                Text(
                    if (meta == null) "" else if (meta.isPlaceholder) "empty" else "updated ${formatCanvasAge(System.currentTimeMillis() - meta.updatedAt)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { showShare = true }, modifier = Modifier.size(28.dp)) { Icon(Icons.Filled.Share, "Share", modifier = Modifier.size(15.dp)) }
                IconButton(onClick = { openUrl(ctx, canvasUrl) }, modifier = Modifier.size(28.dp)) { Icon(Icons.AutoMirrored.Filled.OpenInNew, "Open in browser", modifier = Modifier.size(15.dp)) }
                IconButton(onClick = { maximized = !maximized }, modifier = Modifier.size(28.dp)) {
                    Icon(if (maximized) Icons.Filled.FullscreenExit else Icons.Filled.Fullscreen, if (maximized) "Restore" else "Maximize", modifier = Modifier.size(15.dp))
                }
                IconButton(onClick = { confirmClear = true }, enabled = state.canvasMeta?.isPlaceholder != true, modifier = Modifier.size(28.dp)) {
                    Icon(Icons.Filled.Delete, "Clear canvas", modifier = Modifier.size(15.dp), tint = MaterialTheme.colorScheme.error)
                }
            }
        }
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { c ->
                WebView(c).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = false
                    settings.allowFileAccess = false
                    setBackgroundColor(android.graphics.Color.parseColor("#0a0a0a"))
                    loadUrl(canvasUrl)
                    webView = this
                }
            },
        )
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("Clear the canvas?") },
            text = { Text("Wipes the canvas back to the placeholder.") },
            confirmButton = { TextButton(onClick = { confirmClear = false; scope.launch { repo.clearCanvas() } }) { Text("Clear", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancel") } },
        )
    }
    if (showShare) CanvasShareMenu(onClose = { showShare = false })
}

// ---------------------------------------------------------------------- //
// helpers

private fun openUrl(ctx: android.content.Context, url: String) {
    runCatching { ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) }
}

/** Fall back to a deep-link intent to switch panes (no direct nav handle in
 *  the Home composable — MainActivity routes console://pane/<name>). */
private fun openPane(ctx: android.content.Context, pane: String) {
    runCatching {
        ctx.startActivity(
            android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("console://pane/$pane"))
                .setPackage(ctx.packageName),
        )
    }
}
