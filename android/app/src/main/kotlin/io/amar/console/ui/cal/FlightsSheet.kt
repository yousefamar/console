package io.amar.console.ui.cal

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.cal.FlightsRepository
import kotlinx.coroutines.launch

/** Full-screen mobile flights watchlist sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FlightsSheet(
    repo: FlightsRepository,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val watchlists by repo.watchlists.collectAsState()
    val configured by repo.configured.collectAsState()
    val running by repo.running.collectAsState()
    var expandedId by remember { mutableStateOf<String?>(null) }
    var showAddForm by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { repo.init(); repo.refresh(); repo.checkConfigured() }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp).verticalScroll(rememberScrollState())) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Flight watchlists", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                IconButton(onClick = { showAddForm = !showAddForm }) {
                    Icon(Icons.Filled.Add, "New watchlist")
                }
            }

            if (configured == false) {
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(Icons.Filled.Warning, null, Modifier.size(16.dp), tint = Color(0xFFF59E0B))
                    Text(
                        "SerpApi key not set. Run con cal flights credentials --key …",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            if (showAddForm) {
                FlightAddForm(
                    onCancel = { showAddForm = false },
                    onCreate = { body -> scope.launch { repo.create(body); showAddForm = false } },
                )
                HorizontalDivider(Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.surfaceVariant)
            }

            if (watchlists.isEmpty() && !showAddForm) {
                Text("No watchlists yet", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
            }

            for (wl in watchlists) {
                WatchlistRow(
                    wl = wl,
                    expanded = expandedId == wl.id,
                    running = wl.id in running,
                    onToggle = { expandedId = if (expandedId == wl.id) null else wl.id },
                    onRun = { scope.launch { repo.runOne(wl.id) } },
                    onRemove = { scope.launch { repo.remove(wl.id); if (expandedId == wl.id) expandedId = null } },
                )
            }
        }
    }
}

@Composable
private fun WatchlistRow(
    wl: FlightsRepository.Watchlist,
    expanded: Boolean,
    running: Boolean,
    onToggle: () -> Unit,
    onRun: () -> Unit,
    onRemove: () -> Unit,
) {
    val context = LocalContext.current
    val price = wl.lastPriceMajor
    val delta = FlightsFormat.priceDelta(wl)
    val underThreshold = price != null && wl.maxPriceMajor != null && price <= wl.maxPriceMajor!!

    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).clickable(onClick = onToggle), verticalAlignment = Alignment.CenterVertically) {
                Icon(if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(4.dp))
                Text(wl.label ?: FlightsFormat.describe(wl), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (price != null) {
                    Text(
                        FlightsFormat.formatPrice(price, wl.currency),
                        style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace,
                        color = if (underThreshold) Color(0xFF10B981) else MaterialTheme.colorScheme.onSurface,
                    )
                }
                if (delta != null && delta != 0.0) {
                    Spacer(Modifier.width(4.dp))
                    Text(
                        FlightsFormat.deltaLabel(delta),
                        style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace,
                        color = if (delta < 0) Color(0xFF10B981) else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            IconButton(onClick = onRun, enabled = !running, modifier = Modifier.size(32.dp)) {
                if (running) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                else Icon(Icons.Filled.Refresh, "Poll now", Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = onRemove, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Filled.Delete, "Remove", Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (expanded) {
            Column(Modifier.padding(start = 20.dp, bottom = 4.dp)) {
                if (!wl.lastError.isNullOrBlank()) {
                    Text(wl.lastError!!, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                } else if (wl.lastResults.isEmpty()) {
                    Text("No results yet — refresh to poll.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                for (r in wl.lastResults.take(20)) {
                    val dep = FlightsFormat.clockTime(r.departureTime)
                    val arr = FlightsFormat.clockTime(r.arrivalTime)
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 1.dp)
                            .then(if (r.link != null) Modifier.clickable { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(r.link))) } } else Modifier),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(r.label, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (dep != null || arr != null) {
                            Text("${dep ?: "?"}→${arr ?: "?"}", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        } else if (r.startDate != null || r.endDate != null) {
                            val window = FlightsFormat.compactDate(r.startDate) + (r.endDate?.let { "–${FlightsFormat.compactDate(it)}" } ?: "")
                            Text(window, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Spacer(Modifier.width(6.dp))
                        Text(FlightsFormat.formatPrice(r.priceMajor, wl.currency), style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace)
                    }
                    val meta = FlightsFormat.resultMeta(r)
                    if (meta.isNotBlank()) {
                        Text(meta, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f))
                    }
                }
                wl.lastCheckedAt?.let {
                    Text("Checked ${FlightsFormat.timeAgo(it, System.currentTimeMillis())}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
                }
            }
        }
    }
}
