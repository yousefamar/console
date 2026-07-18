package io.amar.console.ui.longtail

import android.annotation.SuppressLint
import android.webkit.WebView
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import io.amar.console.core.HubConfig
import io.amar.console.data.longtail.BookmarksRepository
import io.amar.console.data.longtail.HomeRepository
import io.amar.console.data.longtail.MusicRepository
import kotlinx.coroutines.launch
import org.json.JSONObject

// ---------------------------------------------------------------------- //
// Bookmarks — cached listing browse

@Composable
fun BookmarksScreen(repo: BookmarksRepository) {
    val bookmarks by repo.observeAll().collectAsState(initial = emptyList())
    val ctx = androidx.compose.ui.platform.LocalContext.current

    if (bookmarks.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No cached bookmarks — connect once", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(bookmarks, key = { it.file }) { bm ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .clickable {
                        bm.url?.let { url ->
                            runCatching {
                                ctx.startActivity(
                                    android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                                )
                            }
                        }
                    }
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Text(bm.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                bm.url?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

// ---------------------------------------------------------------------- //
// Home — dashboard snapshot + canvas WebView island

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun HomeScreen(repo: HomeRepository) {
    val snapshot by repo.snapshot.collectAsState()
    LaunchedEffect(Unit) { repo.refresh() }

    Column(Modifier.fillMaxSize()) {
        snapshot?.let { snap ->
            val alerts = remember(snap.alertsJson) {
                runCatching {
                    val o = JSONObject(snap.alertsJson)
                    val approvals = o.optJSONArray("pendingApprovals")?.length() ?: 0
                    val upcoming = o.optJSONArray("upcomingEvents")?.length() ?: 0
                    approvals to upcoming
                }.getOrDefault(0 to 0)
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text("Approvals: ${alerts.first}", style = MaterialTheme.typography.labelMedium)
                Text("Upcoming: ${alerts.second}", style = MaterialTheme.typography.labelMedium)
            }
        }
        // Canvas island: the ONE place agent-authored HTML renders — a
        // sandboxed WebView loading the hub's canvas page. Online-only.
        AndroidView(
            modifier = Modifier.fillMaxSize(),
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

// ---------------------------------------------------------------------- //
// Music — Spotify remote (online-only)

@Composable
fun MusicScreen(repo: MusicRepository) {
    val state by repo.state.collectAsState()
    val scope = rememberCoroutineScope()
    var volume by remember { mutableStateOf<Float?>(null) }

    LaunchedEffect(Unit) {
        while (true) {
            repo.refresh()
            kotlinx.coroutines.delay(5000)
        }
    }

    val np = state
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (np == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Music remote needs the hub", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            return
        }
        Text(np.track, style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(np.artist, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        np.device?.let {
            Text("on $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (np.durationMs > 0) {
            LinearProgressIndicator(
                progress = { (np.progressMs.toFloat() / np.durationMs).coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth().height(3.dp),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
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
