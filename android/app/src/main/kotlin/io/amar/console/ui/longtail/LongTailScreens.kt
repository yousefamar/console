package io.amar.console.ui.longtail

import android.annotation.SuppressLint
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOne
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.outlined.Bookmarks
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import coil.compose.AsyncImage
import io.amar.console.core.HubConfig
import io.amar.console.data.db.BookmarkRow
import io.amar.console.data.longtail.BookmarksRepository
import io.amar.console.data.longtail.DashboardAlert
import io.amar.console.data.longtail.HomeRepository
import io.amar.console.data.longtail.MusicRepository
import io.amar.console.data.longtail.formatUptime
import io.amar.console.data.longtail.parseDashboardAlerts
import io.amar.console.data.longtail.parseDashboardSnapshot
import io.amar.console.data.longtail.parseTagsJson
import io.amar.console.data.longtail.repeatAllowed
import io.amar.console.data.longtail.seekAllowed
import io.amar.console.data.longtail.shuffleAllowed
import io.amar.console.ui.agents.MarkdownLite
import io.amar.console.ui.components.EmptyState
import io.amar.console.ui.components.PaneTopBar
import kotlinx.coroutines.launch

// ---------------------------------------------------------------------- //
// Bookmarks — cached listing browse + tag filter + search + detail sheet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BookmarksScreen(repo: BookmarksRepository, onGrid: () -> Unit = {}) {
    val bookmarks by repo.observeAll().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()

    var selectedTag by rememberSaveable { mutableStateOf<String?>(null) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    var searching by rememberSaveable { mutableStateOf(false) }
    var detail by remember { mutableStateOf<BookmarkRow?>(null) }

    val tagsByFile = remember(bookmarks) { bookmarks.associate { it.file to parseTagsJson(it.tagsJson) } }
    val allTags = remember(tagsByFile) {
        tagsByFile.values.flatten().groupingBy { it }.eachCount()
            .entries.sortedByDescending { it.value }.map { it.key }
    }

    val visible = remember(bookmarks, selectedTag, searchQuery, tagsByFile) {
        val q = searchQuery.trim()
        bookmarks.filter { bm ->
            (selectedTag == null || selectedTag in (tagsByFile[bm.file] ?: emptyList())) &&
                (q.length < 2 ||
                    bm.title.contains(q, ignoreCase = true) ||
                    bm.url?.contains(q, ignoreCase = true) == true ||
                    bm.tagsJson?.contains(q, ignoreCase = true) == true)
        }
    }

    Column(Modifier.fillMaxSize()) {
        PaneTopBar(
            title = "Bookmarks",
            subtitle = "${bookmarks.size} cached",
            actions = {
                IconButton(onClick = { searching = !searching; searchQuery = "" }) {
                    Icon(
                        if (searching) Icons.Filled.Close else Icons.Filled.Search,
                        contentDescription = "Search bookmarks",
                        modifier = Modifier.size(20.dp),
                    )
                }
            },
        )
        if (searching) {
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                placeholder = { Text("Title / URL / tags") },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                singleLine = true,
            )
        }
        if (allTags.isNotEmpty()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 12.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                FilterChip(
                    selected = selectedTag == null,
                    onClick = { selectedTag = null },
                    label = { Text("All") },
                )
                for (tag in allTags.take(30)) {
                    FilterChip(
                        selected = selectedTag == tag,
                        onClick = { selectedTag = if (selectedTag == tag) null else tag },
                        label = { Text(tag) },
                    )
                }
            }
        }
        if (visible.isEmpty()) {
            EmptyState(Icons.Outlined.Bookmarks, "No bookmarks", "connect once to cache the vault listing")
            return
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(visible, key = { it.file }) { bm ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clickable { detail = bm }
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    Text(
                        bm.title,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    bm.url?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    val tags = tagsByFile[bm.file] ?: emptyList()
                    if (tags.isNotEmpty()) {
                        Text(
                            tags.joinToString("  ") { "#$it" },
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.tertiary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }

    detail?.let { bm ->
        BookmarkDetailSheet(
            repo = repo,
            bookmark = bm,
            tags = tagsByFile[bm.file] ?: emptyList(),
            onDismiss = { detail = null },
            onDelete = {
                detail = null
                scope.launch { repo.delete(bm.file) }
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BookmarkDetailSheet(
    repo: BookmarksRepository,
    bookmark: BookmarkRow,
    tags: List<String>,
    onDismiss: () -> Unit,
    onDelete: () -> Unit,
) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var detail by remember { mutableStateOf<BookmarksRepository.Detail?>(null) }
    var bodyLoading by remember { mutableStateOf(true) }
    var confirmDelete by remember { mutableStateOf(false) }

    LaunchedEffect(bookmark.file) {
        detail = repo.fetchDetail(bookmark.file)
        bodyLoading = false
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = 560.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(bookmark.title, style = MaterialTheme.typography.titleMedium)
            bookmark.url?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (tags.isNotEmpty()) {
                Text(
                    tags.joinToString("  ") { "#$it" },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.tertiary,
                )
            }
            detail?.description?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium)
            }
            when {
                bodyLoading -> Text(
                    "Loading…",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                detail?.body != null -> MarkdownLite(detail!!.body!!)
                detail == null -> Text(
                    "Body unavailable offline",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = {
                    bookmark.url?.let { url ->
                        runCatching {
                            ctx.startActivity(
                                android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                            )
                        }
                    }
                }, enabled = bookmark.url != null) {
                    Icon(Icons.AutoMirrored.Filled.OpenInNew, null, modifier = Modifier.size(16.dp))
                    Text("  Open in browser")
                }
                TextButton(onClick = { confirmDelete = true }) {
                    Icon(Icons.Filled.Delete, null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.error)
                    Text("  Delete", color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete bookmark?") },
            text = { Text(bookmark.title) },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; onDelete() }) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

// ---------------------------------------------------------------------- //
// Home — real servers + alerts cards from /dashboard, canvas WebView below

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun HomeScreen(repo: HomeRepository, onOpenAgentSession: (String) -> Unit = {}, onGrid: () -> Unit = {}) {
    val snapshot by repo.snapshot.collectAsState()

    // Auto-refresh every 30s while the pane is visible (LaunchedEffect dies
    // with composition, so leaving Home stops the loop).
    LaunchedEffect(Unit) {
        while (true) {
            repo.refresh()
            kotlinx.coroutines.delay(30_000)
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        snapshot?.let { snap ->
            val servers = remember(snap.serversJson) { parseDashboardSnapshot(snap.serversJson) }
            val alerts = remember(snap.alertsJson) { parseDashboardAlerts(snap.alertsJson) }

            AlertsCard(alerts, onOpenAgentSession)
            ServersCard(servers)
        } ?: Text(
            "Loading dashboard…",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(12.dp),
        )
        // Canvas island: the ONE place agent-authored HTML renders — a
        // sandboxed WebView loading the hub's canvas page. Online-only.
        AndroidView(
            modifier = Modifier.fillMaxWidth().height(420.dp),
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true // canvas content relies on JS
                    settings.domStorageEnabled = false
                    settings.allowFileAccess = false
                    setBackgroundColor(android.graphics.Color.parseColor("#0a0a0a"))
                    loadUrl("${HubConfig.hubBase.removeSuffix("/hub")}/hub/canvas/index.html")
                }
            },
        )
    }
}

@Composable
private fun StatusDot(ok: Boolean) {
    Box(
        Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(if (ok) Color(0xFF4ADE80) else Color(0xFFF87171)),
    )
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 8.dp, bottom = 2.dp),
    )
}

@Composable
private fun ServersCard(snap: io.amar.console.data.longtail.DashboardSnapshot) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("Servers", style = MaterialTheme.typography.titleSmall)
        snap.hub?.let { hub ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusDot(true)
                Text("Hub", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                Text(
                    "up ${formatUptime(hub.uptimeMs)} · ${hub.sessions} sessions",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (snap.tailscale.isNotEmpty()) {
            SectionHeader("Tailscale")
            for (peer in snap.tailscale) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusDot(peer.online)
                    Text(
                        peer.hostname + (if (peer.self) " (this hub)" else ""),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    peer.os?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        if (snap.pm2.isNotEmpty()) {
            SectionHeader("PM2")
            for (proc in snap.pm2) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusDot(proc.status == "online")
                    Text(proc.name, style = MaterialTheme.typography.bodySmall)
                    Text(
                        "${proc.status} · ${proc.memoryMb} MB",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        if (snap.external.isNotEmpty()) {
            SectionHeader("External")
            for (ext in snap.external) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusDot(ext.ok)
                    Text(ext.name, style = MaterialTheme.typography.bodySmall)
                    Text(
                        ext.latencyMs?.let { "${it}ms" } ?: ext.error ?: "",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun AlertsCard(alerts: List<DashboardAlert>, onOpenAgentSession: (String) -> Unit) {
    if (alerts.isEmpty()) return
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("Alerts", style = MaterialTheme.typography.titleSmall)
        for (alert in alerts.take(12)) {
            when (alert) {
                is DashboardAlert.Approval -> Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onOpenAgentSession(alert.sessionId) },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("⚠", style = MaterialTheme.typography.bodySmall)
                    Column(Modifier.weight(1f)) {
                        Text(
                            "${alert.sessionName ?: alert.sessionId.take(8)} · ${alert.toolName}",
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.Medium,
                        )
                        alert.question?.let {
                            Text(
                                it,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
                is DashboardAlert.Upcoming -> {
                    val inMin = ((alert.startMs - System.currentTimeMillis()) / 60_000).coerceAtLeast(0)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("📅", style = MaterialTheme.typography.bodySmall)
                        Text(alert.summary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            "in ${inMin}m",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.tertiary,
                        )
                    }
                }
                is DashboardAlert.Err -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("✕", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    Text(
                        alert.message,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

// ---------------------------------------------------------------------- //
// Music — Spotify remote (online-only)

@Composable
fun MusicScreen(repo: MusicRepository, onGrid: () -> Unit = {}) {
    val state by repo.state.collectAsState()
    val scope = rememberCoroutineScope()
    var volume by remember { mutableStateOf<Float?>(null) }
    var seeking by remember { mutableStateOf<Float?>(null) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    var searching by rememberSaveable { mutableStateOf(false) }
    var searchResults by remember { mutableStateOf<List<MusicRepository.SearchTrack>>(emptyList()) }

    LaunchedEffect(Unit) {
        while (true) {
            repo.refresh()
            kotlinx.coroutines.delay(5000)
        }
    }
    LaunchedEffect(searchQuery) {
        kotlinx.coroutines.delay(350) // debounce
        searchResults = if (searchQuery.length >= 2) repo.search(searchQuery) else emptyList()
    }

    val np = state
    if (np == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Music remote needs the hub", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            IconButton(onClick = { searching = !searching; searchQuery = "" }) {
                Icon(
                    if (searching) Icons.Filled.Close else Icons.Filled.Search,
                    contentDescription = "Search tracks",
                    modifier = Modifier.size(20.dp),
                )
            }
        }
        if (searching) {
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                placeholder = { Text("Search Spotify") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            for (track in searchResults) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable {
                            searching = false
                            scope.launch { repo.playUri(track.uri) }
                        }
                        .padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (track.albumArt != null) {
                        AsyncImage(
                            model = track.albumArt,
                            contentDescription = null,
                            modifier = Modifier.size(40.dp).clip(RoundedCornerShape(4.dp)),
                        )
                    }
                    Column(Modifier.weight(1f)) {
                        Text(track.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            track.artists,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Icon(Icons.Filled.PlayArrow, "Play", modifier = Modifier.size(20.dp))
                }
            }
            if (searchResults.isNotEmpty()) return
        }

        if (np.albumArt != null) {
            AsyncImage(
                model = np.albumArt,
                contentDescription = null,
                modifier = Modifier.size(220.dp).clip(RoundedCornerShape(12.dp)),
            )
        }
        Text(np.track, style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(np.artist, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            IconButton(onClick = { scope.launch { repo.toggleLike() } }, enabled = np.trackId != null) {
                Icon(
                    if (np.liked == true) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,
                    contentDescription = if (np.liked == true) "Unlike" else "Like",
                    modifier = Modifier.size(20.dp),
                    tint = if (np.liked == true) Color(0xFFF87171) else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        np.device?.let {
            Text("on $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        if (np.durationMs > 0) {
            // Interpolate progress between polls while playing.
            val liveProgress = if (np.isPlaying) {
                (np.progressMs + (System.currentTimeMillis() - np.fetchedAt)).coerceAtMost(np.durationMs)
            } else np.progressMs
            Slider(
                value = seeking ?: (liveProgress.toFloat() / np.durationMs).coerceIn(0f, 1f),
                onValueChange = { seeking = it },
                onValueChangeFinished = {
                    val fraction = seeking ?: return@Slider
                    scope.launch { repo.seek((fraction * np.durationMs).toLong()) }
                    seeking = null
                },
                enabled = seekAllowed(np.disallows),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(formatMs(seeking?.let { (it * np.durationMs).toLong() } ?: liveProgress), style = MaterialTheme.typography.labelSmall)
                Text(formatMs(np.durationMs), style = MaterialTheme.typography.labelSmall)
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(
                onClick = { scope.launch { repo.setShuffle(!np.shuffle) } },
                enabled = shuffleAllowed(np.disallows),
            ) {
                Icon(
                    Icons.Filled.Shuffle, "Shuffle",
                    modifier = Modifier.size(22.dp),
                    tint = if (np.shuffle) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = { scope.launch { repo.prev() } }) {
                Icon(Icons.Filled.SkipPrevious, "Previous", modifier = Modifier.size(32.dp))
            }
            IconButton(onClick = { scope.launch { repo.toggle() } }) {
                Icon(
                    if (np.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    if (np.isPlaying) "Pause" else "Play",
                    modifier = Modifier.size(48.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
            IconButton(onClick = { scope.launch { repo.next() } }) {
                Icon(Icons.Filled.SkipNext, "Next", modifier = Modifier.size(32.dp))
            }
            IconButton(
                onClick = { scope.launch { repo.cycleRepeat() } },
                enabled = repeatAllowed(np.disallows),
            ) {
                Icon(
                    if (np.repeat == "track") Icons.Filled.RepeatOne else Icons.Filled.Repeat,
                    "Repeat: ${np.repeat}",
                    modifier = Modifier.size(22.dp),
                    tint = if (np.repeat != "off") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        np.volumePercent?.let { pct ->
            Slider(
                value = volume ?: (pct / 100f),
                onValueChange = { volume = it },
                onValueChangeFinished = {
                    val v = ((volume ?: return@Slider) * 100).toInt()
                    scope.launch { repo.volume(v) }
                    volume = null
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

private fun formatMs(ms: Long): String {
    val totalSec = ms / 1000
    return "%d:%02d".format(totalSec / 60, totalSec % 60)
}
